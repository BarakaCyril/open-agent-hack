import { loadConfig } from "../config.js";
import type { KamisRow } from "./sampleData.js";

export const KAMIS_PRICE_KEY = [
  "market_date",
  "county",
  "market_name",
  "commodity",
  "variety",
  "grade",
  "unit_kg",
] as const;

export interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
}

const UPSERT_SQL = `INSERT INTO kamis_prices (
  market_date, county, market_name, commodity, variety, grade, unit_kg,
  wholesale_price_kes, retail_price_kes, volume_bags
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (market_date, county, market_name, commodity, variety, grade, unit_kg)
DO UPDATE SET
  wholesale_price_kes = EXCLUDED.wholesale_price_kes,
  retail_price_kes = EXCLUDED.retail_price_kes,
  volume_bags = EXCLUDED.volume_bags`;

export const KAMIS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kamis_prices (
  market_date date NOT NULL,
  county text NOT NULL,
  market_name text NOT NULL,
  commodity text NOT NULL,
  variety text NOT NULL,
  grade text NOT NULL,
  unit_kg integer NOT NULL,
  wholesale_price_kes double precision,
  retail_price_kes double precision,
  volume_bags integer,
  PRIMARY KEY (market_date, county, market_name, commodity, variety, grade, unit_kg)
)`;

let shared: PgClient | null = null;

export function maizePgConfig(): { host: string; port: number; user: string; password: string; database: string } {
  const config = loadConfig();
  return {
    host: config.MAIZE_PG_HOST,
    port: config.MAIZE_PG_PORT,
    user: config.MAIZE_PG_USER,
    password: config.MAIZE_PG_PASSWORD,
    database: config.MAIZE_PG_DATABASE,
  };
}

async function defaultClient(): Promise<PgClient> {
  if (shared) return shared;
  const config = maizePgConfig();
  if (!config.password) throw new Error("MAIZE_PG_PASSWORD is not set");
  const pg = await import("pg");
  const pool = new pg.default.Pool({ ...config, password: String(config.password), max: 4 });
  shared = {
    query: async (sql, params) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
  };
  return shared;
}

/** Insert or replace live parsed rows. The caller must not pass hand-written prices. */
export async function upsertKamisRows(rows: KamisRow[], client?: PgClient): Promise<number> {
  if (rows.length === 0) return 0;
  const db = client ?? await defaultClient();
  await db.query("BEGIN");
  try {
    for (const row of rows) {
      await db.query(UPSERT_SQL, [
        row.market_date,
        row.county,
        row.market_name,
        row.commodity,
        row.variety,
        row.grade,
        row.unit_kg,
        row.wholesale_price_kes,
        row.retail_price_kes,
        row.volume_bags,
      ]);
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return rows.length;
}
