import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../config.js";
import { traceEvent } from "../tracing.js";

export interface RefreshGateOptions {
  enabled?: boolean;
  ttlMinutes?: number;
  stateFile?: string;
  now?: Date;
}

interface RefreshClock {
  kamis?: string;
  weather?: Record<string, string>;
}

export function refreshStateFile(override?: string): string {
  return override ?? path.join(projectRoot(), "data", "cache", "refresh_state.json");
}

export function refreshEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  return process.env.REFRESH_ENABLED !== "false";
}

export function refreshTtlMinutes(override?: number): number {
  if (override !== undefined) return override;
  const parsed = Number(process.env.REFRESH_TTL_MINUTES);
  if (!Number.isInteger(parsed) || parsed < 0) return 360;
  return parsed;
}

function readClock(file: string): RefreshClock {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RefreshClock;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sourceStamp(clock: RefreshClock, source: string): string | undefined {
  if (source === "kamis") return clock.kamis;
  if (source.startsWith("weather:")) return clock.weather?.[source.slice("weather:".length)];
  return undefined;
}

/** Skip the network when refresh is off, or the last successful pull is still inside the TTL. */
export function refreshBlockReason(source: string, options: RefreshGateOptions = {}): string | null {
  if (!refreshEnabled(options.enabled)) return "REFRESH_ENABLED is false.";
  const ttl = refreshTtlMinutes(options.ttlMinutes);
  const stamp = sourceStamp(readClock(refreshStateFile(options.stateFile)), source);
  if (!stamp) return null;
  const at = Date.parse(stamp);
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(at)) return null;
  const ageMinutes = (now - at) / 60_000;
  if (ageMinutes < ttl) {
    return `Last successful ${source} refresh at ${stamp} is newer than REFRESH_TTL_MINUTES (${ttl}).`;
  }
  return null;
}

export function recordRefreshSuccess(source: string, at: Date, stateFile?: string): void {
  const file = refreshStateFile(stateFile);
  const clock = readClock(file);
  const stamp = at.toISOString();
  if (source === "kamis") clock.kamis = stamp;
  else if (source.startsWith("weather:")) {
    const county = source.slice("weather:".length);
    clock.weather = { ...clock.weather, [county]: stamp };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(clock, null, 2)}\n`);
}

export function traceRefreshSkipped(source: string, reason: string, retryCount: number, target: string): void {
  traceEvent({
    action: "refresh_skipped",
    input_summary: source,
    output_summary: reason,
    target_agent: target,
    confidence: null,
    retry_count: retryCount,
    status: "success",
  });
}

export function traceRefreshUnavailable(reason: string, retryCount: number, target: string): void {
  traceEvent({
    action: "refresh_unavailable",
    input_summary: reason,
    output_summary: `refresh_unavailable: ${reason}`,
    target_agent: target,
    confidence: null,
    retry_count: retryCount,
    status: "fallback",
  });
}
