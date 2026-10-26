import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PgClient } from "../src/adapters/maizePg.js";
import { projectRoot } from "../src/config.js";
import { coverageFromQuoteCount, postgresCountyQuoteSql, zetarisCountyQuoteSql } from "../src/tools/coverage.js";
import {
  catalogFromPages,
  requestedPageAccepted,
  runKamisBackfill,
  workbookCachePath,
} from "../src/tools/kamisBackfill.js";
import { parseKamisWorkbook } from "../src/tools/kamisSheet.js";

const kamisFixture = path.join(projectRoot(), "tests", "fixtures", "kamis-market-export.xls");

const onePage = `<select name="per_page"><option value="10">10</option><option value="3000">3000</option></select>
<ul class="pagination"><li class="active"><a href="#">1</a></li></ul>
<a href="https://kamis.kilimo.go.ke/site/market?product=1&per_page=10&export=excel">Export</a>
<tbody>
<tr><td>Dry Maize</td><td>White Maize</td><td>-</td><td>-</td><td>Ngurubani Market</td><td>46.67/Kg</td><td>50.00/Kg</td><td>1</td><td>Kirinyaga</td><td>2026-10-26</td></tr>
<tr><td>Dry Maize</td><td>White Maize</td><td>-</td><td>-</td><td>Eldoret Main</td><td>50.00/Kg</td><td>55.00/Kg</td><td>2</td><td>Uasin-Gishu</td><td>2026-10-25</td></tr>
</tbody>`;

const lastPage = `<select name="per_page"><option value="10">10</option></select>
<ul class="pagination"><li class="active"><a href="#">3293</a></li></ul>
<tbody>
<tr><td>Dry Maize</td><td>-</td><td>-</td><td>-</td><td>Karatina</td><td>15.56/Kg</td><td>-</td><td></td><td>Nyeri</td><td>2005-02-01</td></tr>
</tbody>`;

const firstPage = `<select name="per_page"><option value="10">10</option><option value="50">50</option><option value="3000">3000</option></select>
<ul class="pagination">
<li><a href="https://kamis.kilimo.go.ke/site/market/10?product=1&per_page=10">2</a></li>
<li><a href="https://kamis.kilimo.go.ke/site/market/32920?product=1&per_page=10" data-ci-pagination-page="3293">&raquo;</a></li>
</ul>
<tbody>
<tr><td>Dry Maize</td><td>White Maize</td><td>-</td><td>-</td><td>Ngurubani Market</td><td>46.67/Kg</td><td>50.00/Kg</td><td>6800.00</td><td>Kirinyaga</td><td>2026-10-26</td></tr>
</tbody>`;

function memoryPg(): PgClient & { inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  return {
    inserts,
    async query(sql, values) {
      if (sql.startsWith("INSERT")) inserts.push(values ?? []);
      return { rows: [], rowCount: sql.startsWith("INSERT") ? 1 : 0 };
    },
  };
}

describe("kamis catalog", () => {
  it("counts the last page and the offered page sizes", () => {
    const offer = catalogFromPages(firstPage, lastPage);
    expect(offer.rows).toBe(32921);
    expect(offer.dateStart).toBe("2005-02-01");
    expect(offer.dateEnd).toBe("2026-10-26");
    expect(offer.perPageOptions).toEqual([10, 50, 3000]);
    expect(offer.maxPerPageOffered).toBe(3000);
  });

  it("accepts a page size when the next offset matches, and a single page when nothing is clamped", () => {
    expect(requestedPageAccepted(firstPage, 10)).toBe(true);
    expect(requestedPageAccepted(firstPage, 3000)).toBe(false);
    expect(requestedPageAccepted(onePage, 10)).toBe(true);
    const clamped = `<a href="https://kamis.kilimo.go.ke/site/market/3000?product=1&per_page=3000">2</a>`;
    expect(requestedPageAccepted(clamped, 48000)).toBe(false);
    expect(requestedPageAccepted(clamped, 3000)).toBe(true);
  });
});

