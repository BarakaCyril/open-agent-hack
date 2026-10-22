import { describe, expect, it } from "vitest";
import { loadPriceRows, isWhiteMaizeBag } from "../src/adapters/sampleData.js";
import { cleanAndSummarize, projectPriceBand, quantile } from "../src/tools/prices.js";

describe("price stats", () => {
  it("computes linear percentiles", () => {
    expect(quantile([10, 20, 30], 0.5)).toBe(20);
    expect(quantile([10, 20, 30, 40], 0)).toBe(10);
  });

  it("drops the extreme quote and reports the cleaned band", () => {
    const stats = cleanAndSummarize([
      { date: "2026-10-16", price: 3300 },
      { date: "2026-10-17", price: 3400 },
      { date: "2026-10-18", price: 3450 },
      { date: "2026-10-18", price: 9999 },
    ]);
    expect(stats.outliersRemoved).toBe(1);
    expect(stats.outlierCount).toBe(1);
    expect(stats.p50).toBe(3400);
    expect(stats.p90).toBeLessThan(4000);
    expect(stats.latest).toBe(3450);
  });

  it("rejects an empty series", () => {
    expect(() => cleanAndSummarize([])).toThrow(/no price rows/);
  });

  it("reads a positive slope on a rising series and projects the band forward", () => {
    const stats = cleanAndSummarize([
      { date: "2026-10-09", price: 3100 },
      { date: "2026-10-12", price: 3200 },
      { date: "2026-10-15", price: 3300 },
      { date: "2026-10-18", price: 3450 },
    ]);
    expect(stats.slopePerDay).toBeGreaterThan(5);
    expect(stats.p10).toBeLessThan(stats.p50);
    expect(stats.p50).toBeLessThan(stats.p90);
    const forward = projectPriceBand(stats, 7);
    expect(forward.p50).toBeGreaterThan(stats.latest);
    expect(forward.p10).toBeLessThan(forward.p90);
  });

  it("drops the 9999 Kirinyaga quote in the sample file", () => {
    const points = loadPriceRows()
      .filter((row) => row.county === "Kirinyaga" && isWhiteMaizeBag(row) && row.market_date >= "2026-10-08")
      .map((row) => ({ date: row.market_date, price: row.wholesale_price_kes }));
    const stats = cleanAndSummarize(points);
    expect(points.some((point) => point.price === 9999)).toBe(true);
    expect(stats.outliersRemoved).toBe(1);
    expect(stats.p90).toBeLessThan(4000);
    expect(stats.n).toBe(10);
  });
});
