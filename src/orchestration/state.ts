import { randomUUID } from "node:crypto";
import type { CaseState, Claim, RunRequest } from "../schemas.js";

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function daysBetween(earlier: string, later: string): number {
  const a = parseIsoDate(earlier);
  const b = parseIsoDate(later);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

export function addDays(isoDate: string, days: number): string {
  const base = parseIsoDate(isoDate);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A price window is mixed when the oldest quote and the newest quote are more than 21 days apart.
 * The percentile band then blends a stale quote with a current one, so it is not one market moment.
 */
export const MIXED_PRICE_WINDOW_DAYS = 21;

export function mixedAgeNote(oldest: string, latest: string): string | null {
  const span = daysBetween(oldest, latest);
  if (!Number.isFinite(span) || span <= MIXED_PRICE_WINDOW_DAYS) return null;
  return `Mixed-age prices: the quotes used here run from ${oldest} to ${latest} (${span} days). A window longer than 21 days blends a stale quote into the same band as a current one.`;
}

export function freshnessLabel(asOf: string, today: string, staleDays = 3): string {
  const age = daysBetween(asOf, today);
  if (!Number.isFinite(age)) return "unknown";
  if (age <= 0) return "same-day";
  if (age > staleDays) return `stale-${age}d`;
  return `${age}d`;
}

/** Evidence names the origin, the route the row was read from, and the age of that row. */
export function describeEvidence(
  origin: string,
  route: string,
  asOf: string,
  today: string,
  staleDays = 3,
  synthetic = false,
): { source: string; as_of: string; freshness: string; synthetic: boolean } {
  const dated = /^\d{4}-\d{2}-\d{2}/u.test(asOf) ? asOf.slice(0, 10) : "";
  const fixture = origin.startsWith("fixture:") || route.startsWith("fixture:");
  const labelledSynthetic = synthetic || /synthetic/iu.test(origin) || /synthetic/iu.test(route);
  const realOrigin = origin === "kamis" || origin === "open-meteo" || origin === "market-news";
  let named = origin;
  if (fixture && !origin.startsWith("fixture:")) named = `fixture:${route}`;
  else if (realOrigin && (labelledSynthetic || fixture)) named = labelledSynthetic ? "synthetic" : "fixture";
  const source = named.startsWith("fixture:") ? named : `${named} via ${route}`;
  return {
    source,
    as_of: dated || "undated",
    freshness: dated ? freshnessLabel(dated, today, staleDays) : "undated",
    synthetic: labelledSynthetic,
  };
}

export function createInitialState(request: RunRequest, traceId = randomUUID(), today = todayIso()): CaseState {
  return {
    trace_id: traceId,
    question: `Sell, hold, or split ${request.bags} bags of white maize for ${request.farmer_id} in ${request.county}?`,
    request,
    today,
    memory_recall: [],
    claims: [],
    critic_decisions: [],
    last_decision: null,
    revision_counts: { total: 0, market: 0, storage: 0 },
    refresh_counts: { total: 0, market: 0, storage: 0 },
    round: 0,
    coverage: {
      price_rows: 0,
      fresh_price_rows: 0,
      thin: false,
      blocking: false,
      note: "",
    },
    prior: null,
    escalation: null,
    approved: false,
    sources: {},
    synthetic_inputs: [],
    narrative_fallback: false,
    refresh_limits: [],
  };
}

export function latestClaim(state: CaseState, agent: string): Claim | undefined {
  for (let i = state.claims.length - 1; i >= 0; i -= 1) {
    const claim = state.claims[i];
    if (claim && claim.agent === agent) return claim;
  }
  return undefined;
}

export function roundTo(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function kes(value: number): string {
  return Math.round(value).toLocaleString("en-KE");
}

export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
