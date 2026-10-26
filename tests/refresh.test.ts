import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KamisRow } from "../src/adapters/sampleData.js";
import { projectRoot } from "../src/config.js";
import { runBoundedLoop } from "../src/orchestration/graph.js";
import { continueAfterCritique } from "../src/orchestration/refresh.js";
import { createInitialState } from "../src/orchestration/state.js";
import type { PgClient } from "../src/adapters/maizePg.js";
import { parseKamisWorkbook } from "../src/tools/kamisSheet.js";
import { hostDirectoryProblem, upsertPriceFile, upsertWeatherFile } from "../src/tools/maizeFiles.js";
import { kamisExportUrl, refreshKamis, robotsAllows } from "../src/tools/refreshKamis.js";
import type { FetchLike, RefreshReport } from "../src/tools/refreshReport.js";
import { chooseLatestSeries } from "../src/tools/weatherSeries.js";
import { recordRefreshSuccess } from "../src/tools/refreshState.js";
import { mixedAgeNote } from "../src/orchestration/state.js";
import { createTracer, runContext, type RunContext } from "../src/tracing.js";

const kamisFixture = path.join(projectRoot(), "tests", "fixtures", "kamis-market-export.xls");

function memoryPg(): PgClient & { params: unknown[][] } {
  const params: unknown[][] = [];
  return {
    params,
    async query(sql, values) {
      if (sql.startsWith("INSERT")) params.push(values ?? []);
      return { rows: [], rowCount: sql.startsWith("INSERT") ? 1 : 0 };
    },
  };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bytesResponse(body: Buffer, status = 200): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body.toString("utf8"),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
}

const okReport: RefreshReport = { status: "success", fetched: 1, stored: 1, rejected: 0, detail: "ok" };

function caseState() {
  return createInitialState({
    farmer_id: "farmer-kirinyaga-003",
    county: "Kirinyaga",
    bags: 20,
    storage: "open_bags",
    mode: "advise",
  }, "abcdef12-0000-4000-8000-000000000001", "2026-10-24");
}

describe("live refresh parsers", () => {
  it("keeps the three priced KAMIS rows and rejects the other seven", () => {
    const parsed = parseKamisWorkbook(fs.readFileSync(kamisFixture));
    expect(parsed.rejected).toBe(7);
    expect(parsed.rows).toHaveLength(3);
    const kirinyaga = parsed.rows.find((row) => row.county === "Kirinyaga");
    expect(kirinyaga).toMatchObject({
      market_date: "2026-10-23",
      market_name: "Ngurubani Market",
      commodity: "Dry Maize",
      variety: "White Maize",
      grade: "-",
      unit_kg: 90,
      wholesale_price_kes: 4200.3,
      retail_price_kes: 4500,
      volume_bags: 4520,
    });
    expect(parsed.rows.find((row) => row.county === "Uasin Gishu")?.wholesale_price_kes).toBe(4799.7);
    expect(parsed.rows.find((row) => row.market_name === "Kawangware")?.volume_bags).toBe(0);
    expect(parsed.rows.some((row) => row.county.toLowerCase() === "test" || row.market_name === "test market")).toBe(false);
  });

  it("reads robots.txt and refuses a disallowed market path", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /site/market\n", "/site/market")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow:\n", "/site/market")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /admin\n", "/site/market")).toBe(true);
  });
});

