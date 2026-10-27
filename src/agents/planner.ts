import { readPrices, readWeather, resolveDataSource } from "../adapters/zetaris.js";
import { loadConfig } from "../config.js";
import { getMemory } from "../adapters/memory.js";
import { chat, wordingFallbackNote } from "../adapters/meterless.js";
import { isWhiteMaizeBag } from "../adapters/sampleData.js";
import { RunResponseSchema, type CaseState, type RunResponse } from "../schemas.js";
import { EV_SEED, describeLiquidityPenalty, expectedValue, type EvInput, type EvResult } from "../tools/expectedValue.js";
import { projectPriceBand, type PriceStats } from "../tools/prices.js";
import { addDays, daysBetween, freshnessLabel, kes, latestClaim, mixedAgeNote, pct, roundTo, setSyntheticInput } from "../orchestration/state.js";
import { currentModelIdentity, traceEvent } from "../tracing.js";
import { isTwoPlainSentences, limitToTwoPlainSentences, plainText } from "../wording.js";

const FRESH_DAYS = 14;
const BLOCKING_ROWS = 3;
const THIN_ROWS = 5;

export async function recallAndGate(state: CaseState): Promise<void> {
  const memories = await getMemory().recall(state.request.farmer_id);
  state.memory_recall = memories.map((record) => ({
    farmer_id: record.farmerId,
    kind: record.kind,
    content: record.content,
    payload: record.payload,
    created_at: record.createdAt,
  }));
  traceEvent({
    action: "recall",
    input_summary: state.request.farmer_id,
    output_summary: `memories=${memories.length}`,
    target_agent: "Planner",
    confidence: null,
    retry_count: 0,
    status: "success",
  });

  const prices = await readPrices(state.request.county);
  const weather = await readWeather(state.request.county);
  state.sources.prices = prices.via;
  state.sources.weather = weather.via;
  setSyntheticInput(state, "weather", weather.via === "sample" || weather.synthetic);

  const white = prices.value.filter((row) => isWhiteMaizeBag(row));
  const fresh = white.filter((row) => {
    const age = daysBetween(row.market_date, state.today);
    return Number.isFinite(age) && age >= 0 && age <= FRESH_DAYS;
  });
  const forecast = weather.value;
  const dirtyDays = (forecast?.days ?? []).filter((day) => day.rain_mm > 200 || day.rain_mm < 0);
  const forecastAge = forecast?.as_of ? daysBetween(forecast.as_of, state.today) : null;
  const freshLabel = fresh.length === 1 ? "row" : "rows";
  const parts = [
    `${state.request.county} has ${fresh.length} white-maize price ${freshLabel} in the last ${FRESH_DAYS} days (${white.length} in the file).`,
  ];
  if (fresh.length === 1) {
    const only = fresh[0];
    if (only) parts.push(`That quote is ${Math.round(only.wholesale_price_kes)} KES on ${only.market_date} with reported volume ${only.volume_bags}.`);
  }
  if (forecast?.as_of) {
    const staleDays = loadConfig().STALE_DAYS;
    parts.push(`Forecast as of ${forecast.as_of}${forecastAge !== null && forecastAge > staleDays ? ` (${forecastAge} days old)` : ""}.`);
  } else {
    parts.push("No forecast was returned for this county.");
  }
  if (dirtyDays.length > 0) {
    parts.push(`Forecast includes ${dirtyDays.map((day) => `${day.rain_mm} mm on ${day.date}`).join(", ")}, outside a plausible daily range.`);
  }
  const blocking = fresh.length < BLOCKING_ROWS;
  state.coverage = {
    price_rows: white.length,
    fresh_price_rows: fresh.length,
    thin: fresh.length < THIN_ROWS,
    blocking,
    note: parts.join(" "),
  };
  traceEvent({
    action: "coverage_gate",
    input_summary: state.request.county,
    output_summary: state.coverage.note,
    target_agent: blocking ? "Planner" : "MarketAnalyst",
    confidence: blocking ? 0 : roundTo(Math.min(1, fresh.length / 10)),
    retry_count: 0,
    status: blocking ? "error" : state.coverage.thin ? "partial_success" : "success",
  });
  if (blocking) {
    state.escalation = {
      reason: state.coverage.note,
      question: `Which market in ${state.request.county} should we price, and what written buyer offer do you have per 90 kg bag?`,
    };
  }
}

