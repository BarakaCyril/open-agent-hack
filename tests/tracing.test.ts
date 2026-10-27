import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chat } from "../src/adapters/meterless.js";
import { projectRoot, resetConfigForTests } from "../src/config.js";
import { buildServer } from "../src/server.js";
import {
  createTracer,
  followTrace,
  formatTraceTable,
  runContext,
  type RunContext,
  type TraceEvent,
} from "../src/tracing.js";
import { limitToTwoPlainSentences, mismatchedNumbers } from "../src/wording.js";

const savedEnv = {
  base: process.env.METERLESS_BASE_URL,
  token: process.env.METERLESS_RUNTIME_TOKEN,
  model: process.env.METERLESS_MODEL,
  provider: process.env.MODEL_PROVIDER,
  logDir: process.env.LOG_DIR,
  file: process.env.METERLESS_ENV_FILE,
};

function restoreEnv(): void {
  const assign = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  assign("METERLESS_BASE_URL", savedEnv.base);
  assign("METERLESS_RUNTIME_TOKEN", savedEnv.token);
  assign("METERLESS_MODEL", savedEnv.model);
  assign("MODEL_PROVIDER", savedEnv.provider);
  assign("LOG_DIR", savedEnv.logDir);
  assign("METERLESS_ENV_FILE", savedEnv.file);
  resetConfigForTests();
}

afterEach(() => {
  restoreEnv();
});

function claim(partial: Partial<TraceEvent> & Pick<TraceEvent, "action" | "output_summary">): Omit<TraceEvent, "timestamp" | "trace_id"> {
  return {
    agent_name: "MarketAnalyst",
    input_summary: "Kirinyaga prices.",
    target_agent: "RiskCritic",
    confidence: 0.4,
    retry_count: 1,
    status: "needs_revision",
    data_source: null,
    provider: "meterless",
    model: "meterless/auto",
    ...partial,
  };
}

