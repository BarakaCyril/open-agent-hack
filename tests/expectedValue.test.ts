import { describe, expect, it } from "vitest";
import { expectedValue, type EvInput } from "../src/tools/expectedValue.js";

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
});
