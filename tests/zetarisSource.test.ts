import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAIZE_TABLES,
  cachedRows,
  checkZetarisTables,
  evidenceLabel,
  loginAndGetFreshToken,
  maizeFrom,
  resolveDataSource,
  rowsFromZetarisBody,
} from "../src/adapters/zetaris.js";
import type { AppConfig } from "../src/config.js";
import { mapKamisRow } from "../src/adapters/sampleData.js";

describe("zetaris maize reads", () => {
  it("names columns from the headers array", () => {
    const rows = rowsFromZetarisBody({
      headers: ["market_date", "county", "wholesale_price_kes", "unit_kg"],
      data: [["2026-10-18", "Kirinyaga", "3450.0", "90"]],
    });
    expect(mapKamisRow(rows[0] ?? {})).toMatchObject({
      market_date: "2026-10-18",
      county: "Kirinyaga",
      wholesale_price_kes: 3450,
      unit_kg: 90,
    });
  });

  it("qualifies every table as maize.<table> and labels fallbacks", () => {
    for (const spec of Object.values(MAIZE_TABLES)) {
      expect(maizeFrom(spec.table)).toBe(`maize.${spec.table}`);
      expect(evidenceLabel("zetaris", spec.table, spec.file)).toBe(`zetaris:${spec.table}`);
      expect(evidenceLabel("sample", spec.table, spec.file)).toBe(`sample:${spec.file}`);
    }
    expect(MAIZE_TABLES.prices.columns).toContain("wholesale_price_kes");
    expect(MAIZE_TABLES.weather.columns).toContain("forecast_date");
    expect(MAIZE_TABLES.rules.columns).not.toContain("synthetic");
    expect(MAIZE_TABLES.news.columns).toContain("maize_type");
    expect(MAIZE_TABLES.ledger.columns).toContain("forecast_rain_mm_7d");
  });

  it("keeps a fallback visible when any table missed the live read", () => {
    expect(resolveDataSource({ prices: "zetaris", weather: "zetaris" })).toBe("zetaris");
    expect(resolveDataSource({ prices: "sample", weather: "sample" })).toBe("sample");
    expect(resolveDataSource({ prices: "zetaris", weather: "sample", news: "zetaris" })).toBe("mixed");
    expect(resolveDataSource({ prices: "zetaris" }, 1)).toBe("mixed");
    expect(resolveDataSource({}, 1)).toBe("sample");
    expect(resolveDataSource({})).toBeNull();
  });

  it("checks all sponsor tables with read-only count queries", async () => {
    const statements: string[] = [];
    const tables = await checkZetarisTables(async (sql) => {
      statements.push(sql);
      return [{ row_count: "12" }];
    });
    expect(tables).toHaveLength(5);
    expect(tables.every((table) => table.status === "online" && table.row_count === 12)).toBe(true);
    expect(statements).toHaveLength(5);
    expect(statements.every((sql) => /^SELECT COUNT\(\*\) AS row_count FROM maize\./.test(sql))).toBe(true);
  });

  it("reports per-table failures without hiding passing tables", async () => {
    const tables = await checkZetarisTables(async (sql) => {
      if (sql.includes("weather_daily")) throw new Error("query failed");
      return [{ row_count: 1 }];
    });
    expect(tables.filter((table) => table.status === "online")).toHaveLength(4);
    expect(tables.find((table) => table.table === "weather_daily")).toMatchObject({ status: "error", detail: "query failed" });
  });

  it("reuses an identical query inside one run and does not keep a failure", async () => {
    const cache = new Map<string, Promise<number>>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(7);
    };
    const first = await cachedRows(cache, "500\nSELECT 1", load);
    const second = await cachedRows(cache, "500\nSELECT 1", load);
    expect(first).toEqual({ value: 7, hit: false });
    expect(second).toEqual({ value: 7, hit: true });
    expect(calls).toBe(1);
    const fail = new Map<string, Promise<number>>();
    await expect(cachedRows(fail, "bad", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(fail.size).toBe(0);
  });
});

describe("Zetaris token refresh", () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
    PORT: 8000,
    SAMPLE_MODE: false,
    ZETARIS_REST_URL: "http://zetaris.test/api/proxy",
    ZETARIS_API_KEY: "expired.jwt.token",
    ZETARIS_ORG_ID: "org-test",
    ZETARIS_ADMIN_EMAIL: "",
    ZETARIS_ADMIN_PASSWORD: "",
    METERLESS_BASE_URL: "http://127.0.0.1:8088/v1",
    METERLESS_RUNTIME_TOKEN: "test-token",
    METERLESS_MODEL: "meterless/auto",
    MODEL_PROVIDER: "meterless",
    NVIDIA_BASE_URL: "https://example.test/v1",
    NVIDIA_API_KEY: "test-key",
    NVIDIA_MODEL: "test-model",
    SOURCE_TIMEOUT_SECONDS: 5,
    MAX_RETRIES: 1,
    LOG_DIR: "logs",
    STALE_DAYS: 3,
    KAMIS_MAX_PAGES: 2,
    KAMIS_PER_PAGE: 100,
    ZETARIS_MAIZE_DIR: "/tmp/maize",
    ...overrides,
  });

  it("does not attempt login without explicit credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loginAndGetFreshToken(config())).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes with configured credentials and returns the token in memory", async () => {
    const previousToken = process.env.ZETARIS_API_KEY;
    const fetchMock = vi.fn(async () => Response.json({ idToken: "fresh.jwt.token", orgId: "org-live" }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await loginAndGetFreshToken(config({
        ZETARIS_ADMIN_EMAIL: "operator@example.test",
        ZETARIS_ADMIN_PASSWORD: "configured-test-password",
      }));
      expect(result).toEqual({ token: "fresh.jwt.token", orgId: "org-live" });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("http://zetaris.test/api/auth/login");
      expect(JSON.parse(String((options as RequestInit).body))).toEqual({
        username: "operator@example.test",
        password: "configured-test-password",
      });
    } finally {
      if (previousToken === undefined) delete process.env.ZETARIS_API_KEY;
      else process.env.ZETARIS_API_KEY = previousToken;
    }
  });
});
