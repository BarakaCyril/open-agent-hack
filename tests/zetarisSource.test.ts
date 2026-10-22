import { describe, expect, it } from "vitest";
import {
  MAIZE_TABLES,
  cachedRows,
  evidenceLabel,
  maizeFrom,
  resolveDataSource,
  rowsFromZetarisBody,
} from "../src/adapters/zetaris.js";
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
