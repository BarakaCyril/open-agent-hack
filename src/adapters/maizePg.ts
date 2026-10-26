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

/**
 * The price table must match the ON CONFLICT key. An older maize-db used source_row
 * as its only primary key, which CREATE TABLE IF NOT EXISTS does not replace.
 */
export async function ensureKamisPriceTable(client: PgClient): Promise<void> {
  await client.query(KAMIS_TABLE_SQL);
  const columns = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'kamis_prices'",
  );
  const names = new Set(columns.rows.map((row) => String(row.column_name)));
  if (names.has("source_row")) {
    await client.query("ALTER TABLE kamis_prices DROP CONSTRAINT IF EXISTS kamis_prices_pkey");
    await client.query("ALTER TABLE kamis_prices DROP COLUMN source_row");
  }
  const primary = await client.query(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'kamis_prices'::regclass AND contype = 'p'",
  );
  const definition = String(primary.rows[0]?.def ?? "");
  if (!definition.includes("market_date")) {
    await client.query(
      "ALTER TABLE kamis_prices ADD PRIMARY KEY (market_date, county, market_name, commodity, variety, grade, unit_kg)",
    );
  }
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
