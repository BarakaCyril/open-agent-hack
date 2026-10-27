import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { CaseStateSchema, RunResponseSchema, type CriticReason, type RunRequest, type RunResponse } from "../schemas.js";
import { createTracer, runContext, asAgent, traceEvent, currentModelIdentity } from "../tracing.js";
import { analyzeMarket } from "../agents/marketAnalyst.js";
import { analyzeStorage } from "../agents/storageWeatherAnalyst.js";
import { reviewClaims } from "../agents/riskCritic.js";
import { probeZetaris, resolveDataSource, traceCountyCase, ZetarisQueryError, ZetarisUnavailableError } from "../adapters/zetaris.js";
import { claimRevisionSignature, isHardStop } from "../agents/riskCritic.js";
import { assemble, buildNoRecommendation, recallAndGate, rememberOutcome } from "../agents/planner.js";
import { annotateRecheck, loadPrior } from "../agents/watcher.js";
import { createInitialState, latestClaim } from "./state.js";
import { continueAfterCritique } from "./refresh.js";

export const LOOP_LIMITS = { maxRevisions: 2, maxRefreshes: 2, maxRounds: 3 } as const;

export interface LoopBag {
  round: number;
  revisions: number;
  refreshes: number;
}

/** A second pass that keeps the same figures is a caveat, except for a hard stop. */
export function caveatForRepeatedClaim(input: {
  action: "approve" | "reject" | "escalate";
  reasons: readonly CriticReason[];
  previous: string | null;
  next: string;
  notes: readonly string[];
}): { action: "approve" | "reject" | "escalate"; caveat: string | null; signature: string | null } {
  const hard = input.reasons.some((reason) => isHardStop(reason));
  if (input.action === "reject" && !hard && input.previous !== null && input.previous === input.next) {
    const caveat = `Unresolvable: the revised claim kept the same figures. ${input.notes.join(" ")}`.replace(/\s+/g, " ").trim();
    return { action: "approve", caveat, signature: input.previous };
  }
  return {
    action: input.action,
    caveat: null,
    signature: input.action === "reject" && !hard ? input.next : input.previous,
  };
}

export function nextLoopAction(input: {
  round: number;
  revisions: number;
  refreshes: number;
  action: "approve" | "reject" | "escalate";
  reasons: readonly CriticReason[];
}): { effect: "approve" | "revise" | "refresh" | "escalate"; revisions: number; refreshes: number } {
  if (input.action === "approve") {
    return { effect: "approve", revisions: input.revisions, refreshes: input.refreshes };
  }
  if (input.action === "escalate") {
    return { effect: "escalate", revisions: input.revisions, refreshes: input.refreshes };
  }
  const refresh = input.reasons.includes("freshness");
  if (refresh) {
    if (input.refreshes >= LOOP_LIMITS.maxRefreshes || input.round >= LOOP_LIMITS.maxRounds) {
      return { effect: "escalate", revisions: input.revisions, refreshes: input.refreshes };
    }
    return { effect: "refresh", revisions: input.revisions, refreshes: input.refreshes + 1 };
  }
  if (input.revisions >= LOOP_LIMITS.maxRevisions || input.round >= LOOP_LIMITS.maxRounds) {
    return { effect: "escalate", revisions: input.revisions, refreshes: input.refreshes };
  }
  return { effect: "revise", revisions: input.revisions + 1, refreshes: input.refreshes };
}

export async function runBoundedLoop(
  bag: LoopBag,
  handlers: {
    analyze: (round: number) => Promise<void>;
    critique: (round: number) => Promise<{ action: "approve" | "reject" | "escalate"; reasons: CriticReason[] }>;
    onContinue?: (effect: "revise" | "refresh") => Promise<void>;
  },
): Promise<{ approved: boolean; escalated: boolean }> {
  let approved = false;
  let escalated = false;
  for (let round = 1; round <= LOOP_LIMITS.maxRounds; round += 1) {
    bag.round = round;
    await handlers.analyze(round);
    const decision = await handlers.critique(round);
    const next = nextLoopAction({
      round,
      revisions: bag.revisions,
      refreshes: bag.refreshes,
      action: decision.action,
      reasons: decision.reasons,
    });
    bag.revisions = next.revisions;
    bag.refreshes = next.refreshes;
    if (next.effect === "approve") {
      approved = true;
      break;
    }
    if (next.effect === "escalate") {
      escalated = true;
      break;
    }
    await handlers.onContinue?.(next.effect);
  }
  if (!approved && !escalated) escalated = true;
  return { approved, escalated };
}

