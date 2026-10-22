import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { CaseStateSchema, RunResponseSchema, type CriticReason, type RunRequest, type RunResponse } from "../schemas.js";
import { createTracer, runContext, asAgent, traceEvent } from "../tracing.js";
import { analyzeMarket } from "../agents/marketAnalyst.js";
import { analyzeStorage } from "../agents/storageWeatherAnalyst.js";
import { reviewClaims } from "../agents/riskCritic.js";
import { resolveDataSource } from "../adapters/zetaris.js";
import { assemble, buildNoRecommendation, recallAndGate, rememberOutcome } from "../agents/planner.js";
import { annotateRecheck, loadPrior } from "../agents/watcher.js";
import { createInitialState } from "./state.js";

export const LOOP_LIMITS = { maxRevisions: 2, maxRefreshes: 2, maxRounds: 3 } as const;

export interface LoopBag {
  round: number;
  revisions: number;
  refreshes: number;
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

export async function runCase(request: RunRequest): Promise<RunResponse> {
  const config = loadConfig();
  const traceId = randomUUID();
  const tracer = createTracer(traceId, config.LOG_DIR);
  const state = createInitialState(request, traceId);
  const sampleNotes: string[] = [];
  const close = (response: RunResponse): RunResponse => {
    const dataSource = resolveDataSource(state.sources, sampleNotes.length) ?? "sample";
    const withSource = RunResponseSchema.parse({ ...response, data_source: dataSource });
    traceEvent({
      action: "complete",
      input_summary: state.trace_id,
      output_summary: `verdict=${withSource.verdict} confidence=${withSource.confidence} data_source=${dataSource} fallbacks=${sampleNotes.length}`,
      target_agent: null,
      confidence: withSource.confidence,
      retry_count: state.revision_counts.total + state.refresh_counts.total,
      status: dataSource === "zetaris" && !state.narrative_fallback ? "success" : "fallback",
      data_source: dataSource,
    });
    return withSource;
  };
  return runContext.run({
    tracer,
    agent: "Planner",
    queryCache: new Map(),
    dataSource: () => resolveDataSource(state.sources, sampleNotes.length),
    markSampleFallback(detail) {
      sampleNotes.push(detail);
    },
    markNarrativeFallback() {
      state.narrative_fallback = true;
    },
  }, async () => {
    traceEvent({
      action: "start",
      input_summary: `${request.mode} ${request.county} bags=${request.bags} storage=${request.storage}`,
      output_summary: state.question,
      target_agent: "Planner",
      confidence: null,
      retry_count: 0,
      status: "success",
    });
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
        return decision;
      },
      async onContinue(effect) {
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
        question: state.last_decision?.action === "escalate"
          ? state.last_decision.notes.find((note) => note.includes("?")) ?? "Which market, storage type, and written offer should we use?"
          : "Which of the buyer offer, the storage type, or the market quote should we treat as wrong?",
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
  });
}
