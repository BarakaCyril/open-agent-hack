import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KamisRow } from "../src/adapters/sampleData.js";
import { projectRoot } from "../src/config.js";
import { runBoundedLoop } from "../src/orchestration/graph.js";
import { continueAfterCritique } from "../src/orchestration/refresh.js";
import { createInitialState } from "../src/orchestration/state.js";
import { lookupCounty } from "../src/tools/counties.js";
import { parseKamisWorkbook } from "../src/tools/kamisSheet.js";
import { upsertPriceFile, upsertWeatherFile } from "../src/tools/maizeFiles.js";
import { kamisExportUrl, refreshKamis, robotsAllows } from "../src/tools/refreshKamis.js";
import type { RefreshReport } from "../src/tools/refreshReport.js";
import { parseOpenMeteoForecast, refreshWeather, type FetchLike } from "../src/tools/refreshWeather.js";
import { chooseLatestSeries } from "../src/tools/weatherSeries.js";
import { createTracer, runContext, type RunContext } from "../src/tracing.js";

const kamisFixture = path.join(projectRoot(), "tests", "fixtures", "kamis-market-export.xls");
const meteoFixture = path.join(projectRoot(), "tests", "fixtures", "open-meteo-kirinyaga.json");

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

function mean(values: number[]): number {
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
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

  it("derives daily humidity from hourly relative humidity", () => {
    const body = JSON.parse(fs.readFileSync(meteoFixture, "utf8")) as {
      daily: { precipitation_sum: Array<number | null>; temperature_2m_mean: number[]; relative_humidity_2m_mean?: number[] };
      hourly: { relative_humidity_2m: number[] };
    };
    expect(body.daily.relative_humidity_2m_mean).toBeUndefined();
    const parsed = parseOpenMeteoForecast(body, "Kirinyaga", "2026-10-24");
    expect(parsed.rejected).toBe(0);
    expect(parsed.series?.source).toBe("open-meteo");
    expect(parsed.series?.as_of).toBe("2026-10-24");
    expect(parsed.series?.days.map((day) => day.rain_mm)).toEqual([2.1, 1.2]);
    expect(parsed.series?.days.map((day) => day.temp_c)).toEqual([19.3, 19.5]);
    expect(parsed.series?.days[0]?.humidity_pct).toBe(mean(body.hourly.relative_humidity_2m.slice(0, 24)));
    expect(parsed.series?.days[1]?.humidity_pct).toBe(mean(body.hourly.relative_humidity_2m.slice(24, 48)));
    expect(parsed.series?.days.every((day) => day.as_of === "2026-10-24" && day.source === "open-meteo")).toBe(true);

    body.daily.precipitation_sum[0] = null;
    const dropped = parseOpenMeteoForecast(body, "Kirinyaga", "2026-10-24");
    expect(dropped.rejected).toBe(1);
    expect(dropped.series?.days.map((day) => day.rain_mm)).toEqual([1.2]);
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
    const parsed = parseOpenMeteoForecast(JSON.parse(fs.readFileSync(meteoFixture, "utf8")) as unknown, "Kirinyaga", "2026-10-24");
    const series = parsed.series;
    if (!series) throw new Error("fixture produced no series");
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
  it("does not call Open-Meteo when the county has no coordinates", async () => {
    let called = false;
    const report = await refreshWeather("Kirinyaga County", {
      fetch: async () => {
        called = true;
        return bytesResponse(Buffer.from("{}"));
      },
    });
    expect(lookupCounty("Kirinyaga")?.source).toContain("Nominatim");
    expect(lookupCounty("Kirinyaga County")).toBeNull();
    expect(called).toBe(false);
    expect(report.status).toBe("error");
    expect(report.stored).toBe(0);
  });

  it("requests the county centroid and does not invent a host directory", async () => {
    const cacheDir = tempDir("meteo-cache-");
    const missing = path.join(os.tmpdir(), `missing-maize-${Date.now()}`);
    fs.rmSync(missing, { recursive: true, force: true });
    let requested = "";
    const dir = tempDir("trace-meteo-");
    const tracer = createTracer("abcdef12-0000-4000-8000-000000000002", dir, { county: "Kirinyaga", mode: "advise" });
    const ctx: RunContext = {
      tracer,
      agent: "Planner",
      queryCache: new Map(),
      dataSource: () => null,
      markSampleFallback: () => undefined,
      markNarrativeFallback: () => undefined,
      modelAnswer: { provider: null, model: null },
    };
    const report = await runContext.run(ctx, () => refreshWeather("Kirinyaga", {
      cacheDir,
      maizeDir: missing,
      now: () => new Date("2026-10-24T08:00:00Z"),
      fetch: async (url, init) => {
        requested = url;
        expect(init?.headers?.["User-Agent"]).toContain("open-agent-maize");
        return bytesResponse(fs.readFileSync(meteoFixture));
      },
    }));
    expect(requested).toContain("latitude=-0.468878");
    expect(requested).toContain("longitude=37.3027681");
    expect(requested).toContain("precipitation_sum");
    expect(requested).toContain("relative_humidity_2m");
    expect(report.status).toBe("fallback");
    expect(report.fetched).toBe(2);
    expect(report.stored).toBe(0);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.readdirSync(cacheDir).some((name) => name.endsWith(".json"))).toBe(true);
    expect(tracer.events.map((event) => event.action)).toContain("refresh_weather");
    expect(tracer.events[0]?.output_summary).toContain("rows fetched 2");
    expect(tracer.events[0]?.output_summary).toContain("rows stored 0");
    expect(tracer.events[0]?.status).toBe("fallback");
    tracer.finish();
  });

  it("follows the export link, throttles, and counts rejected rows", async () => {
    expect(kamisExportUrl(0, 10)).toBe("https://kamis.kilimo.go.ke/site/market?product=1&per_page=10&export=excel");
    expect(kamisExportUrl(10, 10)).toBe("https://kamis.kilimo.go.ke/site/market/10?product=1&per_page=10&export=excel");
    const cacheDir = tempDir("kamis-cache-");
    const maizeDir = tempDir("kamis-maize-");
    const calls: string[] = [];
    const gaps: number[] = [];
    const workbook = fs.readFileSync(kamisFixture);
    const blocked = await refreshKamis({
      pauseMs: 0,
      cacheDir,
      maizeDir,
      fetch: async (url) => {
        calls.push(url);
        return bytesResponse(Buffer.from("User-agent: *\nDisallow: /site/market\n"), 200);
      },
    });
    expect(blocked.status).toBe("error");
    expect(calls).toHaveLength(1);

    const report = await refreshKamis({
      pauseMs: 2000,
      perPage: 10,
      maxPages: 2,
      cacheDir,
      maizeDir,
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
    expect(fs.readFileSync(path.join(maizeDir, "kamis_dry_maize.csv"), "utf8")).toContain("4200.3");
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
});
