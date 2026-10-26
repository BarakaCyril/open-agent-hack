import { randomUUID } from "node:crypto";
import { loadConfig, redact, type AppConfig } from "../config.js";
import type { DataSource } from "../schemas.js";
import { currentContext, traceEvent } from "../tracing.js";
import { coverageFromQuoteCount, COVERAGE_WINDOW_DAYS, zetarisCountyQuoteSql } from "../tools/coverage.js";
import { loadCountyCatalog } from "../tools/counties.js";
import {
  finiteNumber,
  loadLedger,
  loadNews,
  loadPriceRows,
  loadRules,
  loadWeather,
  mapKamisRow,
  type KamisRow,
  type LedgerEntry,
  type NewsItem,
  type WeatherSeries,
} from "./sampleData.js";
import { chooseLatestSeries, type ForecastPoint } from "../tools/weatherSeries.js";
import type { StorageRule } from "../tools/spoilage.js";

let breakerTrippedUntil = 0;
let inMemoryZetarisToken: string | null = null;
let inMemoryZetarisOrgId: string | null = null;
export function isJwtExpired(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp === "number") return Date.now() >= payload.exp * 1000 - 60_000;
  } catch {
    return false;
  }
  return false;
}

function loginIdentity(config: AppConfig): { username: string; password: string } | null {
  const username = (config.ZETARIS_ADMIN_EMAIL || config.ZETARIS_USERNAME).trim();
  const password = config.ZETARIS_ADMIN_PASSWORD || config.ZETARIS_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

async function requestFreshToken(config: AppConfig, username: string, password: string): Promise<Response | null> {
  const rest = config.ZETARIS_REST_URL.replace(/\/+$/u, "");
  const attempts: Array<{ url: string; init: RequestInit }> = [];
  if (/\/api\/v1\.0$/i.test(new URL(rest).pathname)) {
    attempts.push({
      url: `${rest}/auth/login`,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Org-ID": config.ZETARIS_ORG_ID,
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        },
      },
    });
  }
  const stripped = rest.replace(/\/api\/proxy\/?$/i, "");
  attempts.push({
    url: `${stripped}/api/auth/login`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, password }),
    },
  });
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, { ...attempt.init, signal: AbortSignal.timeout(6000) });
      if (response.ok) return response;
    } catch {
      // Try the next login shape.
    }
  }
  return null;
}

export async function loginAndGetFreshToken(config: AppConfig): Promise<{ token: string; orgId: string } | null> {
  const identity = loginIdentity(config);
  if (!identity) return null;
  try {
    const res = await requestFreshToken(config, identity.username, identity.password);
    if (!res) return null;
    const data = await res.json() as { idToken?: string; orgId?: number | string };
    if (!data.idToken) return null;
    inMemoryZetarisToken = data.idToken;
    process.env.ZETARIS_API_KEY = data.idToken;
    const orgIdStr = String(data.orgId || config.ZETARIS_ORG_ID);
    if (data.orgId) inMemoryZetarisOrgId = orgIdStr;
    return { token: data.idToken, orgId: orgIdStr };
  } catch {
    return null;
  }
}

export function isBreakerOpen(): boolean {
  return Date.now() < breakerTrippedUntil;
}

export function resetBreaker(): void {
  breakerTrippedUntil = 0;
}

export class RemoteSourceError extends Error {
  readonly timeout: boolean;
  readonly retryable: boolean;
  /** No HTTP response: network failure, timeout, or an open circuit breaker. */
  readonly unreachable: boolean;

  constructor(message: string, options: { timeout?: boolean; retryable?: boolean; unreachable?: boolean } = {}) {
    super(message);
    this.name = "RemoteSourceError";
    this.timeout = options.timeout ?? false;
    this.retryable = options.retryable ?? false;
    this.unreachable = options.unreachable ?? false;
  }
}

/** Zetaris answered, and the table or statement failed. Never a reason to read sample files. */
export class ZetarisQueryError extends RemoteSourceError {
  readonly code = "zetaris_query_failed" as const;

  constructor(message: string) {
    super(message, { retryable: false, unreachable: false });
    this.name = "ZetarisQueryError";
  }
}

