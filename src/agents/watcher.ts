import { readFarmerLedger } from "../adapters/zetaris.js";
import { chat } from "../adapters/meterless.js";
import type { CaseState, PriorVerdict, RunResponse } from "../schemas.js";
import { latestClaim } from "../orchestration/state.js";
import { traceEvent } from "../tracing.js";
import { isTwoPlainSentences, limitToTwoPlainSentences, plainText } from "../wording.js";

export interface RecheckView {
  verdict: "sell" | "hold" | "split" | "no_recommendation";
  forecast_rain_mm_7d: number | null;
}

export function describeRecheck(prior: RecheckView | null, current: { verdict: string; rain_mm_7d: number }): { flipped: boolean; summary: string } {
  if (!prior) return { flipped: false, summary: "No prior verdict was stored for this farmer." };
  const worsened = prior.forecast_rain_mm_7d !== null && current.rain_mm_7d >= prior.forecast_rain_mm_7d + 10;
  const flipped = prior.verdict === "hold" && current.verdict === "sell" && worsened;
  if (flipped) {
    return {
      flipped: true,
      summary: `Prior HOLD is not supported. 7-day rain moved from ${prior.forecast_rain_mm_7d} mm to ${current.rain_mm_7d} mm and the computed action is SELL.`,
    };
  }
  return {
    flipped: false,
    summary: `Prior verdict was ${prior.verdict}. Computed verdict is ${current.verdict}. 7-day rain is ${current.rain_mm_7d} mm.`,
  };
}

export async function loadPrior(state: CaseState): Promise<void> {
  const remembered = [...state.memory_recall].reverse().find((record) => record.kind === "verdict" || record.kind === "prior_verdict");
  const fromMemory = remembered ? priorFromPayload(remembered.payload, remembered.created_at, `hmem:${remembered.farmer_id}`) : null;
  if (fromMemory) {
    state.prior = fromMemory;
  } else {
    const ledger = await readFarmerLedger(state.request.farmer_id);
    state.sources.ledger = ledger.via;
    if (ledger.via === "sample" && ledger.synthetic && !state.synthetic_inputs.includes("ledger")) {
      state.synthetic_inputs.push("ledger");
    }
    const entry = [...ledger.value].reverse().find((item) => item.record_type === "prior_verdict" && item.verdict);
    if (entry && entry.verdict) {
      state.prior = {
        verdict: entry.verdict,
        as_of: entry.as_of,
        forecast_rain_mm_7d: entry.forecast_rain_mm_7d ?? null,
        source: ledger.evidenceSource,
      };
    }
  }
  traceEvent({
    action: "load_prior",
    input_summary: state.request.farmer_id,
    output_summary: state.prior ? `prior=${state.prior.verdict} as_of=${state.prior.as_of} rain=${state.prior.forecast_rain_mm_7d ?? "n/a"}` : "no prior verdict",
    target_agent: "Planner",
    confidence: null,
    retry_count: 0,
    status: state.prior ? "success" : "partial_success",
  });
}

export async function annotateRecheck(state: CaseState, response: RunResponse): Promise<RunResponse> {
  const storage = latestClaim(state, "StorageWeatherAnalyst");
  const rain = storage && typeof storage.payload.total_rain_mm === "number" ? storage.payload.total_rain_mm : 0;
  const view = state.prior
    ? { verdict: state.prior.verdict, forecast_rain_mm_7d: state.prior.forecast_rain_mm_7d }
    : null;
  const finding = describeRecheck(view, { verdict: response.verdict, rain_mm_7d: rain });
  const note = await chat({
    agent: "Watcher",
    system: "Write exactly two sentences comparing a prior maize verdict with a new computed verdict. Do not invent a different action. No markdown.",
    user: `${finding.summary} Computed verdict: ${response.verdict}.`,
  });
  if (note.fallback) state.narrative_fallback = true;
  const plainModel = plainText(note.text);
  const plain = !note.fallback && !note.wordingRejected && isTwoPlainSentences(plainModel) && plainModel.toLowerCase().includes(response.verdict)
    ? limitToTwoPlainSentences(plainModel)
    : limitToTwoPlainSentences(response.plain_reply);
  traceEvent({
    action: "recheck",
    input_summary: state.prior ? `prior=${state.prior.verdict}` : "no prior",
    output_summary: finding.summary,
    target_agent: "Planner",
    confidence: response.confidence,
    retry_count: 0,
    status: finding.flipped ? "success" : "partial_success",
  });
  return {
    ...response,
    plain_reply: plain,
    reasoning_trace_summary: `${finding.summary} ${response.reasoning_trace_summary}`.slice(0, 1400),
    what_would_change_this_advice: finding.flipped
      ? [`The recheck changed the stance because rain rose from ${state.prior?.forecast_rain_mm_7d ?? "an unknown"} mm to ${rain} mm.`, ...response.what_would_change_this_advice]
      : response.what_would_change_this_advice,
  };
}

function priorFromPayload(payload: Record<string, unknown>, createdAt: string, source: string): PriorVerdict | null {
  const verdict = payload.verdict;
  if (verdict !== "sell" && verdict !== "hold" && verdict !== "split" && verdict !== "no_recommendation") return null;
  const rain = payload.forecast_rain_mm_7d;
  return {
    verdict,
    as_of: typeof payload.as_of === "string" ? payload.as_of : createdAt.slice(0, 10),
    forecast_rain_mm_7d: typeof rain === "number" ? rain : null,
    source,
  };
}
