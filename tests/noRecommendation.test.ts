import { describe, expect, it } from "vitest";
import { abstentionCopy, limitationsFor, noRecommendationSummary, publishedPriceRange } from "../src/agents/planner.js";
import { createInitialState } from "../src/orchestration/state.js";

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

  it("writes abstention text from the blocking rule and keeps the data-source label", () => {
    const coverage = createInitialState({
      farmer_id: "demo-farmer",
      county: "Garissa",
      bags: 20,
      storage: "open_bags",
      mode: "advise",
    }, "trace-coverage", "2026-10-27");
    coverage.coverage = {
      price_rows: 1,
      fresh_price_rows: 1,
      thin: true,
      blocking: true,
      note: "Garissa has 1 fresh white-maize price row.",
    };
    coverage.sources = { prices: "zetaris", weather: "zetaris" };
    const covered = abstentionCopy(coverage);
    expect(covered.question_for_farmer).toBeNull();
    expect(covered.plain_reply.toLowerCase()).not.toContain("likely");
    expect(covered.what_would_change_this_advice[0]).toContain("at least 3");
    expect(limitationsFor(coverage).some((line) => line === "Data source: zetaris.")).toBe(true);
    expect(limitationsFor(coverage).join(" ")).not.toContain("forecast used here is synthetic");

    const cash = createInitialState({
      farmer_id: "demo-farmer",
      county: "Kirinyaga",
      bags: 20,
      storage: "open_bags",
      offer_per_bag: 3400,
      cash_need: 80000,
      mode: "advise",
    }, "trace-cash", "2026-10-27");
    cash.last_decision = {
      action: "escalate",
      reasons: ["farmer_limits"],
      notes: ["Cash need 80000 KES is above the 68000 KES a full sale at the stated offer would raise."],
      target_agents: [],
      confidence: 0.2,
    };
    const blocked = abstentionCopy(cash);
    expect(blocked.question_for_farmer).toContain("cash");
    expect(blocked.plain_reply.toLowerCase()).not.toContain("likely");

    const passedGate = createInitialState({
      farmer_id: "demo-farmer",
      county: "Nairobi",
      bags: 20,
      storage: "open_bags",
      mode: "advise",
    }, "trace-nairobi", "2026-10-27");
    passedGate.coverage = {
      price_rows: 500,
      fresh_price_rows: 4,
      thin: true,
      blocking: false,
      note: "Nairobi has 4 white-maize price rows in the last 14 days (500 in the file). Forecast as of 2026-10-27.",
    };
    passedGate.last_decision = {
      action: "escalate",
      reasons: ["freshness", "coverage"],
      notes: [
        "The newest price quote is 2026-10-23, more than 3 days before 2026-10-27. MarketAnalyst can refresh KAMIS and recompute the band from newer quotes.",
        "Only 2 cleaned white-maize quotes support this county.",
      ],
      target_agents: ["MarketAnalyst"],
      confidence: 0.2,
    };
    const nairobi = abstentionCopy(passedGate);
    expect(nairobi.plain_reply).toContain("2026-10-23");
    expect(nairobi.plain_reply.toLowerCase()).toContain("too old");
    expect(nairobi.plain_reply).not.toContain("at least 3");
    expect(nairobi.what_would_change_this_advice[0]).toContain("newer white-maize quote");
    expect(nairobi.what_would_change_this_advice.join(" ")).not.toContain("in the last 14 days");

    passedGate.last_decision = {
      action: "escalate",
      reasons: ["coverage"],
      notes: ["Only 2 cleaned white-maize quotes support this county."],
      target_agents: ["MarketAnalyst"],
      confidence: 0.2,
    };
    const cleaned = abstentionCopy(passedGate);
    expect(cleaned.plain_reply.toLowerCase()).toContain("cleaned price window");
    expect(cleaned.plain_reply).toContain("Only 2 cleaned white-maize quotes");
    expect(cleaned.plain_reply).not.toContain("has 4 fresh");
    expect(cleaned.what_would_change_this_advice[0]).toContain("cleaned white-maize quotes");

    const live = createInitialState({
      farmer_id: "demo-farmer",
      county: "Kirinyaga",
      bags: 20,
      storage: "open_bags",
      mode: "advise",
    }, "trace-live", "2026-10-27");
    live.sources = { prices: "zetaris", weather: "zetaris", rules: "zetaris" };
    live.synthetic_inputs = ["rules"];
    expect(limitationsFor(live).join(" ")).not.toContain("forecast used here is synthetic");
    live.synthetic_inputs = ["weather", "rules"];
    expect(limitationsFor(live).join(" ")).toContain("The forecast used here is synthetic.");
  });
});
