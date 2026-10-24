export interface PricePoint {
  date: string;
  price: number;
}

export interface PriceStats {
  p10: number;
  p50: number;
  p90: number;
  n: number;
  outliersRemoved: number;
  outlierCount: number;
  latest: number;
  latestDate: string;
  oldestDate: string;
  slopePerDay: number;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) throw new Error("no price rows");
  if (sorted.length === 1) return sorted[0] ?? 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const lower = sorted[lo] ?? sorted[0] ?? 0;
  const upper = sorted[hi] ?? lower;
  const weight = pos - lo;
  return lower * (1 - weight) + upper * weight;
}

export function outlierMask(values: number[]): boolean[] {
  if (values.length < 4) return values.map(() => false);
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) {
    const median = quantile(sorted, 0.5);
    return values.map((value) => Math.abs(value - median) / Math.max(Math.abs(median), 1) > 0.5);
  }
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  return values.map((value) => value < low || value > high);
}

export function slopePerDay(points: PricePoint[]): number {
  const dated = points
    .map((point) => ({ t: Date.parse(point.date), price: point.price }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.price));
  if (dated.length < 2) return 0;
  const origin = dated[0]?.t ?? 0;
  const xs = dated.map((point) => (point.t - origin) / 86_400_000);
  const ys = dated.map((point) => point.price);
  const n = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (xs[i] ?? 0) - meanX;
    const y = (ys[i] ?? 0) - meanY;
    numerator += x * y;
    denominator += x * x;
  }
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function cleanAndSummarize(points: PricePoint[], options?: { keepOutliers?: boolean }): PriceStats {
  const valid = points.filter((point) => Number.isFinite(point.price) && point.price > 0 && point.date.length >= 10);
  if (valid.length === 0) throw new Error("no price rows");
  const mask = outlierMask(valid.map((point) => point.price));
  const kept = valid.filter((_, index) => !mask[index]);
  const retain = options?.keepOutliers === true;
  const used = retain || kept.length === 0 ? valid : kept;
  const prices = used.map((point) => point.price).sort((a, b) => a - b);
  const ordered = [...used].sort((a, b) => a.date.localeCompare(b.date));
  const latestPoint = ordered[ordered.length - 1];
  const oldestPoint = ordered[0];
  if (!latestPoint || !oldestPoint) throw new Error("no price rows");
  return {
    p10: quantile(prices, 0.1),
    p50: quantile(prices, 0.5),
    p90: quantile(prices, 0.9),
    n: used.length,
    outliersRemoved: retain ? 0 : valid.length - used.length,
    outlierCount: mask.filter(Boolean).length,
    latest: latestPoint.price,
    latestDate: latestPoint.date.slice(0, 10),
    oldestDate: oldestPoint.date.slice(0, 10),
    slopePerDay: slopePerDay(ordered),
  };
}

export type PriceTrend = "rising" | "falling" | "flat";

export function trendOf(slope: number): PriceTrend {
  if (slope > 5) return "rising";
  if (slope < -5) return "falling";
  return "flat";
}

/** Shift the observed band forward. The caller passes the result into expected value. */
export function projectPriceBand(
  stats: Pick<PriceStats, "p10" | "p50" | "p90" | "latest" | "slopePerDay">,
  holdDays: number,
  damp = 0.45,
): { p10: number; p50: number; p90: number } {
  const center = stats.latest + stats.slopePerDay * damp * holdDays;
  const halfSpread = Math.max(stats.p90 - stats.p50, stats.p50 - stats.p10, 1);
  return {
    p10: Math.max(0, center - halfSpread),
    p50: center,
    p90: center + halfSpread,
  };
}
