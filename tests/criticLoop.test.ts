import { describe, expect, it } from "vitest";
import { judgeClaims } from "../src/agents/riskCritic.js";
import { describeRecheck } from "../src/agents/watcher.js";
import { caveatForRepeatedClaim, nextLoopAction, runBoundedLoop, type LoopBag } from "../src/orchestration/graph.js";
import type { Claim, CriticReason } from "../src/schemas.js";

function claim(agent: string, payload: Record<string, unknown>, evidence: Claim["evidence"] = [
  { source: "sample", as_of: "2026-10-18", freshness: "4d" },
]): Claim {
  return {
    id: agent,
    agent,
    statement: "figures",
    evidence,
    confidence: 0.7,
    payload,
    status: "pending",
    revision: 0,
  };
}

const cleanMarket = claim("MarketAnalyst", {
  n: 10,
  outlier_count: 1,
  outliers_removed: 1,
  oldest_date: "2026-10-16",
  latest_date: "2026-10-20",
  unresolved_conflict: false,
  news: [{ id: "n2", maize_type: "white", status: "gazetted", direction: "up" }],
});

const cleanStorage = claim("StorageWeatherAnalyst", {
  loss_mean: 0.18,
  total_rain_mm: 180,
  rules_matched: 7,
  forecast_as_of: "2026-10-21",
  implausible_forecast: false,
});