/** Zetaris did not answer. SAMPLE_MODE=false surfaces this as HTTP 503. */
export class ZetarisUnavailableError extends RemoteSourceError {
  readonly code = "zetaris_unavailable" as const;
  readonly statusCode = 503 as const;

  constructor(message: string) {
    super(message, { retryable: false, unreachable: true });
    this.name = "ZetarisUnavailableError";
  }
}

export interface SourceHit<T> {
  value: T;
  via: "zetaris" | "sample";
  synthetic: boolean;
  evidenceSource: string;
}

export const MAIZE_TABLES = {
  prices: {
    table: "kamis_prices",
    file: "kamis_dry_maize.csv",
    columns: "market_date, county, market_name, commodity, variety, grade, unit_kg, wholesale_price_kes, retail_price_kes, volume_bags",
  },
  weather: {
    table: "weather_daily",
    file: "weather.json",
    columns: "county, as_of, source, forecast_date, rain_mm, humidity_pct, temp_c",
  },
  news: {
    table: "market_news",
    file: "news.json",
    columns: "id, as_of, county, maize_type, status, direction, headline, commodity, synthetic",
  },
  rules: {
    table: "storage_loss_rules",
    file: "storage_loss_rules.csv",
    columns: "storage, rain_mm_min, humidity_min, daily_loss_pct, synthetic",
  },
  ledger: {
    table: "farmer_ledger",
    file: "farmer_ledger.json",
    columns: "farmer_id, county, as_of, record_type, verdict, hold_days, bags, storage, forecast_rain_mm_7d, notes, synthetic",
  },
} as const;

export function maizeFrom(table: string): string {
  return `maize.${table}`;
}

export function evidenceLabel(via: "zetaris" | "sample", table: string, file: string): string {
  return via === "zetaris" ? `zetaris:${table}` : `sample:${file}`;
}

type SourceFlags = {
  prices?: "zetaris" | "sample";
  weather?: "zetaris" | "sample";
  rules?: "zetaris" | "sample";
  news?: "zetaris" | "sample";
  ledger?: "zetaris" | "sample";
};

export function resolveDataSource(sources: SourceFlags, fallbackCount = 0): DataSource | null {
  const used = [sources.prices, sources.weather, sources.rules, sources.news, sources.ledger]
    .filter((value): value is "zetaris" | "sample" => value === "zetaris" || value === "sample");
  const live = used.includes("zetaris");
  const sample = used.includes("sample") || fallbackCount > 0;
  if (used.length === 0 && fallbackCount === 0) return null;
  if (live && sample) return "mixed";
  if (sample) return "sample";
  return "zetaris";
}

export function rowsFromZetarisBody(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object") throw new RemoteSourceError("Zetaris response was not JSON", { retryable: false });
  const record = body as { data?: unknown; headers?: unknown };
  const data = record.data;
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { rows?: unknown }).rows)
      ? (data as { rows: unknown[] }).rows
      : null;
  if (!rows) throw new RemoteSourceError("Zetaris response has no data array", { retryable: false });
  const headers = Array.isArray(record.headers) ? record.headers.map((header) => String(header)) : null;
  return rows.map((row) => {
    if (Array.isArray(row)) {
      if (!headers || headers.length === 0) {
        throw new RemoteSourceError("Zetaris row had no column headers", { retryable: false });
      }
      const named: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        named[header] = row[index];
      });
      return named;
    }
    if (row && typeof row === "object") return row as Record<string, unknown>;
    throw new RemoteSourceError("Zetaris row was not an object", { retryable: false });
  });
}