function criticNotes(state: CaseState): string[] {
  return (state.last_decision?.notes ?? [])
    .map((note) => note.replace(/\blikely\b/giu, "").replace(/\s+/g, " ").trim())
    .filter((note) => note.length > 0 && !/\blikely\b/iu.test(note));
}

/** Abstention text comes from the blocking rule and the critic notes. The model does not write it. */
export function abstentionCopy(state: CaseState): {
  reason: string;
  plain_reply: string;
  question_for_farmer: string | null;
  what_would_change_this_advice: string[];
} {
  const reasons = new Set(state.last_decision?.reasons ?? []);
  const notes = criticNotes(state);
  const reasonText = (state.escalation?.reason ?? "").replace(/\blikely\b/giu, "").replace(/\s+/g, " ").trim();
  const county = state.request.county;
  const rows = state.coverage.fresh_price_rows;
  const rowWord = rows === 1 ? "row" : "rows";

  if (/data unavailable/iu.test(reasonText)) {
    return {
      reason: "data unavailable",
      question_for_farmer: null,
      what_would_change_this_advice: [
        `A recommendation needs ${county} prices and the daily forecast to come back from Zetaris.`,
      ],
      plain_reply: limitToTwoPlainSentences(ensureTwo(
        "This run returns no recommendation because the price or forecast data was unavailable.",
        "The query was retried once and still failed.",
      )),
    };
  }

  if (state.coverage.blocking || (reasons.has("coverage") && rows < BLOCKING_ROWS)) {
    const countSentence = `${county} has ${rows} fresh white-maize price ${rowWord}, so this run returns no recommendation.`;
    const need = `A recommendation needs at least ${BLOCKING_ROWS} white-maize quotes for ${county} in the last ${FRESH_DAYS} days.`;
    return {
      reason: state.coverage.note || countSentence,
      question_for_farmer: null,
      what_would_change_this_advice: [need, ...notes.filter((note) => !/quotes/iu.test(note))].slice(0, 3),
      plain_reply: limitToTwoPlainSentences(ensureTwo(countSentence, need)),
    };
  }

  if (reasons.has("coverage")) {
    const stale = notes.find((item) => /newest price quote/iu.test(item));
    const cleaned = notes.find((item) => /cleaned white-maize/iu.test(item));
    const explanation = stale ?? cleaned ?? notes[0] ?? `${county} already has ${rows} white-maize price ${rowWord} in the last ${FRESH_DAYS} days.`;
    const lead = stale
      ? "This run returns no recommendation because the newest white-maize quote is too old to price a sale."
      : "This run returns no recommendation because the cleaned price window has fewer than 3 white-maize quotes.";
    const change = stale
      ? `A newer white-maize quote for ${county} would replace the stale price and let this run continue.`
      : `At least ${BLOCKING_ROWS} cleaned white-maize quotes in the window used for the price band would let this run continue.`;
    return {
      reason: explanation,
      question_for_farmer: null,
      what_would_change_this_advice: [change, ...notes.filter((note) => note !== explanation)].slice(0, 3),
      plain_reply: limitToTwoPlainSentences(ensureTwo(lead, explanation)),
    };
  }

  if (reasons.has("farmer_limits")) {
    const note = notes.find((item) => /cash need/iu.test(item))
      ?? "The cash need is above what a full sale at the stated offer would raise.";
    return {
      reason: note,
      question_for_farmer: "What cash amount do you need, and what offer per 90 kg bag is on the table?",
      what_would_change_this_advice: [
        "A cash need the stated offer can cover, or a higher offer per 90 kg bag, would remove this block.",
      ],
      plain_reply: limitToTwoPlainSentences(ensureTwo(
        "This run returns no recommendation because the cash need is higher than a full sale at the stated offer would raise.",
        note,
      )),
    };
  }

  if (reasons.has("missing_input")) {
    const note = notes.find((item) => /storage|offer|cash|bag|county/iu.test(item)) ?? "A required input is missing.";
    const lower = note.toLowerCase();
    const question = lower.includes("storage")
      ? "Which storage are the bags in: open bags, a crib, a hermetic bag, or a dry store?"
      : lower.includes("offer")
        ? "What offer per 90 kg bag is on the table?"
        : lower.includes("bag")
          ? "How many 90 kg bags are you deciding on?"
          : lower.includes("county")
            ? "Which county should this decision use?"
            : null;
    return {
      reason: note,
      question_for_farmer: question,
      what_would_change_this_advice: [note],
      plain_reply: limitToTwoPlainSentences(ensureTwo("This run returns no recommendation because a required input is missing.", note)),
    };
  }

  const detail = notes[0] || reasonText || "The review could not approve the claims.";
  return {
    reason: detail,
    question_for_farmer: null,
    what_would_change_this_advice: notes.length > 0 ? notes.slice(0, 3) : [detail],
    plain_reply: limitToTwoPlainSentences(ensureTwo("This run returns no recommendation.", detail)),
  };
}