export async function runCase(request: RunRequest, traceId = randomUUID()): Promise<RunResponse> {
  const config = loadConfig();
  const tracer = createTracer(traceId, config.LOG_DIR, { county: request.county, mode: request.mode });
  try {
  const state = createInitialState(request, traceId);
  const sampleNotes: string[] = [];
  const close = (response: RunResponse): RunResponse => {
    const dataSource = resolveDataSource(state.sources) ?? "sample";
    const identity = currentModelIdentity();
    const withSource = RunResponseSchema.parse({
      ...response,
      data_source: dataSource,
      provider: identity.provider,
      model: identity.model,
    });
    traceEvent({
      action: "complete",
      input_summary: state.trace_id,
      output_summary: `provider=${identity.provider} model=${identity.model} verdict=${withSource.verdict} confidence=${withSource.confidence} data_source=${dataSource} fallbacks=${sampleNotes.length}`,
      provider: identity.provider,
      model: identity.model,
      target_agent: null,
      confidence: withSource.confidence,
      retry_count: state.revision_counts.total + state.refresh_counts.total,
      status: dataSource === "zetaris" && !state.narrative_fallback ? "success" : "fallback",
      data_source: dataSource,
    });
    return withSource;
  };
    const sourceReachable = await probeZetaris();
    if (!sourceReachable && !config.SAMPLE_MODE) {
      throw new ZetarisUnavailableError("Zetaris probe failed");
    }
    return await runContext.run({
    tracer,
    agent: "Planner",
    queryCache: new Map(),
    modelAnswer: { provider: null, model: null },
    sourceReachable,
    dataSource: () => resolveDataSource(state.sources),
    markSampleFallback(detail) {
      sampleNotes.push(detail);
    },
    markNarrativeFallback() {
      state.narrative_fallback = true;
    },
  }, async () => {
    try {
    traceEvent({
      action: "start",
      input_summary: `${request.mode} ${request.county} bags=${request.bags} storage=${request.storage}`,
      output_summary: state.question,
      target_agent: "Planner",
      confidence: null,
      retry_count: 0,
      status: "success",
    });
    await asAgent("Planner", () => traceCountyCase(state.request.county));
    await asAgent("Planner", () => recallAndGate(state));
    if (state.coverage.blocking) {
      const blocked = await asAgent("Planner", () => buildNoRecommendation(state));
      await asAgent("Planner", () => rememberOutcome(state, blocked));
      return close(blocked);
    }
    if (request.mode === "recheck") {
      traceEvent({
        action: "handoff",
        input_summary: "recheck",
        output_summary: "load the prior verdict before the analysts run",
        target_agent: "Watcher",
        confidence: null,
        retry_count: 0,
        status: "success",
      });
      await asAgent("Watcher", () => loadPrior(state));
    }

    const bag: LoopBag = { round: 0, revisions: 0, refreshes: 0 };
    const loop = await runBoundedLoop(bag, {
      async analyze(round) {
        state.round = round;
        state.revision_counts.total = bag.revisions;
        state.refresh_counts.total = bag.refreshes;
        const targets = round === 1
          ? ["MarketAnalyst", "StorageWeatherAnalyst"]
          : state.last_decision?.target_agents ?? [];
        let lastAgent = "Planner";
        if (targets.includes("MarketAnalyst")) {
          traceEvent({
            agent_name: "Planner",
            action: "handoff",
            input_summary: state.question,
            output_summary: round === 1 ? "initial price pass" : `revision ${bag.revisions} refresh ${bag.refreshes}`,
            target_agent: "MarketAnalyst",
            confidence: null,
            retry_count: bag.revisions + bag.refreshes,
            status: round === 1 ? "success" : bag.refreshes > state.refresh_counts.market ? "retrying" : "needs_revision",
          });
          if (round > 1 && state.last_decision?.reasons.includes("freshness")) state.refresh_counts.market += 1;
          else if (round > 1) state.revision_counts.market += 1;
          await asAgent("MarketAnalyst", () => analyzeMarket(state));
          lastAgent = "MarketAnalyst";
        }
        if (targets.includes("StorageWeatherAnalyst")) {
          traceEvent({
            agent_name: lastAgent,
            action: "handoff",
            input_summary: state.request.storage,
            output_summary: "forecast and storage-loss rules",
            target_agent: "StorageWeatherAnalyst",
            confidence: null,
            retry_count: bag.refreshes,
            status: "success",
          });
          if (round > 1) state.revision_counts.storage += 1;
          await asAgent("StorageWeatherAnalyst", () => analyzeStorage(state));
          lastAgent = "StorageWeatherAnalyst";
        }
        traceEvent({
          agent_name: lastAgent,
          action: "handoff",
          input_summary: `round ${round}`,
          output_summary: "claims ready for critique",
          target_agent: "RiskCritic",
          confidence: null,
          retry_count: bag.revisions,
          status: "success",
        });
      },
      async critique() {
        const decision = await asAgent("RiskCritic", () => reviewClaims(state));
        const signature = claimRevisionSignature(
          latestClaim(state, "MarketAnalyst") ?? null,
          latestClaim(state, "StorageWeatherAnalyst") ?? null,
        );
        const settled = caveatForRepeatedClaim({
          action: decision.action,
          reasons: decision.reasons,
          previous: state.rejected_signature,
          next: signature,
          notes: decision.notes,
        });
        state.rejected_signature = settled.signature;
        if (settled.caveat) {
          state.caveats.push(settled.caveat);
          traceEvent({
            action: "unresolvable",
            input_summary: decision.reasons.join(","),
            output_summary: settled.caveat,
            target_agent: decision.target_agents[0] ?? null,
            confidence: decision.confidence,
            retry_count: bag.revisions,
            status: "fallback",
          });
          return { action: "approve" as const, reasons: [] };
        }
        return { action: settled.action, reasons: decision.reasons };
      },
      async onContinue(effect) {
        await continueAfterCritique(effect, state, bag.refreshes);
        const target = state.last_decision?.target_agents[0] ?? "MarketAnalyst";
        traceEvent({
          agent_name: "RiskCritic",
          action: effect === "refresh" ? "refresh" : "revise",
          input_summary: (state.last_decision?.reasons ?? []).join(","),
          output_summary: (state.last_decision?.notes ?? []).join(" ").slice(0, 160),
          target_agent: target,
          confidence: state.last_decision?.confidence ?? null,
          retry_count: effect === "refresh" ? bag.refreshes : bag.revisions,
          status: effect === "refresh" ? "retrying" : "needs_revision",
        });
      },
    });

    state.round = bag.round;
    state.revision_counts.total = bag.revisions;
    state.refresh_counts.total = bag.refreshes;
    state.approved = loop.approved;
    if (!loop.approved) {
      const reason = state.last_decision
        ? `Stopped after ${bag.revisions} revision(s) and ${bag.refreshes} refresh(es). Last critic notes: ${state.last_decision.notes.join(" ")}`
        : "The review loop ended without an approved claim.";
      state.escalation = state.escalation ?? {
        reason,
        question: null,
      };
      const blocked = await asAgent("Planner", () => buildNoRecommendation(state));
      await asAgent("Planner", () => rememberOutcome(state, blocked));
      return close(blocked);
    }

    const checked = CaseStateSchema.safeParse(state);
    if (!checked.success) {
      const details = checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(`Case state failed validation: ${details}`);
    }
    let response = await asAgent("Planner", () => assemble(state));
    if (request.mode === "recheck") {
      response = await asAgent("Watcher", () => annotateRecheck(state, response));
    }
    await asAgent("Planner", () => rememberOutcome(state, response));
    return close(response);
    } catch (error) {
      if (!(error instanceof ZetarisQueryError)) throw error;
      state.escalation = { reason: "data unavailable", question: null };
      traceEvent({
        action: "zetaris_sql",
        input_summary: "data read",
        output_summary: error.message,
        target_agent: null,
        confidence: null,
        retry_count: 1,
        status: "error",
      });
      const blocked = await asAgent("Planner", () => buildNoRecommendation(state));
      await asAgent("Planner", () => rememberOutcome(state, blocked));
      return close(blocked);
    }
  });
  } finally {
    tracer.finish();
  }
}
