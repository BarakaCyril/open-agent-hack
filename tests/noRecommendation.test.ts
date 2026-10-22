import { describe, expect, it } from "vitest";
import { noRecommendationSummary, publishedPriceRange } from "../src/agents/planner.js";

describe("no recommendation response", () => {
  it("publishes no price band", () => {
    expect(publishedPriceRange("no_recommendation", { p10: 3900, p50: 3900, p90: 3900 })).toBeNull();
    expect(publishedPriceRange("sell", { p10: 3118, p50: 3225, p90: 3405 })).toEqual({
      p10: 3118,
      p50: 3225,
      p90: 3405,
    });
  });

  it("does not repeat the coverage note", () => {
    const note = "Garissa has 1 fresh white-maize price row in the last 14 days. Forecast as of 2026-08-01 is 82 days old.";
    expect(noRecommendationSummary(note, note)).toBe(note);
    expect(noRecommendationSummary(note, `${note} Stopped after the review rejected the claims.`)).toBe(
      `${note} Stopped after the review rejected the claims.`,
    );
  });
});