export async function buildNoRecommendation(state: CaseState): Promise<RunResponse> {
  const copy = abstentionCopy(state);
  const dataSource = resolveDataSource(state.sources) ?? "sample";
  const response: RunResponse = {
    verdict: "no_recommendation",
    hold_days: null,
    price_range_per_90kg_bag: publishedPriceRange("no_recommendation", null),
    decision_values_kes: null,
    data_source: dataSource,
    confidence: 0,
    evidence: evidenceFrom(state),
    reasoning_trace_summary: [noRecommendationSummary(state.coverage.note, copy.reason), mixedAgeFrom(state)].filter(Boolean).join(" ").slice(0, 1200),
    what_would_change_this_advice: copy.what_would_change_this_advice,
    limitations: limitationsFor(state),
    recheck_schedule: copy.question_for_farmer
      ? `Recheck on ${addDays(state.today, 2)} or as soon as you can answer the question.`
      : `Recheck on ${addDays(state.today, 2)}.`,
    plain_reply: copy.plain_reply,
    ...currentModelIdentity(),
    trace_id: state.trace_id,
    reason: copy.reason,
    question_for_farmer: copy.question_for_farmer,
  };
  return RunResponseSchema.parse(response);
}

export async function assemble(state: CaseState): Promise<RunResponse> {
  const market = latestClaim(state, "MarketAnalyst");
  const storage = latestClaim(state, "StorageWeatherAnalyst");
  if (!market || !storage) {
    state.escalation = {
      reason: "An analyst claim was missing when the planner assembled the case.",
      question: "Can you confirm the county, the storage type, and the bag count?",
    };
    return buildNoRecommendation(state);
  }
  const stats = statsFrom(market.payload);
  const lossMean = num(storage.payload, "loss_mean");
  const lossP10 = num(storage.payload, "loss_p10");
  const lossP90 = num(storage.payload, "loss_p90");
  const days = num(storage.payload, "days") ?? 7;
  if (!stats || lossMean === null || lossP10 === null || lossP90 === null) {
    state.escalation = {
      reason: "The approved claims did not include a price band and a loss distribution.",
      question: "Can you confirm storage type and a current buyer offer per 90 kg bag?",
    };
    return buildNoRecommendation(state);
  }
  const band = projectPriceBand(stats, days);
  const sellPrice = state.request.offer_per_bag ?? stats.latest;
  const base: EvInput = {
    bags: state.request.bags,
    sellPricePerBag: sellPrice,
    futureP10: band.p10,
    futureP50: band.p50,
    futureP90: band.p90,
    lossMean,
    lossP10,
    lossP90,
    cashNeed: state.request.cash_need ?? 0,
    holdDays: days,
    seed: EV_SEED,
  };
  const ev = expectedValue(base);
  const changes = counterfactuals(base, ev);
  const age = daysBetween(stats.latestDate, state.today);
  let confidence = 0.5 * Math.min(1, stats.n / 10) + 0.3 * (age <= 3 ? 1 : age <= 7 ? 0.75 : 0.45) + 0.2 * Math.max(0, 1 - (lossP90 - lossP10) * 4);
  if (state.revision_counts.total > 0) confidence -= 0.05;
  if (state.coverage.thin) confidence = Math.min(confidence, 0.45);
  if (state.sources.prices === "sample") confidence -= 0.1;
  if (state.caveats.length > 0) confidence -= 0.15 * state.caveats.length;
  confidence = roundTo(Math.max(0.05, Math.min(0.95, confidence)));
  const holdDays = ev.best === "hold" ? days : null;
  const penaltyNote = describeLiquidityPenalty(ev);
  const summary = [
    `Rounds ${state.round}, revisions ${state.revision_counts.total}, refreshes ${state.refresh_counts.total}.`,
    `Computed scored value sell ${kes(ev.sellEv)}, hold ${kes(ev.holdEv)}, split ${kes(ev.splitEv)} KES. Higher scored value: ${ev.best}.`,
    penaltyNote,
    mixedAgeFrom(state),
    market.statement,
    storage.statement,
  ].filter((part): part is string => Boolean(part)).join(" ");
  const reply = await phrase(
    state,
    "Planner",
    twoSentenceReply(state, ev, stats, lossMean, holdDays),
    ev.best,
  );
  const response: RunResponse = {
    verdict: ev.best,
    hold_days: holdDays,
    data_source: resolveDataSource(state.sources) ?? "sample",
    price_range_per_90kg_bag: publishedPriceRange(ev.best, { p10: roundTo(stats.p10), p50: roundTo(stats.p50), p90: roundTo(stats.p90) }),
    decision_values_kes: decisionValues(ev),
    confidence,
    evidence: [...market.evidence, ...storage.evidence],
    reasoning_trace_summary: summary.slice(0, 1200),
    what_would_change_this_advice: changes,
    limitations: penaltyNote ? [...limitationsFor(state), penaltyNote] : limitationsFor(state),
    recheck_schedule: `Recheck on ${addDays(state.today, ev.best === "hold" ? 3 : 7)} or sooner if the forecast or the buyer offer changes.`,
    plain_reply: limitToTwoPlainSentences(reply),
    ...currentModelIdentity(),
    trace_id: state.trace_id,
    reason: null,
    question_for_farmer: null,
  };
  traceEvent({
    action: "assemble",
    input_summary: state.question,
    output_summary: `verdict=${ev.best} confidence=${confidence} cash_need=${base.cashNeed} penalty_rate=${ev.penaltyRate} hold_gross=${Math.round(ev.holdGross)} hold_penalty=${Math.round(ev.holdPenalty)} scored_hold=${Math.round(ev.holdEv)} sell_penalty=${Math.round(ev.sellPenalty)} split_penalty=${Math.round(ev.splitPenalty)}`,
    target_agent: state.request.mode === "recheck" ? "Watcher" : null,
    confidence,
    retry_count: state.revision_counts.total,
    status: "success",
  });
  return RunResponseSchema.parse(response);
}