describe("critic loop caps", () => {
  it("revises at most twice, then escalates on the third rejection", async () => {
    const bag: LoopBag = { round: 0, revisions: 0, refreshes: 0 };
    let calls = 0;
    const result = await runBoundedLoop(bag, {
      analyze: async () => {
        calls += 1;
      },
      critique: async () => ({ action: "reject", reasons: ["contradiction"] }),
    });
    expect(calls).toBe(3);
    expect(bag.round).toBe(3);
    expect(bag.revisions).toBe(2);
    expect(bag.refreshes).toBe(0);
    expect(result.escalated).toBe(true);
    expect(result.approved).toBe(false);
  });

  it("refreshes stale data at most twice", async () => {
    const bag: LoopBag = { round: 0, revisions: 0, refreshes: 0 };
    const result = await runBoundedLoop(bag, {
      analyze: async () => undefined,
      critique: async () => ({ action: "reject", reasons: ["freshness"] }),
    });
    expect(bag.refreshes).toBe(2);
    expect(bag.revisions).toBe(0);
    expect(result.escalated).toBe(true);
  });

  it("stops when the critic approves and when the critic escalates immediately", async () => {
    const approved = await runBoundedLoop({ round: 0, revisions: 0, refreshes: 0 }, {
      analyze: async () => undefined,
      critique: async (round) => (round === 1
        ? { action: "reject", reasons: ["outlier"] as CriticReason[] }
        : { action: "approve", reasons: [] }),
    });
    expect(approved.approved).toBe(true);
    expect(approved.escalated).toBe(false);

    let calls = 0;
    const escalated = await runBoundedLoop({ round: 0, revisions: 0, refreshes: 0 }, {
      analyze: async () => {
        calls += 1;
      },
      critique: async () => ({ action: "escalate", reasons: ["coverage"] }),
    });
    expect(calls).toBe(1);
    expect(escalated.escalated).toBe(true);
  });

  it("does not revise on round 3", () => {
    const step = nextLoopAction({ round: 3, revisions: 0, refreshes: 0, action: "reject", reasons: ["contradiction"] });
    expect(step.effect).toBe("escalate");
    expect(step.revisions).toBe(0);
  });

  it("approves a clean pair of claims and rejects the named failure modes", () => {
    const ok = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      offerPerBag: 3400,
      cashNeed: 20000,
      market: cleanMarket,
      storageClaim: cleanStorage,
    });
    expect(ok.action).toBe("approve");
    expect(ok.reasons).toEqual([]);

    const weeklyRain = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: cleanMarket,
      storageClaim: claim("StorageWeatherAnalyst", {
        ...cleanStorage.payload,
        loss_mean: 0.032,
        total_rain_mm: 22,
        forecast_as_of: "2026-10-22",
        daily_rain_mm: [3.7, 7.2, 4.6, 2.4, 1.2, 0.9, 1.8],
        heavy_rain_mm_min: 20,
      }),
    });
    expect(weeklyRain.action).toBe("approve");
    expect(weeklyRain.reasons).not.toContain("contradiction");

    const heavyDay = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: cleanMarket,
      storageClaim: claim("StorageWeatherAnalyst", {
        ...cleanStorage.payload,
        loss_mean: 0.032,
        total_rain_mm: 26,
        forecast_as_of: "2026-10-22",
        daily_rain_mm: [26],
        heavy_rain_mm_min: 20,
      }),
    });
    expect(heavyDay.action).toBe("reject");
    expect(heavyDay.reasons).toContain("contradiction");
    expect(heavyDay.notes.join(" ")).toContain("20");
    expect(heavyDay.notes.join(" ")).toContain("StorageWeatherAnalyst can");

    const repeated = caveatForRepeatedClaim({
      action: "reject",
      reasons: ["contradiction"],
      previous: "same",
      next: "same",
      notes: ["StorageWeatherAnalyst can recompute the loss from those daily rows."],
    });
    expect(repeated.action).toBe("approve");
    expect(repeated.caveat).toContain("Unresolvable");
    const hard = caveatForRepeatedClaim({
      action: "escalate",
      reasons: ["coverage"],
      previous: "same",
      next: "same",
      notes: ["Only 1 cleaned white-maize quotes support this county."],
    });
    expect(hard.action).toBe("escalate");
    expect(hard.caveat).toBeNull();

    const mismatch = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: claim("MarketAnalyst", { ...cleanMarket.payload, news: [{ id: "n4", maize_type: "yellow" }] }),
      storageClaim: cleanStorage,
    });
    expect(mismatch.action).toBe("reject");
    expect(mismatch.reasons).toContain("maize_type_mismatch");
    expect(mismatch.target_agents).toContain("MarketAnalyst");

    const stale = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: claim("MarketAnalyst", { ...cleanMarket.payload, latest_date: "2026-09-01", oldest_date: "2026-09-01" }),
      storageClaim: cleanStorage,
    });
    expect(stale.reasons).toContain("freshness");

    const ageFour = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: claim("MarketAnalyst", { ...cleanMarket.payload, latest_date: "2026-10-18", oldest_date: "2026-10-18" }),
      storageClaim: cleanStorage,
    });
    expect(ageFour.action).toBe("reject");
    expect(ageFour.reasons).toContain("freshness");
    expect(ageFour.target_agents).toContain("MarketAnalyst");

    const ageThree = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: claim("MarketAnalyst", { ...cleanMarket.payload, latest_date: "2026-10-19", oldest_date: "2026-10-19" }),
      storageClaim: claim("StorageWeatherAnalyst", { ...cleanStorage.payload, forecast_as_of: "2026-10-19" }),
    });
    expect(ageThree.action).toBe("approve");

    const mixed = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: claim("MarketAnalyst", { ...cleanMarket.payload, oldest_date: "2026-09-20", latest_date: "2026-10-20" }),
      storageClaim: cleanStorage,
    });
    expect(mixed.reasons).toContain("freshness");
    expect(mixed.notes.some((note) => note.includes("Mixed-age prices") && note.includes("30 days"))).toBe(true);

    const oldForecast = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      market: cleanMarket,
      storageClaim: claim("StorageWeatherAnalyst", { ...cleanStorage.payload, forecast_as_of: "2026-10-18" }),
    });
    expect(oldForecast.reasons).toContain("freshness");
    expect(oldForecast.target_agents).toContain("StorageWeatherAnalyst");

    const cash = judgeClaims({
      today: "2026-10-22",
      bags: 20,
      storage: "open_bags",
      offerPerBag: 1000,
      cashNeed: 50000,
      market: cleanMarket,
      storageClaim: cleanStorage,
    });
    expect(cash.action).toBe("escalate");
    expect(cash.reasons).toContain("farmer_limits");
  });
});

describe("watcher recheck", () => {
  it("records a HOLD to SELL flip when rain has worsened", () => {
    const flipped = describeRecheck(
      { verdict: "hold", forecast_rain_mm_7d: 4 },
      { verdict: "sell", rain_mm_7d: 180 },
    );
    expect(flipped.flipped).toBe(true);
    expect(flipped.summary).toContain("SELL");
  });

  it("does not flip when the computed action is still hold", () => {
    const same = describeRecheck(
      { verdict: "hold", forecast_rain_mm_7d: 4 },
      { verdict: "hold", rain_mm_7d: 180 },
    );
    expect(same.flipped).toBe(false);
  });
});