describe("filestore upsert", () => {
  it("keeps price history, replaces the same quote, and leaves the sample file untouched", () => {
    const sample = path.join(projectRoot(), "data", "sample", "kamis_dry_maize.csv");
    const before = fs.readFileSync(sample);
    const dir = tempDir("prices-");
    const quote: KamisRow = {
      market_date: "2026-10-23",
      county: "Kirinyaga",
      market_name: "Refresh Market",
      commodity: "Dry Maize",
      variety: "White Maize",
      grade: "-",
      unit_kg: 90,
      wholesale_price_kes: 4200.3,
      retail_price_kes: 4500,
      volume_bags: 10,
    };
    expect(upsertPriceFile([quote], dir)).toBe(1);
    const first = fs.readFileSync(path.join(dir, "kamis_dry_maize.csv"), "utf8");
    expect(first).toContain("Ngurubani");
    expect(first).toContain("Refresh Market");
    const lines = first.trim().split("\n").length;
    expect(upsertPriceFile([{ ...quote, wholesale_price_kes: 4300 }], dir)).toBe(1);
    const second = fs.readFileSync(path.join(dir, "kamis_dry_maize.csv"), "utf8");
    expect(second.trim().split("\n")).toHaveLength(lines);
    expect(second).toContain("4300");
    expect(second.match(/Refresh Market/gu)).toHaveLength(1);
    expect(upsertPriceFile([{ ...quote, market_date: "2026-10-22" }], dir)).toBe(1);
    expect(fs.readFileSync(path.join(dir, "kamis_dry_maize.csv"), "utf8").match(/Refresh Market/gu)).toHaveLength(2);
    expect(fs.readFileSync(sample).equals(before)).toBe(true);
  });

  it("keeps other counties and older forecast issues", () => {
    const sample = path.join(projectRoot(), "data", "sample", "weather.json");
    const before = fs.readFileSync(sample);
    const dir = tempDir("weather-");
    const series = {
      county: "Kirinyaga",
      as_of: "2026-10-24",
      source: "open-meteo",
      synthetic: false,
      days: [{ date: "2026-10-24", rain_mm: 2.1, humidity_pct: 70, temp_c: 19.3, as_of: "2026-10-24", source: "open-meteo" }],
    };
    upsertWeatherFile(series, dir);
    upsertWeatherFile({ ...series, as_of: "2026-10-23", days: series.days.map((day) => ({ ...day, as_of: "2026-10-23" })) }, dir);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "weather.json"), "utf8")) as {
      series: Array<{ county: string; as_of: string; source: string }>;
    };
    const kirinyaga = stored.series.filter((item) => item.county === "Kirinyaga");
    expect(kirinyaga.map((item) => `${item.as_of}:${item.source}`).sort()).toEqual(["2026-10-23:open-meteo", "2026-10-24:open-meteo"]);
    expect(stored.series.some((item) => item.county === "Garissa" && item.source.includes("synthetic"))).toBe(true);
    expect(kirinyaga.some((item) => item.source.includes("synthetic"))).toBe(false);
    const chosen = chooseLatestSeries("Kirinyaga", kirinyaga.flatMap((item) => [{
      date: "2026-10-24",
      rain_mm: 1,
      humidity_pct: 70,
      as_of: item.as_of,
      source: item.source,
    }]));
    expect(chosen?.as_of).toBe("2026-10-24");
    expect(chosen?.source).toBe("open-meteo");
    expect(fs.readFileSync(sample).equals(before)).toBe(true);
  });
});

describe("refresh tools", () => {
  it("follows the export link, throttles, and counts rejected rows", async () => {
    expect(kamisExportUrl(0, 10)).toBe("https://kamis.kilimo.go.ke/site/market?product=1&per_page=10&export=excel");
    expect(kamisExportUrl(10, 10)).toBe("https://kamis.kilimo.go.ke/site/market/10?product=1&per_page=10&export=excel");
    const cacheDir = tempDir("kamis-cache-");
    const calls: string[] = [];
    const gaps: number[] = [];
    const workbook = fs.readFileSync(kamisFixture);
    const blocked = await refreshKamis({
      pauseMs: 0,
      cacheDir,
      stateFile: path.join(cacheDir, "state.json"),
      fetch: async (url) => {
        calls.push(url);
        return bytesResponse(Buffer.from("User-agent: *\nDisallow: /site/market\n"), 200);
      },
    });
    expect(blocked.status).toBe("error");
    expect(calls).toHaveLength(1);

    const pg = memoryPg();
    const report = await refreshKamis({
      pauseMs: 2000,
      perPage: 10,
      maxPages: 2,
      cacheDir,
      pg,
      stateFile: path.join(cacheDir, "state.json"),
      sleep: async (ms) => {
        gaps.push(ms);
      },
      fetch: async (url) => {
        calls.push(url);
        if (url.endsWith("/robots.txt")) return bytesResponse(Buffer.from("<html>Page Not Found</html>"), 404);
        if (url.includes("/site/market/10")) throw new Error("second page failed");
        return bytesResponse(workbook);
      },
    });
    expect(gaps).toEqual([2000, 2000]);
    expect(report.status).toBe("fallback");
    expect(report.fetched).toBe(3);
    expect(report.stored).toBe(3);
    expect(report.rejected).toBe(7);
    expect(pg.params.some((values) => values.includes(4200.3))).toBe(true);
    expect(pg.params.every((values) => values.length === 10)).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "robots.txt"))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "export-0-per-10.xls"))).toBe(true);
  });
});

