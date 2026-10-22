import { describe, expect, it } from "vitest";
import { loadRules } from "../src/adapters/sampleData.js";
import { expectedLoss, type ForecastDay, type StorageRule } from "../src/tools/spoilage.js";

const oneDay: ForecastDay[] = [{ date: "2026-10-22", rain_mm: 1, humidity_pct: 50 }];
const wetWeek: ForecastDay[] = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-10-${19 + index}`,
  rain_mm: 25,
  humidity_pct: 88,
}));

describe("expected loss", () => {
  it("compounds a single daily rate", () => {
    const rules: StorageRule[] = [{ storage: "open_bags", rain_mm_min: 0, humidity_min: 0, daily_loss_pct: 10 }];
    const loss = expectedLoss("open_bags", oneDay, rules);
    expect(loss.mean).toBeCloseTo(0.1, 6);
    expect(loss.rulesMatched).toBe(1);
  });

  it("compounds across two days", () => {
    const rules: StorageRule[] = [{ storage: "open_bags", rain_mm_min: 0, humidity_min: 0, daily_loss_pct: 10 }];
    const loss = expectedLoss("open_bags", [oneDay[0]!, { ...oneDay[0]!, date: "2026-10-23" }], rules);
    expect(loss.mean).toBeCloseTo(1 - 0.9 * 0.9, 6);
  });

  it("uses the heavier open-bag rule when it is raining", () => {
    const rules = loadRules();
    const openLoss = expectedLoss("open_bags", wetWeek, rules);
    const dryLoss = expectedLoss("dry_store", wetWeek, rules);
    expect(openLoss.mean).toBeGreaterThan(0.15);
    expect(dryLoss.mean).toBeLessThan(0.03);
    expect(openLoss.mean).toBeGreaterThan(dryLoss.mean);
    expect(openLoss.totalRainMm).toBe(175);
  });

  it("refuses an empty forecast or an unknown store", () => {
    const rules = loadRules();
    expect(() => expectedLoss("open_bags", [], rules)).toThrow(/no forecast days/);
    expect(() => expectedLoss("silo", wetWeek, rules)).toThrow(/no storage rules/);
  });
});
