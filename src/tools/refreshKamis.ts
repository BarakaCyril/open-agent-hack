import fs from "node:fs";
import path from "node:path";
import type { PgClient } from "../adapters/maizePg.js";
import { upsertKamisRows } from "../adapters/maizePg.js";
import { clearReadCache } from "../adapters/zetaris.js";
import type { KamisRow } from "../adapters/sampleData.js";
import { traceEvent } from "../tracing.js";
import { parseKamisWorkbook } from "./kamisSheet.js";
import {
  KAMIS_EXPORT_ORIGIN,
  LIVE_USER_AGENT,
  REQUEST_GAP_MS,
  positiveInt,
  type FetchLike,
  type RefreshReport,
} from "./refreshReport.js";
import { recordRefreshSuccess, refreshBlockReason, traceRefreshSkipped, traceRefreshUnavailable, type RefreshGateOptions } from "./refreshState.js";

export interface KamisRefreshOptions extends RefreshGateOptions {
  fetch?: FetchLike;
  pauseMs?: number;
  maxPages?: number;
  perPage?: number;
  cacheDir?: string;
  retryCount?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected by tests. Production uses MAIZE_PG_* from the environment. */
  pg?: PgClient;
}

const ALLOWED_PAGE_SIZES = [10, 50, 100, 500, 1500, 3000];

export function kamisExportUrl(offset: number, perPage: number): string {
  const root = offset > 0 ? `${KAMIS_EXPORT_ORIGIN}/site/market/${offset}` : `${KAMIS_EXPORT_ORIGIN}/site/market`;
  return `${root}?product=1&per_page=${perPage}&export=excel`;
}

