import { readRules, readWeather } from "../adapters/zetaris.js";
import { chat } from "../adapters/meterless.js";
import { loadConfig } from "../config.js";
import type { CaseState } from "../schemas.js";
import { expectedLoss, heavyRainMmMin } from "../tools/spoilage.js";
import { describeEvidence, pct, roundTo, setSyntheticInput } from "../orchestration/state.js";
import { traceEvent } from "../tracing.js";

export async function analyzeStorage(state: CaseState): Promise<void> {
  const { county, storage } = state.request;
  const weatherHit = await readWeather(county);
  const rulesHit = await readRules();
  state.sources.weather = weatherHit.via;
  state.sources.rules = rulesHit.via;
  setSyntheticInput(state, "weather", weatherHit.via === "sample" || weatherHit.synthetic);
  setSyntheticInput(state, "rules", rulesHit.synthetic);

  const series = weatherHit.value;
  const forecast = series?.days ?? [];
  let loss: ReturnType<typeof expectedLoss> | null = null;
  let failure = "";
  try {
    loss = expectedLoss(storage, forecast, rulesHit.value);
  } catch (error) {
    failure = error instanceof Error ? error.message : "loss model failed";
  }

  const liveForecast = series?.source === "open-meteo";
  const asOf = liveForecast ? state.today : (series?.as_of ?? "");
  const staleDays = loadConfig().STALE_DAYS;
  const statement = loss
    ? `${storage} in ${county}: expected loss over ${loss.days} forecast days is ${pct(loss.mean)} (band ${pct(loss.p10)} to ${pct(loss.p90)}). Rain total ${loss.totalRainMm.toFixed(0)} mm. Rules matched on ${loss.rulesMatched} days.`
    : `No loss distribution for ${storage} in ${county}: ${failure}.`;

  const note = await chat({
    agent: "StorageWeatherAnalyst",
    system: "You comment on storage loss figures. Use only the user message. Do not choose sell, hold, or split. One or two sentences.",
    user: statement,
  });
  if (note.fallback) state.narrative_fallback = true;

  const implausible = forecast.some((day) => day.rain_mm > 200 || day.rain_mm < 0 || day.humidity_pct > 100 || day.humidity_pct < 0);
  state.claims.push({
    id: `storage-r${state.revision_counts.storage}-n${state.claims.length}`,
    agent: "StorageWeatherAnalyst",
    statement: note.fallback || !note.text ? statement : `${statement} Note: ${note.text.slice(0, 400)}`,
    evidence: loss
      ? [
          describeEvidence(
            series?.source === "open-meteo" ? "open-meteo" : "synthetic",
            weatherHit.evidenceSource,
            asOf,
            state.today,
            staleDays,
            weatherHit.synthetic || series?.source !== "open-meteo",
          ),
          describeEvidence("synthetic", rulesHit.evidenceSource, "", state.today, staleDays, true),
        ]
      : [],
    confidence: loss ? roundTo(loss.rulesMatched === forecast.length && forecast.length > 0 ? 0.8 : 0.35) : 0,
    payload: {
      storage,
      loss_mean: loss?.mean ?? null,
      loss_p10: loss?.p10 ?? null,
      loss_p90: loss?.p90 ?? null,
      days: loss?.days ?? forecast.length,
      rules_matched: loss?.rulesMatched ?? 0,
      total_rain_mm: loss?.totalRainMm ?? forecast.reduce((sum, day) => sum + day.rain_mm, 0),
      daily_rain_mm: forecast.map((day) => day.rain_mm),
      heavy_rain_mm_min: heavyRainMmMin(storage, rulesHit.value),
      forecast_as_of: asOf || "undated",
      forecast_days: forecast.length,
      implausible_forecast: implausible,
      error: failure || null,
    },
    status: "pending",
    revision: state.revision_counts.storage,
  });

  traceEvent({
    action: "claim",
    input_summary: `${county} ${storage} days=${forecast.length}`,
    output_summary: loss ? `loss=${pct(loss.mean)} rain=${loss.totalRainMm.toFixed(0)}` : failure,
    target_agent: "RiskCritic",
    confidence: loss ? 0.8 : 0,
    retry_count: state.revision_counts.storage,
    status: loss ? "success" : "error",
  });
}
