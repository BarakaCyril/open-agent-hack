import { randomUUID } from "node:crypto";
import { loadConfig, redact, type AppConfig } from "../config.js";
import { currentContext, traceEvent } from "../tracing.js";
import {
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
import type { StorageRule } from "../tools/spoilage.js";

export class RemoteSourceError extends Error {
  readonly timeout: boolean;
  readonly retryable: boolean;

  constructor(message: string, options: { timeout?: boolean; retryable?: boolean } = {}) {
    super(message);
    this.name = "RemoteSourceError";
    this.timeout = options.timeout ?? false;
    this.retryable = options.retryable ?? false;
  }
}

export interface SourceHit<T> {
  value: T;
  via: "zetaris" | "sample";
  synthetic: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    input_summary: sqlSummary(sql),
    output_summary: `rows=${rows} ${detail}`,
    target_agent: null,
    confidence: null,
    retry_count: retry,
    status,
  });
}

function extractRows(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object") throw new RemoteSourceError("Zetaris response was not JSON", { retryable: false });
  const data = (body as { data?: unknown }).data;
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { rows?: unknown }).rows)
      ? (data as { rows: unknown[] }).rows
      : null;
  if (!rows) throw new RemoteSourceError("Zetaris response has no data array", { retryable: false });
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

async function executeOnce(config: AppConfig, sql: string, limit: number): Promise<Record<string, unknown>[]> {
  const url = `${config.ZETARIS_REST_URL.replace(/\/+$/u, "")}/sql-editor/sqls/run`;
  const timeoutMs = config.SOURCE_TIMEOUT_SECONDS * 1000;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ZETARIS_API_KEY}`,
        "X-Org-ID": config.ZETARIS_ORG_ID,
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
    throw new RemoteSourceError(
      timedOut ? `Zetaris timed out after ${config.SOURCE_TIMEOUT_SECONDS}s` : "Zetaris request failed",
      { timeout: timedOut, retryable: !timedOut },
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new RemoteSourceError(`Zetaris HTTP ${response.status}: ${redact(text).slice(0, 180)}`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  try {
    return extractRows(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof RemoteSourceError) throw error;
    throw new RemoteSourceError("Zetaris response was not JSON", { retryable: false });
  }
}

export async function runSql(sql: string, limit = 500): Promise<Record<string, unknown>[]> {
  const statement = assertSingleStatement(sql);
  const config = loadConfig();
  const bounded = Math.max(1, Math.min(5000, limit));
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
      if (remote.timeout || !remote.retryable || attempt >= attempts) throw remote;
      await sleep(200 * 2 ** (attempt - 1));
    }
  }
  throw last ?? new RemoteSourceError("zetaris failed");
}

function markFallback(detail: string): void {
  traceEvent({
    action: "zetaris_sql",
    input_summary: detail,
    output_summary: "using data/sample after the live query failed",
    target_agent: null,
    confidence: null,
    retry_count: 0,
    status: "fallback",
  });
  currentContext()?.markSampleFallback(detail);
}

async function withSampleFallback<T>(options: {
  fullSql: string;
  narrowSql: string;
  map: (rows: Record<string, unknown>[]) => T;
  sample: () => T;
  synthetic: boolean;
}): Promise<SourceHit<T>> {
  const finish = (error: unknown): SourceHit<T> => {
    const config = loadConfig();
    if (!config.SAMPLE_MODE) {
      if (error instanceof Error) throw new RemoteSourceError(error.message, {
        timeout: error instanceof RemoteSourceError ? error.timeout : false,
        retryable: false,
      });
      throw new RemoteSourceError("zetaris failed");
    }
    markFallback(error instanceof Error ? error.message : "query failed");
    return { value: options.sample(), via: "sample", synthetic: options.synthetic };
  };
  try {
    const rows = await runSql(options.fullSql, 500);
    return { value: options.map(rows), via: "zetaris", synthetic: false };
  } catch (error) {
    if (error instanceof RemoteSourceError && error.timeout) {
      try {
        const rows = await runSql(options.narrowSql, 50);
        return { value: options.map(rows), via: "zetaris", synthetic: false };
      } catch (narrowError) {
        return finish(narrowError);
      }
    }
    if (error instanceof RemoteSourceError) return finish(error);
    throw error;
  }
}

function countyClause(county: string): string {
  return `county = ${sqlString(county, "county")}`;
}

export async function readPrices(county: string): Promise<SourceHit<KamisRow[]>> {
  const where = countyClause(county);
  const columns = "market_date, county, market_name, commodity, variety, grade, unit_kg, wholesale_price_kes, retail_price_kes, volume_bags";
  return withSampleFallback({
    fullSql: `SELECT ${columns} FROM kamis_prices WHERE ${where}`,
    narrowSql: `SELECT ${columns} FROM kamis_prices WHERE ${where} AND market_date >= DATE '2026-10-01'`,
    map: (rows) => rows.map((row) => mapKamisRow(row)).filter((row): row is KamisRow => row !== null && row.county.toLowerCase() === county.toLowerCase()),
    sample: () => loadPriceRows().filter((row) => row.county.toLowerCase() === county.toLowerCase()),
    synthetic: false,
  });
}

export async function readWeather(county: string): Promise<SourceHit<WeatherSeries | null>> {
  const where = countyClause(county);
  return withSampleFallback({
    fullSql: `SELECT county, as_of, source, forecast_date, rain_mm, humidity_pct, temp_c FROM weather_daily WHERE ${where}`,
    narrowSql: `SELECT county, as_of, forecast_date, rain_mm, humidity_pct FROM weather_daily WHERE ${where} AND forecast_date >= DATE '2026-10-01'`,
    map: (rows) => seriesFromSql(county, rows),
    sample: () => loadWeather().find((series) => series.county.toLowerCase() === county.toLowerCase()) ?? null,
    synthetic: true,
  });
}

function seriesFromSql(county: string, rows: Record<string, unknown>[]): WeatherSeries | null {
  if (rows.length === 0) return null;
  const days = rows.flatMap((raw) => {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
    const date = String(row.forecast_date ?? row.date ?? "");
    const rain = Number(row.rain_mm);
    const humidity = Number(row.humidity_pct);
    if (!date || !Number.isFinite(rain) || !Number.isFinite(humidity)) return [];
    return [{ date: date.slice(0, 10), rain_mm: rain, humidity_pct: humidity, temp_c: Number(row.temp_c) }];
  });
  const first = rows[0] ?? {};
  const asOf = String((first.as_of ?? first.AS_OF ?? days[0]?.date) ?? "");
  return { county, as_of: asOf.slice(0, 10), source: "zetaris:weather_daily", synthetic: false, days };
}

export async function readRules(): Promise<SourceHit<StorageRule[]>> {
  return withSampleFallback({
    fullSql: "SELECT storage, rain_mm_min, humidity_min, daily_loss_pct FROM storage_loss_rules",
    narrowSql: "SELECT storage, rain_mm_min, humidity_min, daily_loss_pct FROM storage_loss_rules WHERE storage IN ('open_bags', 'dry_store')",
    map: (rows) => rows.flatMap((raw) => {
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
      const storage = String(row.storage ?? "");
      const daily = Number(row.daily_loss_pct);
      if (!storage || !Number.isFinite(daily)) return [];
      return [{
        storage,
        rain_mm_min: Number(row.rain_mm_min ?? 0),
        humidity_min: Number(row.humidity_min ?? 0),
        daily_loss_pct: daily,
      }];
    }),
    sample: () => loadRules(),
    synthetic: true,
  });
}

export async function readNews(county: string): Promise<SourceHit<NewsItem[]>> {
  const where = `(county = ${sqlString(county, "county")} OR county = 'national')`;
  return withSampleFallback({
    fullSql: `SELECT id, as_of, county, maize_type, status, direction, headline, commodity FROM market_news WHERE ${where}`,
    narrowSql: `SELECT id, as_of, county, maize_type, status, direction, headline FROM market_news WHERE ${where} AND as_of >= DATE '2026-10-01'`,
    map: (rows) => rows.flatMap((raw) => {
      const item = mapNews(raw);
      return item ? [item] : [];
    }),
    sample: () => loadNews().filter((item) => item.county.toLowerCase() === county.toLowerCase() || item.county === "national"),
    synthetic: true,
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
  return withSampleFallback({
    fullSql: `SELECT farmer_id, county, as_of, record_type, verdict, hold_days, bags, storage, forecast_rain_mm_7d, notes FROM farmer_ledger WHERE farmer_id = ${id}`,
    narrowSql: `SELECT farmer_id, as_of, record_type, verdict, forecast_rain_mm_7d FROM farmer_ledger WHERE farmer_id = ${id} AND as_of >= DATE '2026-09-01'`,
    map: (rows) => rows.flatMap((raw) => {
      const entry = mapLedger(raw);
      return entry ? [entry] : [];
    }),
    sample: () => loadLedger().filter((entry) => entry.farmer_id === farmerId),
    synthetic: true,
  });
}

function mapLedger(raw: Record<string, unknown>): LedgerEntry | null {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
  const farmerId = String(row.farmer_id ?? "");
  if (!farmerId) return null;
  const recordType = String(row.record_type ?? "stock");
  const kind = recordType === "prior_verdict" || recordType === "sale" || recordType === "stock" ? recordType : "stock";
  const verdict = String(row.verdict ?? "");
  return {
    farmer_id: farmerId,
    county: String(row.county ?? ""),
    as_of: String(row.as_of ?? "").slice(0, 10),
    record_type: kind,
    verdict: verdict === "sell" || verdict === "hold" || verdict === "split" || verdict === "no_recommendation" ? verdict : undefined,
    hold_days: Number.isFinite(Number(row.hold_days)) ? Number(row.hold_days) : undefined,
    bags: Number.isFinite(Number(row.bags)) ? Number(row.bags) : undefined,
    storage: row.storage ? String(row.storage) : undefined,
    forecast_rain_mm_7d: Number.isFinite(Number(row.forecast_rain_mm_7d)) ? Number(row.forecast_rain_mm_7d) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
  };
}
