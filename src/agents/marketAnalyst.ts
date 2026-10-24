import { readNews, readPrices } from "../adapters/zetaris.js";
import { chat } from "../adapters/meterless.js";
import { loadConfig } from "../config.js";
import { isWhiteMaizeBag, type NewsItem } from "../adapters/sampleData.js";
import type { CaseState } from "../schemas.js";
import { DIRTY_FIXTURE_SOURCE, loadDirtyFixture } from "../tools/dirtyFixture.js";
import { cleanAndSummarize, trendOf, type PriceStats, type PriceTrend } from "../tools/prices.js";
import { daysBetween, describeEvidence, kes, roundTo } from "../orchestration/state.js";
import { traceEvent } from "../tracing.js";

const FRESH_DAYS = 14;

function disagrees(trend: PriceTrend, direction: string): boolean {
  return (trend === "rising" && direction === "down") || (trend === "falling" && direction === "up");
}

function rememberSource(state: CaseState, key: "prices" | "news", via: "zetaris" | "sample", synthetic: boolean, label: string): void {
  state.sources[key] = via;
  if (via === "sample" && synthetic && !state.synthetic_inputs.includes(label)) state.synthetic_inputs.push(label);
}

export async function analyzeMarket(state: CaseState): Promise<void> {
  const { county } = state.request;
  const reasons = new Set(state.last_decision?.reasons ?? []);
  const prices = await readPrices(county);
  rememberSource(state, "prices", prices.via, prices.synthetic, "prices");
  const newsHit = await readNews(county);
  rememberSource(state, "news", newsHit.via, newsHit.synthetic, "news");

  const white = prices.value.filter((row) => isWhiteMaizeBag(row));
  const windowed = white.filter((row) => {
    const age = daysBetween(row.market_date, state.today);
    const limit = reasons.has("freshness") ? 7 : FRESH_DAYS;
    return Number.isFinite(age) && age >= 0 && age <= limit;
  });
  const fixture = state.request.fixture === "dirty" ? loadDirtyFixture() : null;
  const planted = fixture?.prices.filter((row) => row.county.toLowerCase() === county.toLowerCase()) ?? [];
  windowed.push(...planted);
  let stats: PriceStats | null = null;
  try {
    const points = windowed.map((row) => ({ date: row.market_date, price: row.wholesale_price_kes }));
    stats = cleanAndSummarize(points, { keepOutliers: planted.length > 0 });
    if (stats && planted.length > 0) {
      stats = { ...stats, outlierCount: Math.max(stats.outlierCount, planted.length), outliersRemoved: 0 };
    }
  } catch {
    stats = null;
  }
  if (!stats) {
    state.claims.push({
      id: `market-empty-${state.claims.length}`,
      agent: "MarketAnalyst",
      statement: `No cleaned white-maize quotes were available for ${county} in the price window.`,
      evidence: [],
      confidence: 0,
      payload: {
        n: 0,
        outliers_removed: 0,
        outlier_count: 0,
        unresolved_conflict: false,
        news: [],
        error: "no price rows",
      },
      status: "pending",
      revision: state.revision_counts.market,
    });
    traceEvent({
      action: "claim",
      input_summary: `${county} rows=${white.length} window=${windowed.length}`,
      output_summary: "no price rows in the window",
      target_agent: "RiskCritic",
      confidence: 0,
      retry_count: state.revision_counts.market,
      status: "error",
    });
    return;
  }
  const trend = trendOf(stats.slopePerDay);
  const suppressRumors = reasons.has("contradiction") || reasons.has("maize_type_mismatch");
  const scoped = newsHit.value.filter((item) => item.maize_type === "white");
  const whiteNews = suppressRumors
    ? scoped.filter((item) => !(item.status === "announced" && disagrees(trend, item.direction)))
    : scoped;
  const fixtureNews = (fixture?.news ?? []).filter((item) => item.county === "national" || item.county.toLowerCase() === county.toLowerCase());
  const kept = [...whiteNews, ...fixtureNews];
  const unresolved = kept.some((item) => disagrees(trend, item.direction));
  const offer = state.request.offer_per_bag;
  const statement = [
    `${county} white maize, ${stats.n} cleaned quotes in the window: P10 ${kes(stats.p10)}, P50 ${kes(stats.p50)}, P90 ${kes(stats.p90)} KES per 90 kg bag.`,
    `Latest quote ${kes(stats.latest)} KES on ${stats.latestDate}. Slope ${stats.slopePerDay.toFixed(1)} KES per day (${trend}).`,
    offer == null ? "No buyer offer was supplied." : `The offer of ${kes(offer)} KES is ${kes(offer - stats.p50)} KES against the P50.`,
    `Removed ${stats.outliersRemoved} outlier quote(s). News items kept: ${kept.map((item) => item.id).join(", ") || "none"}.`,
  ].join(" ");

  const note = await modelNote(
    "MarketAnalyst",
    "You comment on white-maize price figures for a Kenyan farmer. Use only the numbers in the user message. Do not choose sell, hold, or split. Two short sentences.",
    statement,
    state,
  );

  const newestWhite = whiteNews.reduce<string | null>((latest, item) => {
    if (!item.as_of) return latest;
    if (!latest || item.as_of > latest) return item.as_of;
    return latest;
  }, null);
  const staleDays = loadConfig().STALE_DAYS;
  const evidence = [];
  if (planted.length > 0 || fixtureNews.length > 0) {
    evidence.push(describeEvidence(DIRTY_FIXTURE_SOURCE, DIRTY_FIXTURE_SOURCE, stats.latestDate, state.today, staleDays));
  }
  if (planted.length === 0) {
    evidence.push(describeEvidence("kamis", prices.evidenceSource, stats.latestDate, state.today, staleDays));
  }
  if (whiteNews.length > 0) {
    evidence.push(describeEvidence(
      newsOrigin(newsHit, whiteNews),
      newsHit.evidenceSource,
      newestWhite ?? "",
      state.today,
      staleDays,
    ));
  }

  state.claims.push({
    id: `market-r${state.revision_counts.market}-f${state.refresh_counts.market}-n${state.claims.length}`,
    agent: "MarketAnalyst",
    statement: note ? `${statement} Note: ${note}` : statement,
    evidence,
    confidence: roundTo(Math.max(0, Math.min(1, stats.n / 10))),
    payload: {
      p10: stats.p10,
      p50: stats.p50,
      p90: stats.p90,
      n: stats.n,
      outliers_removed: stats.outliersRemoved,
      outlier_count: stats.outlierCount,
      latest: stats.latest,
      latest_date: stats.latestDate,
      oldest_date: stats.oldestDate,
      slope_per_day: stats.slopePerDay,
      trend,
      unresolved_conflict: unresolved,
      offer_gap: offer == null ? null : offer - stats.p50,
      news: kept.map((item) => newsPayload(item)),
    },
    status: "pending",
    revision: state.revision_counts.market,
  });

  traceEvent({
    action: "claim",
    input_summary: `${county} rows=${white.length} window=${windowed.length}`,
    output_summary: `n=${stats.n} p50=${Math.round(stats.p50)} trend=${trend} conflict=${unresolved}`,
    target_agent: "RiskCritic",
    confidence: roundTo(Math.max(0, Math.min(1, stats.n / 10))),
    retry_count: state.revision_counts.market + state.refresh_counts.market,
    status: unresolved ? "needs_revision" : "success",
  });
}

function newsOrigin(hit: { synthetic: boolean; evidenceSource: string }, items: NewsItem[]): string {
  // Sample ids are n1, n2, and so on. The Zetaris news view does not project the file's synthetic flag,
  // so those ids stay labelled synthetic-news. A row with any other id can be market-news.
  if (hit.synthetic || hit.evidenceSource.includes("news.json")) return "synthetic-news";
  if (items.length > 0 && items.every((item) => /^n\d+$/u.test(item.id))) return "synthetic-news";
  return "market-news";
}

function newsPayload(item: NewsItem): Record<string, unknown> {
  return {
    id: item.id,
    maize_type: item.maize_type,
    status: item.status,
    direction: item.direction,
    as_of: item.as_of,
  };
}

async function modelNote(agent: string, system: string, user: string, state: CaseState): Promise<string | null> {
  const result = await chat({ agent, system, user });
  if (result.fallback) {
    state.narrative_fallback = true;
    return null;
  }
  return result.text.slice(0, 400);
}
