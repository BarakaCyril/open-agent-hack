import { describe, expect, it } from "vitest";
import { describeLiquidityPenalty, expectedValue, type EvInput } from "../src/tools/expectedValue.js";

function base(overrides: Partial<EvInput> = {}): EvInput {
  return {
    bags: 10,
    sellPricePerBag: 100,
    futureP10: 150,
    futureP50: 150,
    futureP90: 150,
    lossMean: 0,
    lossP10: 0,
    lossP90: 0,
    cashNeed: 0,
    holdDays: 7,
    seed: 20261022,
    simulations: 40,
    ...overrides,
  };
}

describe("expected value", () => {
  it("is deterministic for a fixed seed", () => {
    const input = base({
      futureP10: 120,
      futureP50: 160,
      futureP90: 210,
      lossMean: 0.08,
      lossP10: 0.02,
      lossP90: 0.15,
      simulations: 80,
    });
    expect(expectedValue(input)).toEqual(expectedValue(input));
  });

  it("prefers selling when storage loss dominates a flat future price", () => {
    const result = expectedValue(base({
      futureP10: 100,
      futureP50: 100,
      futureP90: 100,
      lossMean: 0.5,
      lossP10: 0.5,
      lossP90: 0.5,
      simulations: 5,
    }));
    expect(result.sellEv).toBeGreaterThan(result.holdEv);
    expect(result.best).toBe("sell");
  });

  it("prefers holding when the future price is higher and loss is zero", () => {
    const result = expectedValue(base({ simulations: 5 }));
    expect(result.holdEv).toBeGreaterThan(result.sellEv);
    expect(result.best).toBe("hold");
  });

  it("penalises a hold that does not meet a cash need today", () => {
    const withoutNeed = expectedValue(base({ simulations: 5 }));
    const withNeed = expectedValue(base({ cashNeed: 800, simulations: 5 }));
    expect(withoutNeed.best).toBe("hold");
    expect(withNeed.holdEv).toBeLessThan(withNeed.sellEv);
    expect(withNeed.splitEv).toBeGreaterThan(withNeed.sellEv);
    expect(withNeed.best).toBe("split");
    expect(withNeed.sellBagsInSplit).toBe(8);
  });

  it("keeps the same hold grain value when only the cash need differs, and states the penalty", () => {
    const shared = {
      bags: 20,
      futureP10: 3400,
      futureP50: 3600,
      futureP90: 3800,
      lossMean: 0.2,
      lossP10: 0.15,
      lossP90: 0.26,
      holdDays: 7,
      seed: 20261022,
      simulations: 500,
    };
    const noCashNeed = expectedValue({ ...shared, sellPricePerBag: 3450, cashNeed: 0 });
    const cashNeed = expectedValue({ ...shared, sellPricePerBag: 3400, cashNeed: 20000 });
    expect(cashNeed.holdGross).toBeCloseTo(noCashNeed.holdGross, 6);
    expect(cashNeed.holdPenalty).toBe(40000);
    expect(cashNeed.holdEv).toBeCloseTo(noCashNeed.holdEv - 40000, 6);
    expect(cashNeed.sellPenalty).toBe(0);
    const note = describeLiquidityPenalty(cashNeed);
    expect(note).toContain("20,000");
    expect(note).toContain("40,000");
    expect(note).toContain(Math.round(cashNeed.holdGross).toLocaleString("en-KE"));
    expect(note).toContain(Math.round(cashNeed.holdEv).toLocaleString("en-KE"));
    expect(note).toMatch(/scored hold value/i);
    expect(describeLiquidityPenalty(noCashNeed)).toBeNull();
  });
});
