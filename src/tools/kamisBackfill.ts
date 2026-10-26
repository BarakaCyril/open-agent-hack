import fs from "node:fs";
import path from "node:path";
import { ensureKamisPriceTable, maizePgConfig, upsertKamisRows, type PgClient } from "../adapters/maizePg.js";
import type { KamisRow } from "../adapters/sampleData.js";
import { clearReadCache } from "../adapters/zetaris.js";
import { projectRoot } from "../config.js";
import { parseKamisWorkbook } from "./kamisSheet.js";
import { kamisExportUrl, KAMIS_REQUEST_HEADERS, readKamisRobots } from "./refreshKamis.js";
import { KAMIS_EXPORT_ORIGIN, positiveInt, REQUEST_GAP_MS } from "./refreshReport.js";

export interface MarketPageFacts {
  perPageOptions: number[];
  dates: string[];
  dataRows: number;
  offsets: number[];
}

export interface CatalogOffer {
  rows: number;
  dateStart: string;
  dateEnd: string;
  perPageOptions: number[];
  maxPerPageOffered: number;
}

export function kamisMarketUrl(offset: number, perPage: number): string {
  const root = offset > 0 ? `${KAMIS_EXPORT_ORIGIN}/site/market/${offset}` : `${KAMIS_EXPORT_ORIGIN}/site/market`;
  return `${root}?product=1&per_page=${perPage}`;
}

