import Fastify, { type FastifyInstance } from "fastify";
import { redact } from "./config.js";
import { NotImplementedError } from "./errors.js";
import { runCase } from "./orchestration/graph.js";
import { RunRequestSchema } from "./schemas.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

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
