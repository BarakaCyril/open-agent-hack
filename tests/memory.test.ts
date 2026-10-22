import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getMemory, resetMemoryForTests } from "../src/adapters/memory.js";
import { HMEM } from "../src/hmem/index.js";
import { rememberOutcome } from "../src/agents/planner.js";
import { describeRecheck, loadPrior } from "../src/agents/watcher.js";
import { createInitialState } from "../src/orchestration/state.js";
import type { Claim, RunRequest, RunResponse } from "../src/schemas.js";

const request: RunRequest = {
  farmer_id: "farmer-kirinyaga-001",
  county: "Kirinyaga",
  bags: 20,
  storage: "open_bags",
  offer_per_bag: 3400,
  mode: "advise",
};

function claim(agent: string, payload: Record<string, unknown>): Claim {
  return {
    id: agent,
    agent,
    statement: "figures",
    evidence: [{ source: "sample", as_of: "2026-10-22", freshness: "same-day" }],
    confidence: 0.7,
    payload,
    status: "approved",
    revision: 0,
  };
}

function response(verdict: RunResponse["verdict"], traceId: string, reasoning: string): RunResponse {
  return {
    verdict,
    hold_days: verdict === "hold" ? 7 : null,
    price_range_per_90kg_bag: { p10: 3118, p50: 3225, p90: 3405 },
    confidence: 0.62,
    evidence: [],
    reasoning_trace_summary: reasoning,
    what_would_change_this_advice: ["A drier forecast would change the comparison."],
    limitations: ["Decision support only."],
    recheck_schedule: "Recheck on 2026-10-25.",
    plain_reply: `The computed action is ${verdict}. This is decision support only.`,
    trace_id: traceId,
    data_source: "sample",
    reason: null,
    question_for_farmer: null,
  };
}

describe("H-MEM farmer history", () => {
  beforeEach(() => {
    resetMemoryForTests();
  });

  it("a warm run recalls the profile, verdict, and offer gap written by the cold run", async () => {
    const cold = createInitialState(request, "trace-cold", "2026-10-12");
    expect(await getMemory().recall(request.farmer_id)).toEqual([]);

    cold.claims.push(
      claim("MarketAnalyst", { p50: 3225, p10: 3118, p90: 3405, n: 10 }),
      claim("StorageWeatherAnalyst", { total_rain_mm: 4, loss_mean: 0.02 }),
    );
    await rememberOutcome(cold, response("hold", "trace-cold", "Prices were rising and 7-day rain was only 4 mm."));

    const remembered = await getMemory().recall(request.farmer_id);
    expect(remembered.map((record) => record.kind).sort()).toEqual(["offer_gap", "profile", "verdict"]);

    const profile = remembered.find((record) => record.kind === "profile");
    expect(profile?.payload).toMatchObject({ county: "Kirinyaga", bags: 20, storage: "open_bags" });
    expect(profile?.content).toContain("open_bags");

    const verdict = remembered.find((record) => record.kind === "verdict");
    expect(verdict?.content).toContain("2026-10-12");
    expect(verdict?.content).toContain("hold");
    expect(verdict?.content).toContain("4 mm");
    expect(verdict?.payload).toMatchObject({ verdict: "hold", as_of: "2026-10-12", forecast_rain_mm_7d: 4 });

    const gap = remembered.find((record) => record.kind === "offer_gap");
    expect(gap?.payload.gap).toBe(3400 - 3225);
    expect(gap?.payload.benchmark_p50).toBe(3225);
    expect(gap?.content).toContain("P50");

    const warm = createInitialState({ ...request, mode: "recheck" }, "trace-warm", "2026-10-22");
    const history = await getMemory().recall(request.farmer_id);
    warm.memory_recall = history.map((record) => ({
      farmer_id: record.farmerId,
      kind: record.kind,
      content: record.content,
      payload: record.payload,
      created_at: record.createdAt,
    }));
    await loadPrior(warm);
    expect(warm.prior).toMatchObject({
      verdict: "hold",
      as_of: "2026-10-12",
      forecast_rain_mm_7d: 4,
      source: "hmem:farmer-kirinyaga-001",
    });
    expect(describeRecheck(
      { verdict: warm.prior!.verdict, forecast_rain_mm_7d: warm.prior!.forecast_rain_mm_7d },
      { verdict: "sell", rain_mm_7d: 193 },
    ).flipped).toBe(true);

    warm.claims.push(
      claim("MarketAnalyst", { p50: 3225 }),
      claim("StorageWeatherAnalyst", { total_rain_mm: 193 }),
    );
    await rememberOutcome(warm, response("sell", "trace-warm", "Open bags and 193 mm of rain made selling worth more."));
    const afterWarm = await getMemory().recall(request.farmer_id);
    const verdicts = afterWarm.filter((record) => record.kind === "verdict");
    expect(verdicts).toHaveLength(2);
    expect(verdicts[1]?.payload.verdict).toBe("sell");
    expect(verdicts[0]?.payload.verdict).toBe("hold");
  });

  it("starts with no records when the persist directory is missing", () => {
    const dir = path.join(os.tmpdir(), `hmem-fresh-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    expect(fs.existsSync(dir)).toBe(false);
    const hmem = new HMEM({ persistDir: dir, actor: "open-agent-maize" });
    expect(hmem.store.all()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
    const gitignore = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^data\/hmem\/$/m);
  });
});