function counterfactuals(base: EvInput, ev: EvResult): string[] {
  const lines: string[] = [];
  const drierLoss = Math.max(0, base.lossMean * 0.25);
  const drier = expectedValue({ ...base, lossMean: drierLoss, lossP10: drierLoss, lossP90: Math.max(drierLoss, base.lossP90 * 0.25) });
  if (drier.best !== ev.best) {
    lines.push(`If expected loss over ${base.holdDays} days fell from ${pct(base.lossMean)} to ${pct(drierLoss)}, the higher-value action would be ${drier.best} at about ${kes(valueOf(drier, drier.best))} KES.`);
  }
  const richer = expectedValue({ ...base, sellPricePerBag: base.futureP90 });
  if (richer.best !== ev.best) {
    lines.push(`If the buyer offer moved to ${kes(base.futureP90)} KES per 90 kg bag, the higher-value action would be ${richer.best}.`);
  }
  const wetter = Math.min(0.9, base.lossMean + 0.12);
  const wet = expectedValue({ ...base, lossMean: wetter, lossP10: base.lossP10, lossP90: Math.max(base.lossP90, wetter) });
  if (wet.best !== ev.best) {
    lines.push(`If expected loss rose from ${pct(base.lossMean)} to ${pct(wetter)}, the higher-value action would be ${wet.best}.`);
  }
  if (lines.length === 0) {
    lines.push(`A loss of ${pct(drierLoss)} and an offer of ${kes(base.futureP90)} KES per bag were checked. The higher-value action stayed ${ev.best}.`);
  }
  return lines;
}

function valueOf(ev: EvResult, action: EvResult["best"]): number {
  if (action === "hold") return ev.holdEv;
  if (action === "split") return ev.splitEv;
  return ev.sellEv;
}

