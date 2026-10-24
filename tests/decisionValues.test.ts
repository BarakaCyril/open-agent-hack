import { describe, expect, it } from "vitest";
import { decisionValues } from "../src/agents/planner.js";
import { expectedValue } from "../src/tools/expectedValue.js";

describe("decision value proof", () => {
  it("publishes each computed option and the margin over the runner-up", () => {
    const result = expectedValue({
      bags: 2,
      sellPricePerBag: 100,
      futureP10: 200,
      futureP50: 200,
      futureP90: 200,
      lossMean: 0,
      lossP10: 0,
      lossP90: 0,
      cashNeed: 0,
      holdDays: 7,
      seed: 20261022,
      simulations: 1,
    });
    expect(decisionValues(result)).toEqual({
      sell: 200,
      hold: 400,
      split: 300,
      edge_over_next_best: 100,
    });
  });

  it("reports no artificial edge when the top options tie", () => {
    const result = expectedValue({
      bags: 1,
      sellPricePerBag: 100,
      futureP10: 100,
      futureP50: 100,
      futureP90: 100,
      lossMean: 0,
      lossP10: 0,
      lossP90: 0,
      cashNeed: 0,
      holdDays: 7,
      seed: 20261022,
      simulations: 1,
    });
    expect(decisionValues(result).edge_over_next_best).toBe(0);
  });
});