describe("trace files", () => {
  it("names the log, points latest at the newest file, and prints one live line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maize-logs-"));
    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => {
      lines.push(String(message ?? ""));
    };
    try {
      const tracer = createTracer("abcdef12-3456-4789-8abc-def012345678", dir, { county: "Kirinyaga", mode: "advise" });
      tracer.event(claim({ action: "claim", output_summary: "needs another quote" }));
      tracer.finish();
      const names = fs.readdirSync(dir).filter((name) => name !== "latest.jsonl");
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_Kirinyaga_advise_abcdef12\.jsonl$/);
      if (process.platform === "win32") {
        expect(fs.existsSync(path.join(dir, "latest.jsonl"))).toBe(true);
      } else {
        expect(fs.lstatSync(path.join(dir, "latest.jsonl")).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(path.join(dir, "latest.jsonl"))).toBe(names[0]);
      }
      expect(lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] MarketAnalyst -> RiskCritic \| claim \| needs_revision \| needs another quote\.$/);

      const newer = createTracer("99999999-3456-4789-8abc-def012345678", dir, { county: "Uasin Gishu", mode: "recheck" });
      newer.finish();
      if (process.platform === "win32") {
        expect(fs.existsSync(path.join(dir, "latest.jsonl"))).toBe(true);
      } else {
        expect(fs.readlinkSync(path.join(dir, "latest.jsonl"))).toMatch(/_Uasin_Gishu_recheck_99999999\.jsonl$/);
      }
    } finally {
      console.log = original;
    }
  });

  it("replays events to a subscriber and then closes the stream", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maize-live-"));
    const tracer = createTracer("ccccccc1-3456-4789-8abc-def012345678", dir, { county: "Kiambu", mode: "advise" });
    tracer.event(claim({ action: "start", output_summary: "case opened", target_agent: "Planner", status: "success" }));
    const seen: string[] = [];
    const subscription = followTrace(tracer.traceId, dir, {
      onEvent: (event) => seen.push(event.action),
      onEnd: () => seen.push("end"),
    });
    expect(subscription.found).toBe(true);
    expect(seen).toEqual(["start"]);
    tracer.event(claim({ action: "claim", output_summary: "needs another quote" }));
    expect(seen).toEqual(["start", "claim"]);
    tracer.finish();
    expect(seen).toEqual(["start", "claim", "end"]);
  });

  it("serves GET /run/:traceId/events as server-sent events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maize-sse-"));
    const id = "abcdef12-0000-4000-8000-000000000099";
    const event: TraceEvent = {
      timestamp: "2026-10-24T07:01:31.000Z",
      trace_id: id,
      agent_name: "MarketAnalyst",
      action: "claim",
      input_summary: "Kirinyaga prices.",
      output_summary: "needs another quote",
      target_agent: "RiskCritic",
      confidence: 0.4,
      retry_count: 1,
      status: "needs_revision",
      data_source: null,
      provider: "meterless",
      model: "meterless/auto",
    };
    fs.writeFileSync(path.join(dir, "2026-10-24T07-01-31Z_Kirinyaga_advise_abcdef12.jsonl"), `${JSON.stringify(event)}\n`);
    process.env.LOG_DIR = dir;
    resetConfigForTests();
    const app = buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      const missing = await fetch(`http://127.0.0.1:${port}/run/00000000-0000-4000-8000-000000000000/events`);
      expect(missing.status).toBe(404);
      const response = await fetch(`http://127.0.0.1:${port}/run/${id}/events`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await response.text();
      expect(body).toContain(`"trace_id":"${id}"`);
      expect(body).toContain("needs another quote");
      expect(body).toContain("event: end");
    } finally {
      await app.close();
    }
  });

  it("pretty-prints a trace through the local TypeScript CLI", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maize-table-"));
    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => {
      lines.push(String(message ?? ""));
    };
    let file = "";
    try {
      const tracer = createTracer("ddddddd1-3456-4789-8abc-def012345678", dir, { county: "Kirinyaga", mode: "advise" });
      tracer.event(claim({
        action: "chat",
        output_summary: "Hold is the higher value because rain is 4 mm.",
        target_agent: null,
        status: "success",
        latency_ms: 842,
        prompt_tokens: 11,
        completion_tokens: 5,
        total_tokens: 16,
      }));
      tracer.finish();
      file = tracer.file;
    } finally {
      console.log = original;
    }
    const table = formatTraceTable([
      {
        timestamp: "2026-10-24T07:15:31.000Z",
        trace_id: "ddddddd1-3456-4789-8abc-def012345678",
        ...claim({
          action: "chat",
          output_summary: "Hold is the higher value because rain is 4 mm.",
          target_agent: null,
          status: "success",
          latency_ms: 842,
          prompt_tokens: 11,
          completion_tokens: 5,
          total_tokens: 16,
        }),
      },
    ]);
    expect(table).toContain("from -> to");
    expect(table).toContain("MarketAnalyst -> -");
    expect(table).toContain("842");
    expect(table).toContain("11/5/16");
    const tsxCli = path.join(projectRoot(), "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(process.execPath, [tsxCli, "scripts/trace.ts", "latest"], {
      cwd: projectRoot(),
      encoding: "utf8",
      env: { ...process.env, LOG_DIR: dir },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(file);
    expect(result.stdout).toContain("Hold is the higher value because rain is 4 mm.");
    expect(result.stdout).toContain("11/5/16");
    const missing = spawnSync(process.execPath, [tsxCli, "scripts/trace.ts", path.join(dir, "missing.jsonl")], {
      cwd: projectRoot(),
      encoding: "utf8",
      env: process.env,
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("trace file not found");
  });
});