function twoSentenceReply(state: CaseState, ev: EvResult, stats: PriceStats, lossMean: number, holdDays: number | null): string {
  const bags = state.request.bags;
  const county = state.request.county;
  const first = `For ${bags} bags in ${county}, the higher computed value is ${ev.best} at about ${kes(valueOf(ev, ev.best))} KES, inside a recent band of ${kes(stats.p10)} to ${kes(stats.p90)} KES per 90 kg bag.`;
  const second = ev.holdPenalty > 0
    ? `The hold grain value is ${kes(ev.holdGross)} KES before a ${kes(ev.holdPenalty)} KES cash-need penalty, so the scored hold value is ${kes(ev.holdEv)} KES.`
    : ev.best === "hold"
      ? `Expected storage loss over ${holdDays ?? stats.n} days is ${pct(lossMean)}, so the case for holding is the price path after that loss.`
      : `Expected storage loss over the forecast is ${pct(lossMean)}, which is already in that comparison.`;
  return `${first} ${second}`;
}

export function publishedPriceRange<T>(verdict: string, range: T | null): T | null {
  return verdict === "no_recommendation" ? null : range;
}

export function decisionValues(ev: EvResult): NonNullable<RunResponse["decision_values_kes"]> {
  const ranked = [ev.sellEv, ev.holdEv, ev.splitEv].sort((a, b) => b - a);
  return {
    sell: roundTo(ev.sellEv),
    hold: roundTo(ev.holdEv),
    split: roundTo(ev.splitEv),
    edge_over_next_best: roundTo(Math.max(0, (ranked[0] ?? 0) - (ranked[1] ?? 0))),
  };
}

export function dedupeSentences(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const key = part.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(part.replace(/\s+/g, " "));
  }
  return kept.join(" ");
}

export function noRecommendationSummary(coverageNote: string, reason: string): string {
  return dedupeSentences(`${coverageNote} ${reason}`.trim());
}

async function phrase(state: CaseState, agent: string, fallback: string, verdict: string | null): Promise<string> {
  const result = await chat({
    agent,
    system: "Write exactly two sentences for a Kenyan maize farmer. Decision support, not financial advice. Do not change the action in the user message. No markdown.",
    user: fallback,
  });
  const plain = plainText(result.text);
  const needsPenalty = fallback.toLowerCase().includes("cash-need penalty");
  if (
    result.fallback
    || result.wordingRejected
    || !isTwoPlainSentences(plain)
    || (verdict && !plain.toLowerCase().includes(verdict))
    || (needsPenalty && !plain.toLowerCase().includes("penalty"))
  ) {
    if (result.fallback) state.narrative_fallback = true;
    const computed = isTwoPlainSentences(fallback)
      ? fallback.trim()
      : ensureTwo(fallback, "This is decision support, not a promise of the price you will receive.");
    return limitToTwoPlainSentences(computed);
  }
  return limitToTwoPlainSentences(plain);
}

function ensureTwo(first: string, second: string): string {
  const clean = (sentence: string) => {
    const trimmed = sentence.trim().replace(/\s+/g, " ");
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  };
  return `${clean(first)} ${clean(second)}`;
}

export function isTwoSentences(text: string): boolean {
  return isTwoPlainSentences(text);
}

export function limitationsFor(state: CaseState): string[] {
  const dataSource = resolveDataSource(state.sources) ?? "sample";
  const lines = [
    "Decision support only. This is not financial advice and it is not an offer to buy or sell maize.",
    `Data source: ${dataSource}.`,
    "Values come from a fixed-seed Monte Carlo over the cleaned price band and the storage-loss rules.",
    "Farmer history is stored in H-MEM (profile, verdicts, and offer gaps) under data/hmem.",
  ];
  lines.push(...state.caveats);
  if (state.sources.prices === "sample") {
    lines.push("Offline mode: price rows were read from data/sample/kamis_dry_maize.csv because Zetaris was unreachable.");
  }
  if (state.synthetic_inputs.includes("weather")) lines.push("The forecast used here is synthetic.");
  if (state.synthetic_inputs.includes("rules")) lines.push("Storage-loss rules are synthetic.");
  if (state.synthetic_inputs.includes("news")) lines.push("News items are synthetic.");
  if (state.synthetic_inputs.includes("ledger")) lines.push("The farmer ledger used here is synthetic.");
  if (state.narrative_fallback) lines.push(wordingFallbackNote());
  lines.push(...extraLimits(state));
  lines.push("KAMIS licence terms for the price sample are unconfirmed.");
  return lines;
}