export function robotsAllows(body: string, targetPath: string): boolean {
  let applies = false;
  let sawAgent = false;
  const disallows: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([^:]+):\s*(.*)$/u.exec(trimmed);
    if (!match) continue;
    const key = match[1]?.trim().toLowerCase() ?? "";
    const value = match[2]?.trim() ?? "";
    if (key === "user-agent") {
      if (sawAgent && applies) break;
      applies = value === "*";
      sawAgent = true;
      continue;
    }
    if (applies && key === "disallow" && value) disallows.push(value);
  }
  return !disallows.some((rule) => {
    const prefix = rule.endsWith("*") ? rule.slice(0, -1) : rule;
    return targetPath === rule || targetPath.startsWith(prefix);
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const KAMIS_REQUEST_HEADERS = { "User-Agent": LIVE_USER_AGENT, Accept: "*/*" };

/** robots.txt is fetched before any market page. HTTP 404 means the site published no rules. */
export async function readKamisRobots(fetchImpl: FetchLike): Promise<{ status: "allow"; body: string } | { status: "deny"; detail: string }> {
  try {
    const response = await fetchImpl(`${KAMIS_EXPORT_ORIGIN}/robots.txt`, { headers: KAMIS_REQUEST_HEADERS });
    const robots = await response.text();
    const missingFile = response.status === 404;
    if (!missingFile && !response.ok) {
      return { status: "deny", detail: `robots.txt could not be read (HTTP ${response.status}).` };
    }
    if (!missingFile && !robotsAllows(robots, "/site/market")) {
      return { status: "deny", detail: "robots.txt disallows /site/market." };
    }
    return { status: "allow", body: robots };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request failed";
    return { status: "deny", detail: `robots.txt could not be read. ${detail}` };
  }
}

function traceRefresh(report: RefreshReport, retryCount: number): void {
  traceEvent({
    action: "refresh_kamis",
    input_summary: "KAMIS dry maize export, product 1, via the market page Export to Excel link.",
    output_summary: `rows fetched ${report.fetched}, rows stored ${report.stored}, rejected ${report.rejected}, status ${report.status}. ${report.detail}`,
    target_agent: "MarketAnalyst",
    confidence: null,
    retry_count: retryCount,
    status: report.status === "success" ? "success" : report.status === "fallback" ? "fallback" : "error",
  });
}

function skipped(detail: string, retryCount: number): RefreshReport {
  traceRefreshSkipped("kamis", detail, retryCount, "MarketAnalyst");
  return { status: "skipped", fetched: 0, stored: 0, rejected: 0, detail };
}

function unavailable(detail: string, retryCount: number): RefreshReport {
  const report: RefreshReport = { status: "fallback", fetched: 0, stored: 0, rejected: 0, detail, unavailable: true };
  traceRefresh(report, retryCount);
  traceRefreshUnavailable(detail, retryCount, "MarketAnalyst");
  return report;
}

export async function refreshKamis(options: KamisRefreshOptions = {}): Promise<RefreshReport> {
  const retryCount = options.retryCount ?? 0;
  const blocked = refreshBlockReason("kamis", options);
  if (blocked) return skipped(blocked, retryCount);
  const pauseMs = options.pauseMs ?? REQUEST_GAP_MS;
  const perPage = ALLOWED_PAGE_SIZES.includes(options.perPage ?? 0)
    ? options.perPage ?? 100
    : positiveInt(process.env.KAMIS_PER_PAGE, 100, 3000);
  const pageSize = ALLOWED_PAGE_SIZES.includes(perPage) ? perPage : 100;
  const maxPages = options.maxPages ?? positiveInt(process.env.KAMIS_MAX_PAGES, 2, 10);
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const cacheDir = options.cacheDir ?? path.join(process.cwd(), "data", "cache", "kamis");
  const headers = KAMIS_REQUEST_HEADERS;
  const robots = await readKamisRobots(fetchImpl);
  if (robots.status === "deny") {
    const report: RefreshReport = { status: "error", fetched: 0, stored: 0, rejected: 0, detail: robots.detail };
    traceRefresh(report, retryCount);
    return report;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "robots.txt"), robots.body);
  const rows: KamisRow[] = [];
  let rejected = 0;
  let failedPages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    if (pauseMs > 0) await sleep(pauseMs);
    const offset = page * pageSize;
    const url = kamisExportUrl(offset, pageSize);
    try {
      const response = await fetchImpl(url, { headers });
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(path.join(cacheDir, `export-${offset}-per-${pageSize}.xls`), bytes);
      if (!response.ok) {
        failedPages += 1;
        continue;
      }
      const parsed = parseKamisWorkbook(bytes);
      rows.push(...parsed.rows);
      rejected += parsed.rejected;
    } catch {
      failedPages += 1;
    }
  }
  if (rows.length === 0) {
    const report: RefreshReport = {
      status: "error",
      fetched: 0,
      stored: 0,
      rejected,
      detail: failedPages > 0 ? "The KAMIS export could not be read." : "The KAMIS export had no valid rows.",
    };
    traceRefresh(report, retryCount);
    return report;
  }
  try {
    const stored = await upsertKamisRows(rows, options.pg);
    clearReadCache();
    const report: RefreshReport = {
      status: failedPages > 0 ? "fallback" : "success",
      fetched: rows.length,
      stored,
      rejected,
      detail: failedPages > 0
        ? `${failedPages} export page(s) failed. Valid rows were written. Rejected ${rejected} malformed row(s).`
        : `Rejected ${rejected} malformed row(s).`,
    };
    if (report.status === "success") recordRefreshSuccess("kamis", options.now ?? new Date(), options.stateFile);
    traceRefresh(report, retryCount);
    return report;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Prices were not written.";
    const hostDown = /ECONNREFUSED|ENOTFOUND|authentication failed|connect E|password/u.test(detail);
    const report: RefreshReport = {
      status: "fallback",
      fetched: rows.length,
      stored: 0,
      rejected,
      detail,
      unavailable: hostDown,
    };
    traceRefresh(report, retryCount);
    if (hostDown) traceRefreshUnavailable(detail, retryCount, "MarketAnalyst");
    return report;
  }
}