describe("refresh loop cap", () => {
  it("calls each refresh tool twice and then stops", async () => {
    const state = caseState();
    let prices = 0;
    let weather = 0;
    const bag = { round: 0, revisions: 0, refreshes: 0 };
    const result = await runBoundedLoop(bag, {
      analyze: async () => undefined,
      critique: async () => {
        state.last_decision = {
          action: "reject",
          reasons: ["freshness"],
          notes: ["stale"],
          target_agents: ["MarketAnalyst", "StorageWeatherAnalyst"],
          confidence: 0.4,
        };
        return { action: "reject", reasons: ["freshness"] };
      },
      onContinue: async (effect) => {
        await continueAfterCritique(effect, state, bag.refreshes, {
          prices: async () => {
            prices += 1;
            return okReport;
          },
          weather: async () => {
            weather += 1;
            return okReport;
          },
        });
      },
    });
    expect(prices).toBe(2);
    expect(weather).toBe(2);
    expect(bag.refreshes).toBe(2);
    expect(result.escalated).toBe(true);
  });

  it("does not refresh weather when the critic only names the market", async () => {
    const state = caseState();
    state.last_decision = {
      action: "reject",
      reasons: ["freshness"],
      notes: ["stale prices"],
      target_agents: ["MarketAnalyst"],
      confidence: 0.4,
    };
    let weather = 0;
    let prices = 0;
    await continueAfterCritique("refresh", state, 1, {
      prices: async () => {
        prices += 1;
        return okReport;
      },
      weather: async () => {
        weather += 1;
        return okReport;
      },
    });
    await continueAfterCritique("revise", state, 1, {
      prices: async () => {
        prices += 1;
        return okReport;
      },
      weather: async () => {
        weather += 1;
        return okReport;
      },
    });
    expect(prices).toBe(1);
    expect(weather).toBe(0);
  });

  it("traces refresh_unavailable when Postgres refuses the upsert", async () => {
    const dir = tempDir("trace-missing-");
    const tracer = createTracer("abcdef12-0000-4000-8000-000000000003", dir, { county: "Kirinyaga", mode: "advise" });
    const ctx: RunContext = {
      tracer,
      agent: "Planner",
      queryCache: new Map(),
      dataSource: () => null,
      markSampleFallback: () => undefined,
      markNarrativeFallback: () => undefined,
      modelAnswer: { provider: null, model: null },
    };
    const report = await runContext.run(ctx, () => refreshKamis({
      pauseMs: 0,
      maxPages: 1,
      cacheDir: dir,
      stateFile: path.join(dir, "state.json"),
      pg: {
        query: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
        },
      },
      fetch: async (url) => {
        if (url.endsWith("/robots.txt")) return bytesResponse(Buffer.from("missing"), 404);
        return bytesResponse(fs.readFileSync(kamisFixture));
      },
    }));
    expect(report.status).toBe("fallback");
    expect(report.unavailable).toBe(true);
    expect(report.stored).toBe(0);
    expect(fs.existsSync(path.join(dir, "kamis_dry_maize.csv"))).toBe(false);
    const unavailable = tracer.events.find((event) => event.action === "refresh_unavailable");
    expect(unavailable?.output_summary).toMatch(/^refresh_unavailable: /);
    const state = caseState();
    state.last_decision = {
      action: "reject",
      reasons: ["freshness"],
      notes: [],
      target_agents: ["MarketAnalyst"],
      confidence: 0.4,
    };
    await continueAfterCritique("refresh", state, 1, {
      prices: async () => report,
    });
    expect(state.refresh_limits).toEqual([`refresh_unavailable: ${report.detail}`]);
    tracer.finish();
  });

  it("skips the network when refresh is disabled or the last success is inside the TTL", async () => {
    let called = 0;
    const fetchImpl: FetchLike = async () => {
      called += 1;
      return bytesResponse(Buffer.from("{}"));
    };
    const off = await refreshKamis({ enabled: false, fetch: fetchImpl, pauseMs: 0 });
    expect(called).toBe(0);
    expect(off.status).toBe("skipped");
    expect(off.detail).toContain("REFRESH_ENABLED is false");

    const stateFile = path.join(tempDir("refresh-ttl-"), "refresh_state.json");
    const now = new Date("2026-10-24T12:00:00Z");
    recordRefreshSuccess("kamis", now, stateFile);
    const recent = await refreshKamis({
      stateFile,
      now,
      ttlMinutes: 360,
      pauseMs: 0,
      fetch: fetchImpl,
    });
    expect(called).toBe(0);
    expect(recent.status).toBe("skipped");
    expect(recent.detail).toContain("REFRESH_TTL_MINUTES (360)");

    const stale = await refreshKamis({
      stateFile,
      ttlMinutes: 360,
      pauseMs: 0,
      now: new Date(now.getTime() + 361 * 60_000),
      fetch: async () => {
        called += 1;
        return bytesResponse(Buffer.from("unavailable"), 503);
      },
    });
    expect(called).toBe(1);
    expect(stale.status).toBe("error");
  });

  it("refuses to overwrite a fixture or the sample directory", () => {
    const fixtures = path.join(projectRoot(), "data", "fixtures");
    const sample = path.join(projectRoot(), "data", "sample");
    const before = fs.readFileSync(path.join(fixtures, "dirty_market.json"));
    expect(hostDirectoryProblem(fixtures)).toMatch(/Refusing to write/);
    expect(hostDirectoryProblem(sample)).toMatch(/Refusing to write/);
    expect(() => upsertPriceFile([], fixtures)).toThrow(/Refusing to write/);
    expect(fs.readFileSync(path.join(fixtures, "dirty_market.json")).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(fixtures, "kamis_dry_maize.csv"))).toBe(false);
  });
});

describe("mixed price window", () => {
  it("states that a span longer than 21 days blends a stale quote into the band", () => {
    const note = mixedAgeNote("2026-09-15", "2026-10-18");
    expect(note).toContain("Mixed-age prices");
    expect(note).toContain("33 days");
    expect(note).toContain("longer than 21 days");
    expect(mixedAgeNote("2026-10-16", "2026-10-20")).toBeNull();
  });
});