describe("coverage rule", () => {
  it("uses one threshold for the endpoint and the postgres report", () => {
    expect(coverageFromQuoteCount(2)).toBe("limited");
    expect(coverageFromQuoteCount(3)).toBe("supported");
    expect(zetarisCountyQuoteSql()).toContain("date_sub(current_date(), 14)");
    expect(zetarisCountyQuoteSql()).toContain("lower(commodity) = 'dry maize'");
    expect(postgresCountyQuoteSql()).toContain("CURRENT_DATE - 14");
    expect(postgresCountyQuoteSql()).toContain("lower(p.commodity) = 'dry maize'");
  });
});

describe("kamis backfill", () => {
  it("counts rejection reasons and keeps white maize with a wholesale price", () => {
    const parsed = parseKamisWorkbook(fs.readFileSync(kamisFixture), { whiteMaizeOnly: true });
    expect(parsed.fetched).toBe(10);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rejected).toBe(7);
    expect(parsed.reasons.test_row).toBeGreaterThan(0);
    expect(parsed.reasons.blank_wholesale).toBeGreaterThan(0);
    expect(parsed.rows.every((row) => row.variety.toLowerCase().includes("white") && row.unit_kg === 90)).toBe(true);
  });

  it("reports the catalog before writing, then skips a cached export page", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "kamis-backfill-"));
    const workbook = fs.readFileSync(kamisFixture);
    const gaps: number[] = [];
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/robots.txt")) return new Response("missing", { status: 404 });
      if (url.includes("export=excel")) return new Response(new Uint8Array(workbook));
      if (url.includes("per_page=3000")) {
        return new Response(`<select name="per_page"><option value="3000">3000</option></select>
<ul class="pagination"><li class="active"><a href="#">1</a></li></ul>
<a href="https://kamis.kilimo.go.ke/site/market?product=1&per_page=3000&export=excel">Export</a>`);
      }
      return new Response(onePage);
    }) as typeof fetch;
    const lines: string[] = [];
    const pg = memoryPg();
    const code = await runKamisBackfill({
      cacheDir,
      pauseMs: 2000,
      maxPages: 40,
      pg,
      fetch: fetchImpl,
      sleep: async (ms) => {
        gaps.push(ms);
      },
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines).toContain("rows: 2");
    expect(lines).toContain("date range: 2026-10-25 .. 2026-10-26");
    expect(lines).toContain("maximum per_page accepted: 3000");
    expect(lines.indexOf("maximum per_page accepted: 3000")).toBeLessThan(lines.indexOf("rows fetched: 10"));
    expect(fs.existsSync(path.join(cacheDir, "robots.txt"))).toBe(true);
    expect(fs.existsSync(workbookCachePath(cacheDir, 0, 3000))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot(), "data", "sample", "kamis_dry_maize.csv"))).toBe(true);
    expect(pg.inserts.length).toBe(3);
    expect(lines).toContain("rows upserted: 3");
    const reportAt = lines.indexOf("dry maize export");
    const cacheWrittenAfterReport = lines.indexOf("page 1 offset 0 fetched");
    expect(reportAt).toBeGreaterThanOrEqual(0);
    expect(cacheWrittenAfterReport).toBeGreaterThan(reportAt);
    expect(gaps.length).toBeGreaterThan(0);

    const sample = fs.readFileSync(path.join(projectRoot(), "data", "sample", "kamis_dry_maize.csv"));
    const exportCalls = calls.filter((url) => url.includes("export=excel")).length;
    const secondLines: string[] = [];
    const second = await runKamisBackfill({
      cacheDir,
      pauseMs: 0,
      maxPages: 40,
      pg: memoryPg(),
      fetch: fetchImpl,
      sleep: async () => undefined,
      log: (line) => secondLines.push(line),
    });
    expect(second).toBe(0);
    expect(calls.filter((url) => url.includes("export=excel")).length).toBe(exportCalls);
    expect(secondLines).toContain("page 1 offset 0 cached");
    expect(fs.readFileSync(path.join(projectRoot(), "data", "sample", "kamis_dry_maize.csv")).equals(sample)).toBe(true);
  });

  it("does not write into the sample directory", async () => {
    await expect(runKamisBackfill({
      cacheDir: path.join(projectRoot(), "data", "sample"),
      pauseMs: 0,
      fetch: (() => {
        throw new Error("network");
      }) as typeof fetch,
    })).rejects.toThrow(/agents read/);
  });
});