function mixedAgeFrom(state: CaseState): string | null {
  const market = latestClaim(state, "MarketAnalyst");
  const oldest = typeof market?.payload.oldest_date === "string" ? market.payload.oldest_date : "";
  const latest = typeof market?.payload.latest_date === "string" ? market.payload.latest_date : "";
  if (!oldest || !latest) return null;
  return mixedAgeNote(oldest, latest);
}

function extraLimits(state: CaseState): string[] {
  const lines = [...state.refresh_limits];
  const mixed = mixedAgeFrom(state);
  if (mixed) lines.push(mixed);
  if (state.request.fixture === "dirty") {
    lines.push("Planted rows from data/fixtures/dirty_market.json are included. They are not KAMIS prices or a gazette notice.");
  }
  return lines;
}

function evidenceFrom(state: CaseState): RunResponse["evidence"] {
  const market = latestClaim(state, "MarketAnalyst");
  const storage = latestClaim(state, "StorageWeatherAnalyst");
  return [...(market?.evidence ?? []), ...(storage?.evidence ?? [])];
}

function statsFrom(payload: Record<string, unknown>): PriceStats | null {
  const p10 = num(payload, "p10");
  const p50 = num(payload, "p50");
  const p90 = num(payload, "p90");
  const n = num(payload, "n");
  const latest = num(payload, "latest");
  const slope = num(payload, "slope_per_day");
  const latestDate = typeof payload.latest_date === "string" ? payload.latest_date : "";
  const oldestDate = typeof payload.oldest_date === "string" ? payload.oldest_date : "";
  if (p10 === null || p50 === null || p90 === null || n === null || latest === null || slope === null || !latestDate) return null;
  return {
    p10,
    p50,
    p90,
    n,
    outliersRemoved: num(payload, "outliers_removed") ?? 0,
    outlierCount: num(payload, "outlier_count") ?? 0,
    latest,
    latestDate,
    oldestDate,
    slopePerDay: slope,
  };
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function rememberOutcome(state: CaseState, response: RunResponse): Promise<void> {
  const memory = getMemory();
  const { farmer_id: farmerId, county, bags, storage } = state.request;
  const market = latestClaim(state, "MarketAnalyst");
  const stored = latestClaim(state, "StorageWeatherAnalyst");
  const benchmark = market ? num(market.payload, "p50") : null;
  const rain = stored && typeof stored.payload.total_rain_mm === "number" ? stored.payload.total_rain_mm : null;
  const offer = state.request.offer_per_bag;
  await memory.remember(farmerId, {
    kind: "profile",
    content: `Farmer ${farmerId} in ${county} holds ${bags} bags of white maize in ${storage}.`,
    payload: { county, bags, storage },
  });
  await memory.remember(farmerId, {
    kind: "verdict",
    content: `On ${state.today} the computed verdict was ${response.verdict}. ${response.reasoning_trace_summary}`,
    payload: {
      verdict: response.verdict,
      confidence: response.confidence,
      trace_id: response.trace_id,
      hold_days: response.hold_days,
      as_of: state.today,
      reasoning: response.reasoning_trace_summary,
      forecast_rain_mm_7d: rain,
    },
  });
  let gap: number | null = null;
  if (offer !== undefined && benchmark !== null) {
    gap = offer - benchmark;
    await memory.remember(farmerId, {
      kind: "offer_gap",
      content: `Trader offer of ${Math.round(offer)} KES per 90 kg bag is ${Math.round(gap)} KES versus the ${county} P50 benchmark of ${Math.round(benchmark)} KES.`,
      payload: { offer_per_bag: offer, benchmark_p50: benchmark, gap, as_of: state.today },
    });
  }
  traceEvent({
    action: "remember",
    input_summary: farmerId,
    output_summary: `stored profile verdict=${response.verdict} offer_gap=${gap === null ? "none" : Math.round(gap)}`,
    target_agent: null,
    confidence: response.confidence,
    retry_count: 0,
    status: "success",
  });
}
