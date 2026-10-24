import Fastify, { type FastifyInstance } from "fastify";
import {
  activeChatTarget,
  applyConnectLink,
  autoDetectMeterless,
  knownMeterlessModels,
  meterlessHealth,
  meterlessSettings,
  METERLESS_PROVIDER_NAME,
  METERLESS_TOKEN_KEY,
  selectMeterlessModel,
  testMeterlessConnection,
} from "./adapters/meterless.js";
import { loadConfig, redact } from "./config.js";
import { NotImplementedError } from "./errors.js";
import { runCase } from "./orchestration/graph.js";
import { RunRequestSchema } from "./schemas.js";
import { followTrace, hasTrace } from "./tracing.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/providers", async () => {
    const selected = activeChatTarget();
    const settings = meterlessSettings();
    const models = knownMeterlessModels();
    const nvidia = loadConfig();
    return {
      primary: selected.provider,
      providers: [
        {
          id: "meterless",
          name: METERLESS_PROVIDER_NAME,
          role: "reasoning",
          selected: selected.provider === "meterless",
          base_url: settings.baseUrl,
          model: settings.model,
          models: models.ids,
          models_source: models.source,
          token_key: METERLESS_TOKEN_KEY,
        },
        {
          id: "nvidia",
          name: "NVIDIA",
          role: "reasoning",
          selected: selected.provider === "nvidia",
          base_url: nvidia.NVIDIA_BASE_URL,
          model: nvidia.NVIDIA_MODEL,
        },
        {
          id: "zetaris",
          name: "Zetaris",
          role: "data",
          selected: true,
        },
      ],
    };
  });

  app.post("/meterless/test", async () => testMeterlessConnection());

  app.post("/meterless/detect", async () => {
    const found = await autoDetectMeterless();
    if (!found) return { status: "offline", detail: "offline" };
    return { status: found.status, detail: found.status, base_url: found.baseUrl };
  });

  app.post("/meterless/model", async (request, reply) => {
    const model = request.body && typeof request.body === "object" && "model" in request.body
      ? (request.body as { model?: unknown }).model
      : undefined;
    if (typeof model !== "string" || !selectMeterlessModel(model)) {
      return reply.code(400).send({ error: "model must be a meterless/* routing mode" });
    }
    return { model: meterlessSettings().model };
  });

  app.post("/meterless/connect", async (request, reply) => {
    const link = request.body && typeof request.body === "object" && "link" in request.body
      ? (request.body as { link?: unknown }).link
      : undefined;
    if (typeof link !== "string") return reply.code(400).send({ error: "invalid request" });
    const applied = applyConnectLink(link);
    if (!applied) return reply.code(400).send({ error: "not a connect link" });
    const status = await meterlessHealth();
    return {
      status,
      detail: status,
      base_url: applied.baseUrl,
      model: applied.model,
      ...(status === "unauthorized" ? { token_key: METERLESS_TOKEN_KEY } : {}),
    };
  });

  app.get("/run/:traceId/events", (request, reply) => {
    const traceId = (request.params as { traceId?: string }).traceId ?? "";
    const logDir = loadConfig().LOG_DIR;
    if (!traceId || !hasTrace(traceId, logDir)) {
      return reply.code(404).send({ error: "trace not found" });
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    const subscription = followTrace(traceId, logDir, {
      onEvent(event) {
        if (closed) return;
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      onEnd() {
        if (closed) return;
        closed = true;
        raw.write("event: end\ndata: {}\n\n");
        raw.end();
      },
    });
    raw.on("close", () => {
      closed = true;
      subscription.close();
    });
  });

  app.post("/run", async (request, reply) => {
    const parsed = RunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid request",
        details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`),
      });
    }
    const response = await runCase(parsed.data);
    return reply.send(response);
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = redact(error instanceof Error ? error.message : "request failed");
    console.error(`request failed: ${message}`);
    if (error instanceof NotImplementedError) return reply.code(501).send({ error: message });
    return reply.code(500).send({ error: message });
  });

  return app;
}
