import { afterEach, describe, expect, it } from "vitest";
import { setSqlRunnerForTests } from "../src/adapters/zetaris.js";
import { buildServer } from "../src/server.js";
import { METERLESS_PROVIDER_NAME, METERLESS_TOKEN_KEY } from "../src/adapters/meterless.js";
import { resetConfigForTests } from "../src/config.js";

describe("server", () => {
  afterEach(() => setSqlRunnerForTests(null));

  it("answers GET /health", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("lists Meterless Runtime as the primary reasoning provider", async () => {
    process.env.MODEL_PROVIDER = "meterless";
    resetConfigForTests();
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/providers" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      primary: string;
      providers: Array<Record<string, unknown>>;
    };
    expect(body.primary).toBe("meterless");
    const meterless = body.providers.find((provider) => provider.id === "meterless");
    const nvidia = body.providers.find((provider) => provider.id === "nvidia");
    expect(meterless).toMatchObject({
      name: METERLESS_PROVIDER_NAME,
      role: "reasoning",
      selected: true,
      token_key: METERLESS_TOKEN_KEY,
      model: "meterless/auto",
    });
    expect(nvidia).toMatchObject({ name: "NVIDIA", role: "reasoning", selected: false });
    expect(meterless && "token" in meterless).toBe(false);
    expect(nvidia && "token" in nvidia).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Bearer");
    await app.close();
  });

  it("rejects a routing mode that is not meterless/*", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/meterless/model",
      payload: { model: "gpt-4" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("lists maize.counties with coverage from kamis_prices", async () => {
    setSqlRunnerForTests(async (sql) => {
      if (sql.includes("FROM maize.counties")) {
        return [{ county: "Kirinyaga" }, { county: "Garissa" }, { county: "Uasin Gishu" }];
      }
      return [{ county: "Kirinyaga", n: 8 }, { county: "Garissa", n: 1 }, { county: "Uasin Gishu", n: 3 }];
    });
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/counties" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { source: string; counties: Array<{ county: string; coverage: string }> };
    expect(body.source).toBe("zetaris");
    expect(body.counties.map((row) => row.county)).toEqual(["Kirinyaga", "Garissa", "Uasin Gishu"]);
    expect(body.counties.find((row) => row.county === "Garissa")?.coverage).toBe("limited");
    expect(body.counties.find((row) => row.county === "Kirinyaga")?.coverage).toBe("supported");
    await app.close();
  });

  it("returns 404 for an unknown trace", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/trace/00000000-0000-4000-8000-000000000000" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "trace not found" });
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
