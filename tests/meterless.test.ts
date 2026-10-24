import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  METERLESS_CHAT_TIMEOUT_MS,
  METERLESS_DEFAULT_BASE_URL,
  METERLESS_PROVIDER_ID,
  METERLESS_PROVIDER_NAME,
  applyConnectLink,
  autoDetectMeterless,
  chat,
  completePlainText,
  knownMeterlessModels,
  meterlessHealth,
  meterlessModelIds,
  meterlessSettings,
  normalizeMeterlessBase,
  parseConnectLink,
  resetMeterlessDiscoveryForTests,
  selectMeterlessModel,
  testMeterlessConnection,
  nvidiaHealth,
  wordingFallbackNote,
} from "../src/adapters/meterless.js";
import { resetConfigForTests } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { createTracer, runContext, type RunContext } from "../src/tracing.js";

const envFile = path.join(os.tmpdir(), `meterless-env-${process.pid}.env`);
const saved = {
  base: process.env.METERLESS_BASE_URL,
  token: process.env.METERLESS_RUNTIME_TOKEN,
  model: process.env.METERLESS_MODEL,
  file: process.env.METERLESS_ENV_FILE,
  provider: process.env.MODEL_PROVIDER,
};

interface SeenRequest {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const seen: SeenRequest[] = [];

function restoreEnv(): void {
  if (saved.base === undefined) delete process.env.METERLESS_BASE_URL;
  else process.env.METERLESS_BASE_URL = saved.base;
  if (saved.token === undefined) delete process.env.METERLESS_RUNTIME_TOKEN;
  else process.env.METERLESS_RUNTIME_TOKEN = saved.token;
  if (saved.model === undefined) delete process.env.METERLESS_MODEL;
  else process.env.METERLESS_MODEL = saved.model;
  if (saved.file === undefined) delete process.env.METERLESS_ENV_FILE;
  else process.env.METERLESS_ENV_FILE = saved.file;
  if (saved.provider === undefined) delete process.env.MODEL_PROVIDER;
  else process.env.MODEL_PROVIDER = saved.provider;
  resetConfigForTests();
}

function useRuntimeEnv(token = "good-token", base = "http://127.0.0.1:8088/v1", model = "meterless/auto"): void {
  process.env.METERLESS_ENV_FILE = envFile;
  process.env.MODEL_PROVIDER = "meterless";
  process.env.METERLESS_BASE_URL = base;
  process.env.METERLESS_RUNTIME_TOKEN = token;
  process.env.METERLESS_MODEL = model;
  fs.writeFileSync(envFile, `METERLESS_BASE_URL=${base}\nMETERLESS_RUNTIME_TOKEN=${token}\nMETERLESS_MODEL=${model}\n`);
  resetConfigForTests();
  resetMeterlessDiscoveryForTests();
}

function listen(port: number, handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

describe("meterless url contract", () => {
  it("normalises pasted bases to a single /v1", () => {
    const cases: Array<[string, string]> = [
      ["http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1"],
      ["http://127.0.0.1:8088", "http://127.0.0.1:8088/v1"],
      ["127.0.0.1:8088", "http://127.0.0.1:8088/v1"],
      ["localhost:8088/v1", "http://localhost:8088/v1"],
      ["[::1]:8088", "http://[::1]:8088/v1"],
      ["http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1"],
      ["http://127.0.0.1:8088/v1/models", "http://127.0.0.1:8088/v1"],
      ["http://127.0.0.1:8088/healthz", "http://127.0.0.1:8088/v1"],
      ["http://127.0.0.1:8088/v1/v1", "http://127.0.0.1:8088/v1"],
      ["http://127.0.0.1:8088/v1/v1/chat/completions", "http://127.0.0.1:8088/v1"],
      ["http://127.0.0.1:8088/v1/models/v1", "http://127.0.0.1:8088/v1"],
      ["HTTP://127.0.0.1:8088/V1/MODELS", "http://127.0.0.1:8088/v1"],
    ];
    for (const [raw, expected] of cases) {
      const normalized = normalizeMeterlessBase(raw);
      expect(normalized).toBe(expected);
      expect(normalized.includes("/v1/v1")).toBe(false);
    }
    expect(METERLESS_DEFAULT_BASE_URL).toBe("http://127.0.0.1:8088/v1");
    expect(METERLESS_PROVIDER_ID).toBe("meterless");
    expect(METERLESS_PROVIDER_NAME).toBe("Meterless Runtime");
    expect(METERLESS_CHAT_TIMEOUT_MS).toBe(180_000);
  });

  it("parses a connect link and leaves every other paste alone", () => {
    const full = parseConnectLink("http://127.0.0.1:8088/connect#k=abc");
    expect(full).toEqual({
      baseUrl: "http://127.0.0.1:8088/v1",
      token: "abc",
      model: null,
      healthUrl: "http://127.0.0.1:8088/healthz",
    });
    const withModel = parseConnectLink("http://10.0.0.8:8090/connect#k=abc&m=meterless/fast&n=other-app");
    expect(withModel?.baseUrl).toBe("http://10.0.0.8:8090/v1");
    expect(withModel?.token).toBe("abc");
    expect(withModel?.model).toBe("meterless/fast");
    expect(parseConnectLink("http://127.0.0.1:8088/connect/#k=abc")?.token).toBe("abc");
    expect(parseConnectLink("https://runtime.example:8443/connect#k=abc")?.baseUrl).toBe("https://runtime.example:8443/v1");
    expect(parseConnectLink("http://127.0.0.1:8088/connect#k=abc%2Bdef%2Fgh")?.token).toBe("abc+def/gh");
    expect(parseConnectLink("http://127.0.0.1:8088/v1")).toBeNull();
    expect(parseConnectLink("http://127.0.0.1:8088/connect")).toBeNull();
    expect(parseConnectLink("http://127.0.0.1:8088/v1#k=secret")).toBeNull();
    const stripped = normalizeMeterlessBase("http://127.0.0.1:8088/v1#k=secret");
    expect(stripped).toBe("http://127.0.0.1:8088/v1");
    expect(stripped.includes("secret")).toBe(false);
  });

  it("keeps unrecognised meterless ids and drops other providers", () => {
    const ids = meterlessModelIds({
      data: [
        { id: "meterless/auto" },
        { id: "gpt-4" },
        { id: "meterless/text.deep" },
        { id: "meterless/not-a-real-class" },
        "meterless/fusion",
        { id: "meterless/auto" },
      ],
    });
    expect(ids).toEqual([
      "meterless/auto",
      "meterless/text.deep",
      "meterless/not-a-real-class",
      "meterless/fusion",
    ]);
  });
});

describe("meterless runtime", () => {
  let runtime: http.Server;

  beforeAll(async () => {
    runtime = await listen(8088, async (request, response) => {
      const body = await readBody(request);
      seen.push({
        url: request.url ?? "",
        method: request.method ?? "",
        headers: request.headers,
        body,
      });
      const authorized = request.headers.authorization === "Bearer good-token";
      if (!authorized) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "bad token" } }));
        return;
      }
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: [
            { id: "meterless/auto" },
            { id: "meterless/fast" },
            { id: "meterless/text.deep" },
            { id: "meterless/not-a-real-class" },
            { id: "gpt-4" },
          ],
        }));
        return;
      }
      if (request.url === "/v1/chat/completions" && request.method === "POST") {
        const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ role?: string; content?: unknown }> };
        const user = parsed.messages?.find((message) => message.role === "user");
        if (typeof user?.content !== "string") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "content must be a string" } }));
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "x-meterless-model": "nvidia/nemotron-lane",
        });
        response.end(JSON.stringify({
          model: "nvidia/nemotron-super",
          meterless: { lane: "nvidia/nemotron-lane" },
          choices: [{ message: { role: "assistant", content: "Hello from the lane." } }],
        }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "missing" } }));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      runtime.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(envFile, { force: true });
    restoreEnv();
  });

  beforeEach(() => {
    seen.length = 0;
    useRuntimeEnv();
  });

  it("treats a wrong token as unauthorized, not offline", async () => {
    useRuntimeEnv("wrong-token");
    const health = await meterlessHealth();
    expect(health).toBe("unauthorized");
    const test = await testMeterlessConnection();
    expect(test.status).toBe("unauthorized");
    expect(test.detail).toBe("unauthorized");
    expect(test.token_key).toBe("meterless_runtime_token");
    expect(test.reply).toBeUndefined();
    expect(seen.some((request) => request.url === "/healthz")).toBe(false);
  });

  it("rejects the rt-local placeholder before a call", async () => {
    useRuntimeEnv("rt-local");
    expect(await meterlessHealth()).toBe("unauthorized");
    expect(seen).toHaveLength(0);
    await expect(completePlainText("Say hello in one sentence.")).rejects.toThrow(/rt-local/);
    expect(seen).toHaveLength(0);
  });

  it("finds the runtime with auto detect and returns a string from meterless/auto", async () => {
    useRuntimeEnv("wrong-token", "http://127.0.0.1:9/v1");
    const found = await autoDetectMeterless();
    expect(found).toEqual({ baseUrl: "http://127.0.0.1:8088/v1", status: "unauthorized" });
    expect(fs.readFileSync(envFile, "utf8")).toContain("METERLESS_BASE_URL=http://127.0.0.1:8088/v1");
    expect(seen.some((request) => request.url === "/healthz")).toBe(false);

    useRuntimeEnv("good-token", "http://127.0.0.1:8088/v1/chat/completions");
    seen.length = 0;
    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown, ...rest: unknown[]) => {
      lines.push([message, ...rest].map((part) => String(part)).join(" "));
    };
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "maize-trace-"));
    const tracer = createTracer("abcdef12-3456-4789-8abc-def012345678", logDir, { county: "Kirinyaga", mode: "advise" });
    const ctx: RunContext = {
      tracer,
      agent: "smoke",
      queryCache: new Map(),
      dataSource: () => null,
      markSampleFallback() {},
      markNarrativeFallback() {},
      modelAnswer: { provider: null, model: null },
    };
    let reply = "";
    try {
      reply = await runContext.run(ctx, () => completePlainText("Say hello in one sentence."));
    } finally {
      console.log = original;
      tracer.finish();
    }
    expect(typeof reply).toBe("string");
    expect(reply).toBe("Hello from the lane.");
    const chatEvent = tracer.events.find((event) => event.action === "chat" && event.status === "success");
    expect(chatEvent?.model).toBe("nvidia/nemotron-super");
    expect(chatEvent?.lane).toBe("nvidia/nemotron-lane");
    expect(chatEvent?.provider).toBe("meterless");
    expect(typeof chatEvent?.latency_ms).toBe("number");
    expect(lines.some((line) => /\[\d{2}:\d{2}:\d{2}\] smoke -> - \| chat \| success \|/.test(line))).toBe(true);
    const chat = seen.find((request) => request.method === "POST");
    expect(chat?.url).toBe("/v1/chat/completions");
    expect(chat?.headers["meterless-scope"]).toBe("user");
    expect(chat?.headers["meterless-app"]).toBe("open-agent-maize");
    expect(chat?.headers.authorization).toBe("Bearer good-token");
    const payload = JSON.parse(chat?.body ?? "{}") as { model: string; messages: Array<{ content: unknown }> };
    expect(payload.model).toBe("meterless/auto");
    expect(payload.messages.every((message) => typeof message.content === "string")).toBe(true);

    const test = await testMeterlessConnection();
    expect(test.status).toBe("online");
    expect(test.detail).toBe("online");
    expect(typeof test.reply).toBe("string");
    expect(test.model).toBe("nvidia/nemotron-super");
    const models = seen.find((request) => request.method === "GET");
    expect(models?.url).toBe("/v1/models");
    expect(models?.headers["meterless-app"]).toBe("open-agent-maize");
    expect(models?.headers["meterless-scope"]).toBeUndefined();
    expect(models?.headers.authorization).toBe("Bearer good-token");
    expect(seen.every((request) => !request.url.includes("/v1/v1"))).toBe(true);
    expect(knownMeterlessModels().ids).toContain("meterless/not-a-real-class");
    expect(knownMeterlessModels().ids).not.toContain("gpt-4");
    expect(knownMeterlessModels().source).toBe("runtime");
  });

  it("stays offline when models is not a meterless catalogue", async () => {
    const decoy = await listen(0, async (request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(request.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-4" }] }));
    });
    const address = decoy.address();
    const port = address && typeof address === "object" ? address.port : 0;
    useRuntimeEnv("good-token", `http://127.0.0.1:${port}/v1`);
    expect(await meterlessHealth()).toBe("offline");
    await new Promise<void>((resolve, reject) => {
      decoy.close((error) => (error ? reject(error) : resolve()));
    });

    const forbidden = await listen(0, (_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "forbidden" } }));
    });
    const forbiddenAddress = forbidden.address();
    const forbiddenPort = forbiddenAddress && typeof forbiddenAddress === "object" ? forbiddenAddress.port : 0;
    useRuntimeEnv("good-token", `http://127.0.0.1:${forbiddenPort}/v1`);
    expect(await meterlessHealth()).toBe("unauthorized");
    await new Promise<void>((resolve, reject) => {
      forbidden.close((error) => (error ? reject(error) : resolve()));
    });

    useRuntimeEnv("good-token", `http://127.0.0.1:${port}/v1`);
    expect(await meterlessHealth()).toBe("offline");
  });

  it("stores a pasted connect link without logging the key", async () => {
    const key = "paste-key-42";
    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message?: unknown, ...rest: unknown[]) => {
      lines.push([message, ...rest].map((part) => String(part)).join(" "));
    };
    console.error = (message?: unknown, ...rest: unknown[]) => {
      lines.push([message, ...rest].map((part) => String(part)).join(" "));
    };
    try {
      const applied = applyConnectLink(`http://127.0.0.1:8088/connect#k=${key}&m=meterless/fast`);
      expect(applied).toEqual({ baseUrl: "http://127.0.0.1:8088/v1", model: "meterless/fast" });
      expect(meterlessSettings().token).toBe(key);
      expect(meterlessSettings().baseUrl).toBe("http://127.0.0.1:8088/v1");
      const stored = fs.readFileSync(envFile, "utf8");
      expect(stored).toContain(`METERLESS_RUNTIME_TOKEN=${key}`);
      expect(stored).not.toContain("/connect#");
      expect(await meterlessHealth()).toBe("unauthorized");
      expect(lines.some((line) => line.includes(key) || line.includes("#k=") || line.includes("/connect"))).toBe(false);
      expect(parseConnectLink("http://127.0.0.1:8088/v1")).toBeNull();
      expect(applyConnectLink("http://127.0.0.1:8088/v1")).toBeNull();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it("exposes test and detect actions", async () => {
    useRuntimeEnv("good-token");
    const app = buildServer();
    const test = await app.inject({ method: "POST", url: "/meterless/test" });
    expect(test.statusCode).toBe(200);
    const testBody = test.json() as { status: string; reply?: unknown; model?: string };
    expect(testBody.status).toBe("online");
    expect(typeof testBody.reply).toBe("string");
    expect(testBody.model).toBe("nvidia/nemotron-super");
    expect(JSON.stringify(testBody)).not.toContain("good-token");

    useRuntimeEnv("wrong-token", "http://127.0.0.1:9/v1");
    const detect = await app.inject({ method: "POST", url: "/meterless/detect" });
    expect(detect.json()).toMatchObject({ status: "unauthorized", base_url: "http://127.0.0.1:8088/v1" });

    const selected = await app.inject({
      method: "POST",
      url: "/meterless/model",
      payload: { model: "meterless/not-a-real-class" },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({ model: "meterless/not-a-real-class" });
    expect(selectMeterlessModel("gpt-4")).toBe(false);
    await app.close();
  });
});

describe("nvidia provider", () => {
  const nvidiaKey = "unit-nvidia-key";
  let sawModels = false;
  let rateLimitNext = false;
  let lastHeaders: http.IncomingHttpHeaders = {};
  let lastBody = "";
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    server = await listen(0, async (request, response) => {
      const body = await readBody(request);
      if (request.url === "/v1/models") sawModels = true;
      if (request.method === "POST") {
        lastHeaders = request.headers;
        lastBody = body;
        if (rateLimitNext) {
          rateLimitNext = false;
          response.writeHead(429, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "slow down" } }));
          return;
        }
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
        if (parsed.messages?.some((message) => message.content === "fail")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "lane refused" } }));
          return;
        }
        const tiny = parsed.messages?.some((message) => message.content === "ok");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: "nvidia/nemotron-3.5-lightning-30b-a3b",
          choices: [{ message: { role: "assistant", content: tiny ? "ok" : "Hello from NVIDIA." } }],
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    base = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreEnv();
  });

  beforeEach(() => {
    sawModels = false;
    rateLimitNext = false;
    process.env.MODEL_PROVIDER = "nvidia";
    process.env.NVIDIA_BASE_URL = base;
    process.env.NVIDIA_API_KEY = nvidiaKey;
    process.env.NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
    process.env.METERLESS_ENV_FILE = envFile;
    resetConfigForTests();
  });

  it("checks health with one chat completion and keeps meterless headers off NVIDIA", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown, ...rest: unknown[]) => {
      lines.push([message, ...rest].map((part) => String(part)).join(" "));
    };
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "maize-nvidia-"));
    const tracer = createTracer("bbbbbbbb-3456-4789-8abc-def012345678", logDir, { county: "Nakuru", mode: "advise" });
    const ctx: RunContext = {
      tracer,
      agent: "smoke",
      queryCache: new Map(),
      dataSource: () => null,
      markSampleFallback() {},
      markNarrativeFallback() {},
      modelAnswer: { provider: null, model: null },
    };
    try {
      const health = await runContext.run(ctx, () => nvidiaHealth());
      expect(health.status).toBe("online");
      expect(health.provider).toBe("nvidia");
      expect(typeof health.reply).toBe("string");
      expect(sawModels).toBe(false);
      const result = await runContext.run(ctx, () => chat({ agent: "Planner", system: "Reply with one sentence.", user: "Say hello in one sentence." }));
      expect(result.provider).toBe("nvidia");
      expect(result.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
      expect(typeof result.text).toBe("string");
      expect(result.text).toBe("Hello from NVIDIA.");
    } finally {
      console.log = original;
      tracer.finish();
    }
    const sent = JSON.parse(lastBody) as { model?: string; messages?: Array<{ content?: unknown }> };
    expect(sent.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(sent.messages?.every((message) => typeof message.content === "string")).toBe(true);
    expect(lastHeaders.authorization).toBe(`Bearer ${nvidiaKey}`);
    expect(lastHeaders["meterless-app"]).toBeUndefined();
    expect(lastHeaders["meterless-scope"]).toBeUndefined();
    expect(tracer.events.some((event) => event.action === "chat" && event.provider === "nvidia" && event.model === "nvidia/nemotron-3.5-lightning-30b-a3b" && typeof event.latency_ms === "number")).toBe(true);
    expect(lines.some((line) => /\[\d{2}:\d{2}:\d{2}\] /.test(line) && line.includes("| chat |"))).toBe(true);
    expect(lines.some((line) => line.includes("provider=meterless") || line.includes(nvidiaKey))).toBe(false);
    const note = wordingFallbackNote();
    expect(note).toContain("computed figures");
    expect(note).toContain("nvidia");
    expect(note).toContain("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(note.includes("Meterless")).toBe(false);
  }, 15_000);

  it("retries HTTP 429 after 2 seconds and then returns a string", async () => {
    rateLimitNext = true;
    const started = Date.now();
    const result = await chat({ agent: "Planner", system: "Reply with one sentence.", user: "Say hello in one sentence." });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(result.fallback).toBe(false);
    expect(result.text).toBe("Hello from NVIDIA.");
    expect(result.provider).toBe("nvidia");
    const failed = await chat({ agent: "RiskCritic", system: "Reply with one sentence.", user: "fail" });
    expect(failed.provider).toBe("nvidia");
    expect(failed.fallback).toBe(true);
    expect(failed.detail).toContain("lane refused");
  }, 15_000);
});