describe("model wording guard", () => {
  it("keeps numbers that match the computed wording and caps plain replies at two sentences", () => {
    expect(mismatchedNumbers("The price is 3,200 KES for 20 bags.", "The price is 3,200 KES for 20 bags.")).toEqual([]);
    expect(mismatchedNumbers("About 18 percent.", "About 18.0 percent.")).toEqual([]);
    expect(mismatchedNumbers("The price is 9,999 KES for 20 bags.", "The price is 3,200 KES for 20 bags.")).toEqual([9999]);
    expect(mismatchedNumbers(
      "The offer is 800 KES below the P50.",
      "P50 4,200 and offer 3,400.",
    )).toEqual([]);
    expect(mismatchedNumbers(
      "800 KES above the offer.",
      "The offer of 3,400 KES is -800 KES against the P50 of 4,200.",
    )).toEqual([]);
    expect(limitToTwoPlainSentences("Alpha. Beta. Gamma.")).toBe("Alpha. Beta.");
    expect(limitToTwoPlainSentences("**Alpha.** Beta.")).toBe("Alpha. Beta.");
    expect(limitToTwoPlainSentences("Only one sentence")).toBe("Only one sentence.");
  });

  it("records chat metadata, drops hidden reasoning, and rejects a mismatched number", async () => {
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ content?: string }> };
      const user = body.messages?.map((message) => message.content ?? "").join(" ") ?? "";
      if (user.includes("3,200")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: "meterless/auto",
          choices: [{ message: { role: "assistant", content: "The price is 9,999 KES for 20 bags." } }],
        }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "nvidia/nemotron-super",
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        choices: [{
          message: {
            role: "assistant",
            content: "<think>secret 99999</think>Hold is the computed action because rain is 4 mm.",
            reasoning_content: "HIDDEN_CHAIN_999",
          },
        }],
      }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maize-chat-"));
    const envFile = path.join(dir, "env");
    fs.writeFileSync(envFile, "METERLESS_RUNTIME_TOKEN=good-token\n");
    process.env.METERLESS_ENV_FILE = envFile;
    process.env.MODEL_PROVIDER = "meterless";
    process.env.METERLESS_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.METERLESS_RUNTIME_TOKEN = "good-token";
    process.env.METERLESS_MODEL = "meterless/auto";
    resetConfigForTests();
    const tracer = createTracer("eeeeeee1-3456-4789-8abc-def012345678", dir, { county: "Kirinyaga", mode: "advise" });
    const ctx: RunContext = {
      tracer,
      agent: "Planner",
      queryCache: new Map(),
      dataSource: () => null,
      markSampleFallback() {},
      markNarrativeFallback() {},
      modelAnswer: { provider: null, model: null },
    };
    const original = console.log;
    console.log = () => {};
    try {
      const kept = await runContext.run(ctx, () => chat({
        agent: "Planner",
        system: "Reply with the decision and one reason.",
        user: "Hold is the computed action because rain is 4 mm.",
      }));
      expect(kept.wordingRejected).toBe(false);
      expect(kept.text).toBe("Hold is the computed action because rain is 4 mm.");
      expect(kept.text.includes("HIDDEN_CHAIN_999")).toBe(false);
      expect(kept.text.includes("99999")).toBe(false);
      const logged = JSON.stringify(tracer.events);
      expect(logged.includes("HIDDEN_CHAIN_999")).toBe(false);
      expect(logged.includes("99999")).toBe(false);
      const chatEvent = tracer.events.find((event) => event.action === "chat" && event.status === "success");
      expect(chatEvent?.provider).toBe("meterless");
      expect(chatEvent?.model).toBe("nvidia/nemotron-super");
      expect(typeof chatEvent?.latency_ms).toBe("number");
      expect(chatEvent?.prompt_tokens).toBe(11);
      expect(chatEvent?.completion_tokens).toBe(5);
      expect(chatEvent?.total_tokens).toBe(16);
      expect(chatEvent?.input_summary).toBe("Hold is the computed action because rain is 4 mm.");
      expect(chatEvent?.output_summary).toBe("Hold is the computed action because rain is 4 mm.");
      expect(chatEvent?.input_summary.includes("=")).toBe(false);

      const rejected = await runContext.run(ctx, () => chat({
        agent: "Planner",
        system: "Repeat the computed price.",
        user: "The price is 3,200 KES for 20 bags.",
      }));
      expect(rejected.text).toBe("");
      expect(rejected.fallback).toBe(false);
      expect(rejected.wordingRejected).toBe(true);
      const rejection = tracer.events.find((event) => event.action === "wording_rejected");
      expect(rejection?.status).toBe("fallback");
      expect(rejection?.output_summary).toContain("9999");
      expect(rejection?.output_summary).toContain("computed");
    } finally {
      console.log = original;
      tracer.finish();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
