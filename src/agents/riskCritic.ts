import { completeText } from "../adapters/meterless.js";
import type { CaseState, Claim, CriticDecision, CriticReason } from "../schemas.js";
import { daysBetween, latestClaim } from "../orchestration/state.js";
import { traceEvent } from "../tracing.js";

const ESCALATE = new Set<CriticReason>(["coverage", "farmer_limits", "missing_input"]);

export interface JudgeInput {
  today: string;
  bags: number;
  storage: string;
  cashNeed?: number;
  offerPerBag?: number;
  market: Claim | null;
  storageClaim: Claim | null;
}

function record(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return payload ?? {};
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function newsItems(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = payload.news;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

export function judgeClaims(input: JudgeInput): CriticDecision {
  const reasons: CriticReason[] = [];
  const notes: string[] = [];
  const targets = new Set<string>();
  const market = record(input.market?.payload);
  const storage = record(input.storageClaim?.payload);

  if (!input.market) {
    reasons.push("missing_evidence");
    notes.push("MarketAnalyst has not filed a claim.");
    targets.add("MarketAnalyst");
  } else {
    if (input.market.evidence.length === 0) {
      reasons.push("missing_evidence");
      notes.push("The price claim has no evidence receipt.");
      targets.add("MarketAnalyst");
    }
    const outlierCount = num(market, "outlier_count") ?? 0;
    const removed = num(market, "outliers_removed") ?? 0;
    if (outlierCount > removed) {
      reasons.push("outlier");
      notes.push(`${outlierCount - removed} price outlier(s) are still inside the percentile window.`);
      targets.add("MarketAnalyst");
    }
    const oldest = str(market, "oldest_date");
    const latest = str(market, "latest_date");
    if (oldest && latest && daysBetween(oldest, latest) > 21) {
      reasons.push("freshness");
      notes.push(`The price window runs from ${oldest} to ${latest}, which mixes stale quotes into the band.`);
      targets.add("MarketAnalyst");
    }
    if (latest && daysBetween(latest, input.today) > 10) {
      reasons.push("freshness");
      notes.push(`The newest price quote is ${latest}, more than 10 days before ${input.today}.`);
      targets.add("MarketAnalyst");
    }
    const n = num(market, "n");
    if (n !== null && n < 3) {
      reasons.push("coverage");
      notes.push(`Only ${n} cleaned white-maize quotes support this county.`);
      targets.add("MarketAnalyst");
    }
    for (const item of newsItems(market)) {
      const maize = typeof item.maize_type === "string" ? item.maize_type : "";
      if (maize && maize !== "white") {
        reasons.push("maize_type_mismatch");
        notes.push(`News item ${String(item.id ?? "")} is tagged ${maize}, not white maize.`);
        targets.add("MarketAnalyst");
        break;
      }
    }
    if (market.unresolved_conflict === true) {
      reasons.push("contradiction");
      notes.push("A kept news item disagrees with the direction of the cleaned price series.");
      targets.add("MarketAnalyst");
    }
  }

  if (!input.storage) {
    reasons.push("missing_input");
    notes.push("Storage type is missing.");
  }
  if (!input.storageClaim) {
    reasons.push("missing_evidence");
    notes.push("StorageWeatherAnalyst has not filed a claim.");
    targets.add("StorageWeatherAnalyst");
  } else {
    if (input.storageClaim.evidence.length === 0 || num(storage, "rules_matched") === 0) {
      reasons.push("missing_evidence");
      notes.push(str(storage, "error") ?? "The loss claim has no matched storage rule.");
      targets.add("StorageWeatherAnalyst");
    }
    const forecastAsOf = str(storage, "forecast_as_of");
    if (forecastAsOf && daysBetween(forecastAsOf, input.today) > 7) {
      reasons.push("freshness");
      notes.push(`The forecast is dated ${forecastAsOf}.`);
      targets.add("StorageWeatherAnalyst");
    }
    const rain = num(storage, "total_rain_mm") ?? 0;
    const loss = num(storage, "loss_mean");
    if (input.storage === "open_bags" && rain >= 20 && loss !== null && loss < 0.05) {
      reasons.push("contradiction");
      notes.push(`Open bags and ${rain.toFixed(0)} mm of rain produced only ${(loss * 100).toFixed(1)}% expected loss.`);
      targets.add("StorageWeatherAnalyst");
    }
    if (storage.implausible_forecast === true) {
      reasons.push("outlier");
      notes.push("The forecast contains a value outside a plausible daily range.");
      targets.add("StorageWeatherAnalyst");
    }
  }

  if (input.cashNeed !== undefined && input.offerPerBag !== undefined && input.cashNeed > input.offerPerBag * input.bags) {
    reasons.push("farmer_limits");
    notes.push(
      `Cash need ${Math.round(input.cashNeed)} KES is above the ${Math.round(input.offerPerBag * input.bags)} KES a full sale at the stated offer would raise.`,
    );
  }

  const unique = [...new Set(reasons)];
  const action = unique.some((reason) => ESCALATE.has(reason)) ? "escalate" : unique.length > 0 ? "reject" : "approve";
  const confidence = action === "approve" ? 0.8 : action === "reject" ? 0.45 : 0.2;
  if (action === "escalate" && !notes.some((note) => note.includes("?"))) {
    notes.push("Which market, storage type, and written buyer offer should we use?");
  }
  return {
    action,
    reasons: unique,
    notes,
    target_agents: [...targets],
    confidence,
  };
}

export async function reviewClaims(state: CaseState): Promise<CriticDecision> {
  const decision = judgeClaims({
    today: state.today,
    bags: state.request.bags,
    storage: state.request.storage,
    cashNeed: state.request.cash_need,
    offerPerBag: state.request.offer_per_bag,
    market: latestClaim(state, "MarketAnalyst") ?? null,
    storageClaim: latestClaim(state, "StorageWeatherAnalyst") ?? null,
  });
  const note = await completeText({
    agent: "RiskCritic",
    system: "You are a risk critic. Reply with one sentence on evidence quality. Do not change the action code you are given.",
    user: `Action ${decision.action}. Reasons: ${decision.reasons.join(", ") || "none"}. Notes: ${decision.notes.join(" ")}`,
  });
  if (note.fallback) state.narrative_fallback = true;
  else if (note.text) decision.notes.push(note.text.slice(0, 300));

  for (const agent of ["MarketAnalyst", "StorageWeatherAnalyst"]) {
    const claim = latestClaim(state, agent);
    if (!claim) continue;
    if (decision.action === "approve") claim.status = "approved";
    else if (decision.target_agents.includes(agent) || decision.action === "escalate") {
      claim.status = decision.action === "escalate" ? "escalated" : "rejected";
    }
  }
  state.critic_decisions.push(decision);
  state.last_decision = decision;
  traceEvent({
    action: "critique",
    input_summary: `claims=${state.claims.length} round=${state.round}`,
    output_summary: `${decision.action} ${decision.reasons.join(",") || "ok"}`,
    target_agent: decision.target_agents[0] ?? "Planner",
    confidence: decision.confidence,
    retry_count: state.revision_counts.total + state.refresh_counts.total,
    status: decision.action === "approve" ? "success" : decision.action === "reject" ? "needs_revision" : "error",
  });
  return decision;
}