export async function cachedRows<T>(
  cache: Map<string, Promise<T>> | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  if (!cache) return { value: await load(), hit: false };
  const existing = cache.get(key);
  if (existing) return { value: await existing, hit: true };
  const pending = load();
  cache.set(key, pending);
  try {
    return { value: await pending, hit: false };
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkFailure(error: unknown): string {
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : null;
  const details = cause && typeof cause === "object" ? cause as Record<string, unknown> : {};
  const code = typeof details.code === "string" ? details.code : "";
  const address = typeof details.address === "string" ? details.address : "";
  const port = typeof details.port === "number" ? `:${details.port}` : "";
  return code ? `Zetaris connection failed (${code}${address ? ` ${address}${port}` : ""})` : "Zetaris connection failed (network error)";
}

export function assertSingleStatement(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/u, "");
  if (trimmed.includes(";")) throw new Error("Zetaris accepts one SQL statement per call");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only a single read-only SELECT is allowed");
  return trimmed;
}

function sqlString(value: string, label: string): string {
  if (!/^[\p{L}\p{N} .'_-]{1,80}$/u.test(value)) {
    throw new Error(`${label} was rejected as a SQL filter`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlSummary(sql: string): string {
  return sql.replace(/\s+/g, " ").slice(0, 140);
}

function traceSql(status: "success" | "retrying" | "error" | "fallback", sql: string, detail: string, rows: number, retry: number): void {
  traceEvent({
    action: "zetaris_sql",
    input_summary: redact(sqlSummary(sql)),
    output_summary: `rows=${rows} ${redact(detail)}`,
    target_agent: null,
    confidence: null,
    retry_count: retry,
    status,
  });
}

async function executeOnce(config: AppConfig, sql: string, limit: number, isRetry = false): Promise<Record<string, unknown>[]> {
  const url = `${config.ZETARIS_REST_URL.replace(/\/+$/u, "")}/sql-editor/sqls/run`;
  const timeoutMs = config.SOURCE_TIMEOUT_SECONDS * 1000;
  let token = inMemoryZetarisToken || config.ZETARIS_API_KEY;
  let orgId = inMemoryZetarisOrgId || config.ZETARIS_ORG_ID;
  if (!token || isJwtExpired(token)) {
    const fresh = await loginAndGetFreshToken(config);
    if (fresh) {
      token = fresh.token;
      orgId = fresh.orgId;
    } else {
      throw new RemoteSourceError(
        "Zetaris token is missing or expired. Set ZETARIS_API_KEY, or set ZETARIS_USERNAME and ZETARIS_PASSWORD for automatic refresh.",
        { retryable: false },
      );
    }
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-ID": orgId,
        "X-Request-ID": randomUUID(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        queryId: randomUUID(),
        sql,
        source: "SqlEditor",
        limit,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const cause = error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : null;
    const isRefused = cause && typeof cause === "object" && (cause as Record<string, unknown>).code === "ECONNREFUSED";
    throw new RemoteSourceError(
      timedOut ? `Zetaris timed out after ${config.SOURCE_TIMEOUT_SECONDS}s` : networkFailure(error),
      { timeout: timedOut, retryable: !timedOut && !isRefused, unreachable: true },
    );
  }
  const text = await response.text();
  if (!response.ok) {
    if (!isRetry && (response.status === 400 || response.status === 401)) {
      const fresh = await loginAndGetFreshToken(config);
      if (fresh) {
        return executeOnce(config, sql, limit, true);
      }
    }
    throw new RemoteSourceError(`Zetaris HTTP ${response.status}: ${redact(text).slice(0, 180)}`, {
      retryable: response.status >= 500 || response.status === 429,
      unreachable: false,
    });
  }
  try {
    return rowsFromZetarisBody(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof RemoteSourceError) throw error;
    throw new RemoteSourceError("Zetaris response was not JSON", { retryable: false });
  }
}

async function loadRows(statement: string, bounded: number): Promise<Record<string, unknown>[]> {
  if (isBreakerOpen()) {
    throw new RemoteSourceError("Zetaris is currently offline (circuit breaker open)", { retryable: false, unreachable: true });
  }
  const config = loadConfig();
  const attempts = config.MAX_RETRIES + 1;
  let last: RemoteSourceError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const rows = await executeOnce(config, statement, bounded);
      traceSql("success", statement, "ok", rows.length, attempt - 1);
      return rows;
    } catch (error) {
      const remote = error instanceof RemoteSourceError
        ? error
        : new RemoteSourceError(redact(error instanceof Error ? error.message : "zetaris failed"));
      last = remote;
      traceSql(remote.timeout ? "retrying" : "error", statement, remote.message, 0, attempt - 1);
      if (!remote.unreachable) throw remote;
      if (remote.timeout || !remote.retryable || attempt >= attempts) {
        breakerTrippedUntil = Date.now() + 20_000;
        throw remote;
      }
      await sleep(200 * 2 ** (attempt - 1));
    }
  }
  throw last ?? new RemoteSourceError("zetaris failed");
}

export function clearReadCache(): void {
  currentContext()?.queryCache.clear();
}

type SqlRunner = (sql: string, limit?: number) => Promise<Record<string, unknown>[]>;
let runnerOverride: SqlRunner | null = null;

/** Tests inject a client. Production reads go through the REST runner. */
export function setSqlRunnerForTests(runner: SqlRunner | null): void {
  runnerOverride = runner;
  resetBreaker();
}

export async function runSql(sql: string, limit = 500): Promise<Record<string, unknown>[]> {
  const statement = assertSingleStatement(sql);
  const bounded = Math.max(1, Math.min(5000, limit));
  if (runnerOverride) {
    try {
      const rows = await runnerOverride(statement, bounded);
      traceSql("success", statement, "ok", rows.length, 0);
      return rows;
    } catch (error) {
      if (error instanceof RemoteSourceError) {
        traceSql("error", statement, error.message, 0, 0);
        throw error;
      }
      const queryError = new ZetarisQueryError(redact(error instanceof Error ? error.message : "zetaris query failed"));
      traceSql("error", statement, queryError.message, 0, 0);
      throw queryError;
    }
  }
  const key = `${bounded}\n${statement}`;
  const { value, hit } = await cachedRows(currentContext()?.queryCache, key, () => loadRows(statement, bounded));
  if (hit) traceSql("success", statement, "cache", value.length, 0);
  return value;
}

/** One statement, including DDL used by scripts/setup_zetaris.ts. The password is redacted in errors. */
export async function executeStatement(sql: string): Promise<void> {
  const trimmed = sql.trim().replace(/;+\s*$/u, "");
  if (!trimmed) throw new Error("SQL statement is empty");
  if (trimmed.includes(";")) throw new Error("Zetaris accepts one SQL statement per call");
  try {
    await loadRows(trimmed, 50);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const isSelect = /^(select|with)\b/iu.test(trimmed);
    if (!isSelect && error instanceof RemoteSourceError && /no data array|was not JSON/iu.test(message)) return;
    throw error;
  }
}

export interface ZetarisTableCheck {
  table: string;
  status: "online" | "error";
  row_count?: number;
  detail?: string;
}

/** Read-only sponsor proof: confirm every table exists and report its row count without exposing credentials. */
export async function checkZetarisTables(query: typeof runSql = runSql): Promise<ZetarisTableCheck[]> {
  const results: ZetarisTableCheck[] = [];
  for (const { table } of Object.values(MAIZE_TABLES)) {
    try {
      // weather_daily is one Open-Meteo call per county. Count one county so a health check does not call the other six.
      const filter = table === "weather_daily" ? " WHERE county = 'Kirinyaga'" : "";
      const rows = await query(`SELECT COUNT(*) AS row_count FROM ${maizeFrom(table)}${filter}`, 1);
      const count = Number(rows[0]?.row_count);
      if (!Number.isFinite(count) || count < 0) {
        results.push({ table, status: "error", detail: "Count query returned no numeric row count." });
      } else {
        results.push({ table, status: "online", row_count: count });
      }
    } catch (error) {
      results.push({ table, status: "error", detail: redact(error instanceof Error ? error.message : "Zetaris query failed") });
    }
  }
  return results;
}

function markOffline(table: string, file: string, detail: string): void {
  const note = `offline mode: Zetaris unreachable, maize.${table} -> sample:${file}: ${detail}`;
  currentContext()?.markSampleFallback(note);
  traceEvent({
    action: "zetaris_sql",
    input_summary: redact(detail),
    output_summary: `offline mode sample:${file} after maize.${table} was unreachable`,
    target_agent: null,
    confidence: null,
    retry_count: 0,
    status: "fallback",
  });
}

async function readLive<T>(options: {
  table: string;
  file: string;
  sql: string;
  map: (rows: Record<string, unknown>[]) => T;
  sample: () => T;
  /** Sample-file rows are synthetic. Live rows use liveSynthetic. */
  sampleSynthetic: boolean;
  liveSynthetic: boolean;
}): Promise<SourceHit<T>> {
  const live = {
    via: "zetaris" as const,
    synthetic: options.liveSynthetic,
    evidenceSource: evidenceLabel("zetaris", options.table, options.file),
  };
  try {
    const rows = await runSql(options.sql, 500);
    return { value: options.map(rows), ...live };
  } catch (error) {
    const remote = error instanceof RemoteSourceError
      ? error
      : new ZetarisQueryError(error instanceof Error ? error.message : "zetaris query failed");
    if (!remote.unreachable) {
      throw new ZetarisQueryError(remote.message);
    }
    if (!loadConfig().SAMPLE_MODE) {
      throw new ZetarisUnavailableError(remote.message);
    }
    markOffline(options.table, options.file, remote.message);
    return {
      value: options.sample(),
      via: "sample",
      synthetic: options.sampleSynthetic,
      evidenceSource: evidenceLabel("sample", options.table, options.file),
    };
  }
}

function countyClause(county: string): string {
  return `county = ${sqlString(county, "county")}`;
}

export async function readPrices(county: string): Promise<SourceHit<KamisRow[]>> {
  const where = countyClause(county);
  const { table, file, columns } = MAIZE_TABLES.prices;
  const from = maizeFrom(table);
  return readLive({
    table,
    file,
    sql: `SELECT ${columns} FROM ${from} WHERE ${where}`,
    map: (rows) => rows.map((row) => mapKamisRow(row)).filter((row): row is KamisRow => row !== null && row.county.toLowerCase() === county.toLowerCase()),
    sample: () => loadPriceRows().filter((row) => row.county.toLowerCase() === county.toLowerCase()),
    sampleSynthetic: false,
    liveSynthetic: false,
  });
}

export async function readWeather(county: string): Promise<SourceHit<WeatherSeries | null>> {
  const where = countyClause(county);
  const { table, file, columns } = MAIZE_TABLES.weather;
  const from = maizeFrom(table);
  const hit = await readLive({
    table,
    file,
    sql: `SELECT ${columns} FROM ${from} WHERE ${where}`,
    map: (rows) => seriesFromSql(county, rows),
    sample: () => loadWeather().find((series) => series.county.toLowerCase() === county.toLowerCase()) ?? null,
    sampleSynthetic: true,
    liveSynthetic: false,
  });
  if (hit.value?.synthetic) hit.synthetic = true;
  if (hit.value?.source === "open-meteo") hit.synthetic = false;
  return hit;
}

function seriesFromSql(county: string, rows: Record<string, unknown>[]): WeatherSeries | null {
  const points: ForecastPoint[] = rows.flatMap((raw) => {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
    const date = String(row.forecast_date ?? row.date ?? "");
    const rain = finiteNumber(row.rain_mm);
    const humidity = finiteNumber(row.humidity_pct);
    const asOf = String(row.as_of ?? "");
    const source = row.source ? String(row.source) : "";
    if (!date || date === "null" || !asOf || asOf === "null" || !source || rain === undefined || humidity === undefined) return [];
    const temp = finiteNumber(row.temp_c);
    return [{
      date: date.slice(0, 10),
      rain_mm: rain,
      humidity_pct: humidity,
      as_of: asOf.slice(0, 10),
      source,
      ...(temp === undefined ? {} : { temp_c: temp }),
    }];
  });
  return chooseLatestSeries(county, points);
}

export async function readRules(): Promise<SourceHit<StorageRule[]>> {
  const { table, file, columns } = MAIZE_TABLES.rules;
  const from = maizeFrom(table);
  return readLive({
    table,
    file,
    sql: `SELECT ${columns} FROM ${from}`,
    map: (rows) => rows.flatMap((raw) => {
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
      const storage = String(row.storage ?? "");
      const daily = finiteNumber(row.daily_loss_pct);
      const rainMin = finiteNumber(row.rain_mm_min);
      const humidityMin = finiteNumber(row.humidity_min);
      if (!storage || daily === undefined || rainMin === undefined || humidityMin === undefined) return [];
      return [{
        storage,
        rain_mm_min: rainMin,
        humidity_min: humidityMin,
        daily_loss_pct: daily,
      }];
    }),
    sample: () => loadRules(),
    sampleSynthetic: true,
    liveSynthetic: true,
  });
}

export async function readNews(county: string): Promise<SourceHit<NewsItem[]>> {
  const where = `(county = ${sqlString(county, "county")} OR county = 'national')`;
  const { table, file, columns } = MAIZE_TABLES.news;
  const from = maizeFrom(table);
  return readLive({
    table,
    file,
    sql: `SELECT ${columns} FROM ${from} WHERE ${where}`,
    map: (rows) => rows.flatMap((raw) => {
      const item = mapNews(raw);
      return item ? [item] : [];
    }),
    sample: () => loadNews().filter((item) => item.county.toLowerCase() === county.toLowerCase() || item.county === "national"),
    sampleSynthetic: true,
    liveSynthetic: true,
  });
}

function mapNews(raw: Record<string, unknown>): NewsItem | null {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
  const direction = String(row.direction ?? "");
  const status = String(row.status ?? "");
  if (direction !== "up" && direction !== "down" && direction !== "flat") return null;
  if (status !== "announced" && status !== "gazetted") return null;
  return {
    id: String(row.id ?? randomUUID()),
    as_of: String(row.as_of ?? "").slice(0, 10),
    county: String(row.county ?? ""),
    maize_type: String(row.maize_type ?? ""),
    status,
    direction,
    headline: String(row.headline ?? ""),
    commodity: String(row.commodity ?? ""),
  };
}

export async function readFarmerLedger(farmerId: string): Promise<SourceHit<LedgerEntry[]>> {
  const id = sqlString(farmerId, "farmer_id");
  const { table, file, columns } = MAIZE_TABLES.ledger;
  const from = maizeFrom(table);
  return readLive({
    table,
    file,
    sql: `SELECT ${columns} FROM ${from} WHERE farmer_id = ${id}`,
    map: (rows) => rows.flatMap((raw) => {
      const entry = mapLedger(raw);
      return entry ? [entry] : [];
    }),
    sample: () => loadLedger().filter((entry) => entry.farmer_id === farmerId),
    sampleSynthetic: true,
    liveSynthetic: true,
  });
}

export interface CountyCoverage {
  county: string;
  coverage: "supported" | "limited";
  dry_maize_quotes_14d: number;
}

function lowerRow(raw: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
  return row;
}

function offlineCounties(today = new Date().toISOString().slice(0, 10)): CountyCoverage[] {
  const counts = new Map<string, number>();
  for (const row of loadPriceRows()) {
    if (row.commodity.toLowerCase() !== "dry maize") continue;
    const age = (Date.parse(today) - Date.parse(row.market_date)) / 86_400_000;
    if (!Number.isFinite(age) || age < 0 || age > COVERAGE_WINDOW_DAYS) continue;
    const key = row.county.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return loadCountyCatalog().map((entry) => {
    const n = counts.get(entry.county.toLowerCase()) ?? 0;
    return { county: entry.county, coverage: coverageFromQuoteCount(n), dry_maize_quotes_14d: n };
  });
}

/** Counties from maize.counties, with dry-maize coverage over the last 14 days. */
export async function listCounties(): Promise<{ source: "zetaris" | "sample"; counties: CountyCoverage[] }> {
  try {
    const names = await runSql("SELECT county FROM maize.counties", 100);
    const counts = await runSql(zetarisCountyQuoteSql(), 100);
    const byCounty = new Map<string, number>();
    for (const raw of counts) {
      const row = lowerRow(raw);
      const name = String(row.county ?? "");
      const n = Number(row.n);
      if (name) byCounty.set(name.toLowerCase(), Number.isFinite(n) ? n : 0);
    }
    const counties = names.flatMap((raw) => {
      const name = String(lowerRow(raw).county ?? "").trim();
      if (!name) return [];
      const n = byCounty.get(name.toLowerCase()) ?? 0;
      return [{ county: name, coverage: coverageFromQuoteCount(n), dry_maize_quotes_14d: n }];
    });
    return { source: "zetaris", counties };
  } catch (error) {
    const remote = error instanceof RemoteSourceError
      ? error
      : new ZetarisQueryError(error instanceof Error ? error.message : "county query failed");
    if (!remote.unreachable) throw new ZetarisQueryError(remote.message);
    if (!loadConfig().SAMPLE_MODE) throw new ZetarisUnavailableError(remote.message);
    markOffline("counties", "counties.csv", remote.message);
    return { source: "sample", counties: offlineCounties() };
  }
}

export async function traceCountyCase(county: string): Promise<void> {
  const sql = `SELECT county, latest_market_date, quote_count, forecast_date, precipitation_sum, temperature_2m_mean, humidity_pct, storage, daily_loss_pct, rules_synthetic FROM maize.county_case WHERE ${countyClause(county)}`;
  try {
    const rows = await runSql(sql, 80);
    traceEvent({
      action: "county_case",
      input_summary: redact(sqlSummary(sql)),
      output_summary: `rows=${rows.length}`,
      target_agent: null,
      confidence: null,
      retry_count: 0,
      status: "success",
    });
  } catch (error) {
    const remote = error instanceof RemoteSourceError
      ? error
      : new ZetarisQueryError(error instanceof Error ? error.message : "county_case failed");
    traceEvent({
      action: "county_case",
      input_summary: redact(sqlSummary(sql)),
      output_summary: redact(remote.message),
      target_agent: null,
      confidence: null,
      retry_count: 0,
      status: remote.unreachable && loadConfig().SAMPLE_MODE ? "fallback" : "error",
    });
    if (remote.unreachable && loadConfig().SAMPLE_MODE) return;
    throw remote.unreachable ? new ZetarisUnavailableError(remote.message) : new ZetarisQueryError(remote.message);
  }
}

function sqlDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("date was rejected as a SQL filter");
  return `DATE '${value}'`;
}

/** White-maize quotes in the claim's own date window, for the critic's recomputation. */
export async function readWhiteMaizeWindow(county: string, oldest: string, latest: string): Promise<Array<{ date: string; price: number }>> {
  const sql = `SELECT market_date, wholesale_price_kes FROM maize.kamis_prices WHERE ${countyClause(county)} AND lower(commodity) = 'dry maize' AND lower(variety) LIKE '%white%' AND unit_kg = 90 AND market_date >= ${sqlDate(oldest)} AND market_date <= ${sqlDate(latest)}`;
  const rows = await runSql(sql, 500);
  return rows.flatMap((raw) => {
    const row = lowerRow(raw);
    const date = String(row.market_date ?? "").slice(0, 10);
    const price = finiteNumber(row.wholesale_price_kes);
    if (!date || price === undefined) return [];
    return [{ date, price }];
  });
}

function mapLedger(raw: Record<string, unknown>): LedgerEntry | null {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
  const farmerId = String(row.farmer_id ?? "");
  if (!farmerId || farmerId === "null") return null;
  const recordType = String(row.record_type ?? "stock");
  const kind = recordType === "prior_verdict" || recordType === "sale" || recordType === "stock" ? recordType : "stock";
  const verdict = row.verdict == null ? "" : String(row.verdict);
  return {
    farmer_id: farmerId,
    county: String(row.county ?? ""),
    as_of: row.as_of ? String(row.as_of).slice(0, 10) : "",
    record_type: kind,
    verdict: verdict === "sell" || verdict === "hold" || verdict === "split" || verdict === "no_recommendation" ? verdict : undefined,
    hold_days: finiteNumber(row.hold_days),
    bags: finiteNumber(row.bags),
    storage: row.storage ? String(row.storage) : undefined,
    forecast_rain_mm_7d: finiteNumber(row.forecast_rain_mm_7d),
    notes: row.notes ? String(row.notes) : undefined,
  };
}
