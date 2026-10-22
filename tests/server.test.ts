import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("server", () => {
  it("answers GET /health", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("rejects an incomplete run body", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/run", payload: {} });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string };
    expect(body.error).toBe("invalid request");
    await app.close();
  });
});
