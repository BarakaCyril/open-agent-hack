import { afterEach, describe, expect, it } from "vitest";
import { upsertKamisRows, type PgClient } from "../src/adapters/maizePg.js";
import {
  RemoteSourceError,
  ZetarisQueryError,
  ZetarisUnavailableError,
  listCounties,
  readPrices,
  setSqlRunnerForTests,
} from "../src/adapters/zetaris.js";
import { resetConfigForTests } from "../src/config.js";
import { buildServer } from "../src/server.js";

const savedSample = process.env.SAMPLE_MODE;

afterEach(() => {
  setSqlRunnerForTests(null);
  if (savedSample === undefined) delete process.env.SAMPLE_MODE;
  else process.env.SAMPLE_MODE = savedSample;
  resetConfigForTests();
});

describe("Zetaris failure semantics", () => {
  it("does not substitute sample rows when Zetaris answers and the query fails", async () => {
    process.env.SAMPLE_MODE = "true";
    resetConfigForTests();
    setSqlRunnerForTests(async (sql) => {
      if (/select\s+1\b/iu.test(sql)) return [{ ok: 1 }];
      throw new RemoteSourceError("table maize.kamis_prices failed", { unreachable: false });
    });
    await expect(readPrices("Kirinyaga")).rejects.toBeInstanceOf(ZetarisQueryError);
  });

  it("retries a timed-out query once and does not substitute sample rows", async () => {
    process.env.SAMPLE_MODE = "true";
    resetConfigForTests();
    let priceCalls = 0;
    setSqlRunnerForTests(async (sql) => {
      if (/select\s+1\b/iu.test(sql)) return [{ ok: 1 }];
      priceCalls += 1;
      throw new RemoteSourceError("Zetaris timed out after 12s", { timeout: true, unreachable: true });
    });
    await expect(readPrices("Kirinyaga")).rejects.toBeInstanceOf(ZetarisQueryError);
    expect(priceCalls).toBe(2);
  });

  it("uses labelled offline sample rows only when Zetaris is unreachable and SAMPLE_MODE is true", async () => {
    process.env.SAMPLE_MODE = "true";
    resetConfigForTests();
    setSqlRunnerForTests(async () => {
      throw new RemoteSourceError("Zetaris connection failed", { unreachable: true });
    });
    const hit = await readPrices("Kirinyaga");
    expect(hit.via).toBe("sample");
    expect(hit.evidenceSource).toBe("sample:kamis_dry_maize.csv");
    expect(hit.value.length).toBeGreaterThan(0);
    expect(hit.value.every((row) => row.county === "Kirinyaga")).toBe(true);
  });

  it("returns a structured unavailable error when Zetaris is unreachable and SAMPLE_MODE is false", async () => {
    process.env.SAMPLE_MODE = "false";
    resetConfigForTests();
    setSqlRunnerForTests(async () => {
      throw new RemoteSourceError("Zetaris connection failed", { unreachable: true });
    });
    await expect(readPrices("Kirinyaga")).rejects.toBeInstanceOf(ZetarisUnavailableError);
  });

  it("filters the weather read to the requested county", async () => {
    const seen: string[] = [];
    setSqlRunnerForTests(async (sql) => {
      seen.push(sql);
      if (/select\s+1\b/iu.test(sql)) return [{ ok: 1 }];
      return [];
    });
    const { readWeather } = await import("../src/adapters/zetaris.js");
    await readWeather("Uasin Gishu");
    expect(seen.some((sql) => sql.includes("FROM maize.weather_daily WHERE county = 'Uasin Gishu'"))).toBe(true);
    expect(seen.some((sql) => sql.includes("UNION"))).toBe(false);
  });
});

describe("county coverage", () => {
  it("marks a county limited when it has fewer than 3 dry-maize quotes", async () => {
    setSqlRunnerForTests(async (sql) => {
      if (sql.includes("FROM maize.counties")) return [{ county: "Nyandarua" }, { county: "Kirinyaga" }];
      return [{ county: "Kirinyaga", n: 4 }];
    });
    const listed = await listCounties();
    expect(listed.counties.find((row) => row.county === "Nyandarua")).toMatchObject({
      coverage: "limited",
      dry_maize_quotes_14d: 0,
    });
    expect(listed.counties.find((row) => row.county === "Kirinyaga")?.coverage).toBe("supported");
  });

  it("returns 400 for a county that is not in maize.counties", async () => {
    setSqlRunnerForTests(async (sql) => {
      if (sql.includes("FROM maize.counties")) return [{ county: "Kirinyaga" }];
      return [{ county: "Kirinyaga", n: 5 }];
    });
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/run",
      payload: {
        farmer_id: "farmer-kirinyaga-003",
        county: "Mars",
        bags: 20,
        storage: "open_bags",
        mode: "advise",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "unknown_county" });
    await app.close();
  });

  it("returns 503 when the county list cannot reach Zetaris and sample mode is off", async () => {
    process.env.SAMPLE_MODE = "false";
    resetConfigForTests();
    setSqlRunnerForTests(async () => {
      throw new RemoteSourceError("Zetaris connection failed", { unreachable: true });
    });
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/counties" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "zetaris_unavailable" });
    await app.close();
  });
});

describe("postgres price upsert", () => {
  it("upserts only the parsed rows on the primary key", async () => {
    const statements: string[] = [];
    const client: PgClient = {
      async query(sql, params) {
        statements.push(sql);
        expect(params ?? []).not.toContain(9999);
        return { rows: [], rowCount: 1 };
      },
    };
    const stored = await upsertKamisRows([{
      market_date: "2026-10-18",
      county: "Kirinyaga",
      market_name: "Ngurubani Market",
      commodity: "Dry Maize",
      variety: "White Maize",
      grade: "Grade 1",
      unit_kg: 90,
      wholesale_price_kes: 3450,
      retail_price_kes: 3800,
      volume_bags: 120,
    }], client);
    expect(stored).toBe(1);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("ON CONFLICT (market_date, county, market_name, commodity, variety, grade, unit_kg)");
    expect(statements[1]).toContain("DO UPDATE SET");
    expect(statements[2]).toBe("COMMIT");
  });
});