export function parseMarketPage(html: string): MarketPageFacts {
  const select = /<select\b[^>]*\bname="per_page"[^>]*>([\s\S]*?)<\/select>/iu.exec(html)?.[1] ?? "";
  const perPageOptions = [...select.matchAll(/value="(\d+)"/gu)]
    .map((match) => Number(match[1]))
    .filter((value, index, all) => Number.isInteger(value) && value > 0 && all.indexOf(value) === index)
    .sort((a, b) => a - b);
  const body = /<tbody>([\s\S]*?)<\/tbody>/iu.exec(html)?.[1] ?? "";
  const dates: string[] = [];
  let dataRows = 0;
  for (const row of body.match(/<tr\b[\s\S]*?<\/tr>/giu) ?? []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((match) =>
      (match[1] ?? "").replace(/<[^>]+>/gu, "").trim(),
    );
    if (cells.length === 0) continue;
    dataRows += 1;
    const date = cells[cells.length - 1] ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) dates.push(date);
  }
  const offsets = [...html.matchAll(/\/site\/market\/(\d+)\?[^"']*?\bper_page=\d+/gu)]
    .map((match) => Number(match[1]))
    .filter((offset) => Number.isInteger(offset) && offset > 0);
  return {
    perPageOptions,
    dates,
    dataRows,
    offsets: [...new Set(offsets)].sort((a, b) => a - b),
  };
}

/** A page accepted the requested per_page when its next offset equals that size, or the catalog fits on one page. */
export function requestedPageAccepted(html: string, requested: number): boolean {
  const offsets = [...html.matchAll(new RegExp(`/site/market/(\\d+)\\?[^"'\\s]*per_page=${requested}\\b`, "gu"))]
    .map((match) => Number(match[1]))
    .filter((offset) => Number.isInteger(offset) && offset > 0);
  if (offsets.length > 0) return Math.min(...offsets) === requested;
  const echoed = new RegExp(`\\bper_page=${requested}\\b`, "u").test(html);
  const anyOffset = /\/site\/market\/\d+\?/u.test(html);
  return echoed && !anyOffset;
}

/**
 * Row count is the last page's offset plus the rows on that page.
 * The date range is the dates on the first and last catalog pages.
 */
export function catalogFromPages(firstHtml: string, lastHtml: string): CatalogOffer {
  const first = parseMarketPage(firstHtml);
  const last = parseMarketPage(lastHtml);
  const lastOffset = first.offsets.length > 0 ? Math.max(...first.offsets) : 0;
  const samePage = lastOffset === 0;
  const rows = samePage ? first.dataRows : lastOffset + last.dataRows;
  const dates = [...first.dates, ...(samePage ? [] : last.dates)].filter((date) => date.length > 0).sort();
  const perPageOptions = first.perPageOptions.length > 0 ? first.perPageOptions : last.perPageOptions;
  if (perPageOptions.length === 0) throw new Error("The market page did not list a per_page option");
  if (rows < 1 || dates.length === 0) throw new Error("The market page did not list dry-maize rows");
  return {
    rows,
    dateStart: dates[0] ?? "",
    dateEnd: dates[dates.length - 1] ?? "",
    perPageOptions,
    maxPerPageOffered: Math.max(...perPageOptions),
  };
}

export function workbookCachePath(cacheDir: string, offset: number, perPage: number): string {
  return path.join(cacheDir, `export-${offset}-per-${perPage}.xls`);
}

export function cachedWorkbook(file: string): Buffer | null {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  return bytes;
}

export function assertNotAgentData(directory: string): void {
  const resolved = path.resolve(directory);
  for (const name of ["sample", "fixtures"]) {
    const banned = path.resolve(projectRoot(), "data", name);
    if (resolved === banned || resolved.startsWith(`${banned}${path.sep}`)) {
      throw new Error(`Refusing to write files agents read: ${directory}`);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readUntil(response: Response, limit: number, stopAfter: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.includes(stopAfter) && text.includes("per_page")) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

function priceIdentity(row: KamisRow): string {
  return [row.market_date, row.county, row.market_name, row.commodity, row.variety, row.grade, String(row.unit_kg)].join("\0");
}

function printCountTable(log: (line: string) => void, title: string, label: string, rows: Array<[string, number]>): void {
  log(title);
  const width = Math.max(label.length, ...rows.map(([name]) => name.length), 4);
  log(`${label.padEnd(width)}  rows`);
  if (rows.length === 0) {
    log("(none)");
    return;
  }
  for (const [name, count] of rows) log(`${name.padEnd(width)}  ${String(count)}`);
}

async function openPg(injected?: PgClient): Promise<{ client: PgClient; close: () => Promise<void> }> {
  if (injected) return { client: injected, close: async () => undefined };
  const config = maizePgConfig();
  if (!config.password) throw new Error("MAIZE_PG_PASSWORD is not set");
  const pg = await import("pg");
  const client = new pg.default.Client({ ...config, password: String(config.password) });
  await client.connect();
  return {
    client: {
      query: async (sql, params) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
      },
    },
    close: async () => {
      await client.end();
    },
  };
}

export interface BackfillOptions {
  maxPages?: number;
  pauseMs?: number;
  cacheDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pg?: PgClient;
  log?: (line: string) => void;
}

export async function runKamisBackfill(options: BackfillOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const pauseMs = options.pauseMs ?? REQUEST_GAP_MS;
  const maxPages = options.maxPages ?? positiveInt(process.env.BACKFILL_MAX_PAGES, 40, 500);
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const cacheDir = options.cacheDir ?? path.join(projectRoot(), "data", "cache", "kamis");
  assertNotAgentData(cacheDir);

  const robots = await readKamisRobots(fetchImpl);
  if (robots.status === "deny") {
    log(robots.detail);
    return 1;
  }

  const loadHtml = async (url: string): Promise<string> => {
    if (pauseMs > 0) await sleep(pauseMs);
    const response = await fetchImpl(url, { headers: KAMIS_REQUEST_HEADERS, signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Market page failed (HTTP ${response.status})`);
    return text;
  };

  let firstHtml = "";
  let lastHtml = "";
  try {
    firstHtml = await loadHtml(kamisMarketUrl(0, 10));
    const first = parseMarketPage(firstHtml);
    const lastOffset = first.offsets.length > 0 ? Math.max(...first.offsets) : 0;
    lastHtml = lastOffset > 0 ? await loadHtml(kamisMarketUrl(lastOffset, 10)) : firstHtml;
  } catch (error) {
    log(error instanceof Error ? error.message : "The market page could not be read.");
    return 1;
  }

  let catalog: CatalogOffer;
  try {
    catalog = catalogFromPages(firstHtml, lastHtml);
  } catch (error) {
    log(error instanceof Error ? error.message : "The market page could not be read.");
    return 1;
  }

  const accepts = async (perPage: number): Promise<boolean> => {
    if (perPage === 10 && requestedPageAccepted(firstHtml, 10)) return true;
    if (pauseMs > 0) await sleep(pauseMs);
    try {
      const response = await fetchImpl(kamisMarketUrl(0, perPage), {
        headers: KAMIS_REQUEST_HEADERS,
        signal: AbortSignal.timeout(25_000),
      });
      const text = await readUntil(response, 160_000, "pagination");
      return response.ok && requestedPageAccepted(text, perPage);
    } catch {
      return false;
    }
  };

  const offered = [...catalog.perPageOptions].sort((a, b) => b - a);
  let maxPerPage = 0;
  for (const size of offered) {
    log(`probing per_page=${size}`);
    if (await accepts(size)) {
      maxPerPage = size;
      break;
    }
  }
  if (maxPerPage === 0) {
    log("The market page did not accept a listed per_page value.");
    return 1;
  }
  let cursor = maxPerPage;
  while (cursor < catalog.rows) {
    const next = Math.min(cursor * 2, catalog.rows);
    if (next <= cursor) break;
    log(`probing per_page=${next}`);
    if (!(await accepts(next))) break;
    maxPerPage = next;
    cursor = next;
  }

  log("dry maize export");
  log(`rows: ${catalog.rows}`);
  log(`date range: ${catalog.dateStart} .. ${catalog.dateEnd}`);
  log(`maximum per_page accepted: ${maxPerPage}`);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "robots.txt"), robots.body);

  const pagesNeeded = Math.max(1, Math.ceil(catalog.rows / maxPerPage));
  const pageCount = Math.min(maxPages, pagesNeeded);
  if (pageCount < pagesNeeded) log(`page cap: fetching ${pageCount} of ${pagesNeeded} pages`);

  const kept: KamisRow[] = [];
  const reasons: Record<string, number> = {};
  let fetched = 0;
  let rejected = 0;
  let failedPages = 0;
  let previous: Buffer | null = null;
  for (let page = 0; page < pageCount; page += 1) {
    const offset = page * maxPerPage;
    const file = workbookCachePath(cacheDir, offset, maxPerPage);
    let bytes = cachedWorkbook(file);
    if (bytes) {
      log(`page ${page + 1} offset ${offset} cached`);
    } else {
      if (pauseMs > 0) await sleep(pauseMs);
      try {
        const response = await fetchImpl(kamisExportUrl(offset, maxPerPage), {
          headers: KAMIS_REQUEST_HEADERS,
          signal: AbortSignal.timeout(120_000),
        });
        const body = Buffer.from(await response.arrayBuffer());
        if (!response.ok || body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
          failedPages += 1;
          log(`page ${page + 1} offset ${offset} failed (HTTP ${response.status})`);
          continue;
        }
        fs.writeFileSync(file, body);
        bytes = body;
        log(`page ${page + 1} offset ${offset} fetched`);
      } catch (error) {
        failedPages += 1;
        log(`page ${page + 1} offset ${offset} failed (${error instanceof Error ? error.message : "request failed"})`);
        continue;
      }
    }
    if (previous && bytes.equals(previous)) {
      log("stopped: the export repeated a page");
      break;
    }
    previous = bytes;
    let parsed: ReturnType<typeof parseKamisWorkbook>;
    try {
      parsed = parseKamisWorkbook(bytes, { whiteMaizeOnly: true });
    } catch (error) {
      failedPages += 1;
      log(`page ${page + 1} offset ${offset} failed (${error instanceof Error ? error.message : "parse failed"})`);
      continue;
    }
    fetched += parsed.fetched;
    rejected += parsed.rejected;
    kept.push(...parsed.rows);
    for (const [reason, count] of Object.entries(parsed.reasons)) reasons[reason] = (reasons[reason] ?? 0) + count;
    if (parsed.fetched < maxPerPage) break;
  }

  const unique = new Map<string, KamisRow>();
  for (const row of kept) unique.set(priceIdentity(row), row);
  const rows = [...unique.values()];

  log(`rows fetched: ${fetched}`);
  log(`rows parsed: ${kept.length}`);
  log(`rows rejected: ${rejected}`);
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    log(`  ${reason}: ${count}`);
  }
  if (failedPages > 0) log(`failed pages: ${failedPages}`);

  if (rows.length === 0) {
    log("rows upserted: 0");
    log(failedPages > 0 ? "The KAMIS export could not be read." : "The KAMIS export had no valid rows.");
    return 1;
  }

  const db = await openPg(options.pg).catch((error: unknown) => {
    log(error instanceof Error ? error.message : "Prices were not written.");
    return null;
  });
  if (!db) {
    log("rows upserted: 0");
    return 1;
  }
  try {
    await ensureKamisPriceTable(db.client);
    const stored = await upsertKamisRows(rows, db.client);
    clearReadCache();
    if (kept.length !== rows.length) log(`duplicate keys collapsed: ${kept.length - rows.length}`);
    log(`rows upserted: ${stored}`);
    const byCounty = new Map<string, number>();
    const byMonth = new Map<string, number>();
    for (const row of rows) {
      byCounty.set(row.county, (byCounty.get(row.county) ?? 0) + 1);
      const month = row.market_date.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
    }
    printCountTable(
      log,
      "rows per county",
      "county",
      [...byCounty.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    );
    printCountTable(
      log,
      "rows per month",
      "month",
      [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    );
    return failedPages > 0 && stored === 0 ? 1 : 0;
  } catch (error) {
    log("rows upserted: 0");
    log(error instanceof Error ? error.message : "Prices were not written.");
    return 1;
  } finally {
    await db.close();
  }
}
