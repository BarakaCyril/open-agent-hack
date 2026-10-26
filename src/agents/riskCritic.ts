import { chat } from "../adapters/meterless.js";
import { RemoteSourceError, readWhiteMaizeWindow } from "../adapters/zetaris.js";
import { loadConfig } from "../config.js";
import type { CaseState, Claim, CriticDecision, CriticReason } from "../schemas.js";
import { MIXED_PRICE_WINDOW_DAYS, daysBetween, latestClaim, mixedAgeNote } from "../orchestration/state.js";
import { cleanAndSummarize } from "../tools/prices.js";
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
  staleDays?: number;
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
  const staleDays = input.staleDays ?? 3;
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
    // Longer than MIXED_PRICE_WINDOW_DAYS means the band blends a stale quote with a current one.
    if (oldest && latest && daysBetween(oldest, latest) > MIXED_PRICE_WINDOW_DAYS) {
      reasons.push("freshness");
      notes.push(mixedAgeNote(oldest, latest) ?? `The price window runs from ${oldest} to ${latest}.`);
      targets.add("MarketAnalyst");
    }
    if (latest && daysBetween(latest, input.today) > staleDays) {
      reasons.push("freshness");
      notes.push(`The newest price quote is ${latest}, more than ${staleDays} days before ${input.today}.`);
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
    if (forecastAsOf && daysBetween(forecastAsOf, input.today) > staleDays) {
      reasons.push("freshness");
      notes.push(`The forecast is dated ${forecastAsOf}, more than ${staleDays} days before ${input.today}.`);
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

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1;
}

/** Recompute the price claim from Zetaris. A mismatch rejects it. Offline mode records a skipped check. */
export async function verifyMarketClaim(state: CaseState, decision: CriticDecision): Promise<CriticDecision> {
  if (decision.action !== "approve") return decision;
  const claim = latestClaim(state, "MarketAnalyst");
  const payload = claim?.payload ?? {};
  const n = typeof payload.n === "number" ? payload.n : null;
  const p10 = typeof payload.p10 === "number" ? payload.p10 : null;
  const p50 = typeof payload.p50 === "number" ? payload.p50 : null;
  const p90 = typeof payload.p90 === "number" ? payload.p90 : null;
  const latest = typeof payload.latest_date === "string" ? payload.latest_date : "";
  const oldest = typeof payload.oldest_date === "string" ? payload.oldest_date : "";
  if (n === null || p10 === null || p50 === null || p90 === null || !latest || !oldest) return decision;
  const summarySql = `SELECT market_date, wholesale_price_kes FROM maize.kamis_prices WHERE county = '${state.request.county}' AND white maize window ${oldest}..${latest}`;
  try {
    const points = await readWhiteMaizeWindow(state.request.county, oldest, latest);
    const stats = cleanAndSummarize(points.map((point) => ({ date: point.date, price: point.price })));
    const matched = stats.n === n
      && stats.latestDate === latest
      && closeEnough(stats.p10, p10)
      && closeEnough(stats.p50, p50)
      && closeEnough(stats.p90, p90);
    traceEvent({
      action: "verify_claim",
      input_summary: summarySql,
      output_summary: `n=${stats.n} p10=${Math.round(stats.p10)} p50=${Math.round(stats.p50)} p90=${Math.round(stats.p90)} newest=${stats.latestDate} match=${matched}`,
      target_agent: "MarketAnalyst",
      confidence: null,
      retry_count: state.revision_counts.total + state.refresh_counts.total,
      status: matched ? "success" : "needs_revision",
    });
    if (matched) return decision;
    decision.action = "reject";
    decision.confidence = 0.45;
    decision.notes.push(
      `Verification mismatch: Zetaris recomputed n=${stats.n}, P50 ${Math.round(stats.p50)}, newest ${stats.latestDate}.`,
    );
    if (!decision.target_agents.includes("MarketAnalyst")) decision.target_agents.push("MarketAnalyst");
    return decision;
  } catch (error) {
    const unreachable = error instanceof RemoteSourceError && error.unreachable;
    traceEvent({
      action: "verify_claim",
      input_summary: summarySql,
      output_summary: unreachable && loadConfig().SAMPLE_MODE
        ? "offline mode: numeric check skipped"
        : (error instanceof Error ? error.message : "verification failed"),
      target_agent: "MarketAnalyst",
      confidence: null,
      retry_count: 0,
      status: unreachable && loadConfig().SAMPLE_MODE ? "fallback" : "error",
    });
    if (unreachable && loadConfig().SAMPLE_MODE) return decision;
    decision.action = "reject";
    decision.confidence = 0.45;
    decision.notes.push("Verification could not recompute the price claim from Zetaris.");
    if (!decision.target_agents.includes("MarketAnalyst")) decision.target_agents.push("MarketAnalyst");
    return decision;
  }
}

export async function reviewClaims(state: CaseState): Promise<CriticDecision> {
  const decision = await verifyMarketClaim(state, judgeClaims({
    today: state.today,
    bags: state.request.bags,
    storage: state.request.storage,
    cashNeed: state.request.cash_need,
    offerPerBag: state.request.offer_per_bag,
    market: latestClaim(state, "MarketAnalyst") ?? null,
    storageClaim: latestClaim(state, "StorageWeatherAnalyst") ?? null,
    staleDays: loadConfig().STALE_DAYS,
  }));
  const note = await chat({
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
