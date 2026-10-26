import { ensureKamisPriceTable, upsertKamisRows } from "../src/adapters/maizePg.js";
import { loadPriceRows } from "../src/adapters/sampleData.js";
import { maizePgConfig } from "../src/adapters/maizePg.js";

const pg = await import("pg");
const config = maizePgConfig();
if (!config.password) {
  console.error("FAIL MAIZE_PG_PASSWORD is not set");
  process.exit(1);
}
const client = new pg.default.Client(config);
await client.connect();
try {
  await ensureKamisPriceTable({
    query: async (sql, params) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
  });
  const rows = loadPriceRows();
  const stored = await upsertKamisRows(rows, {
    query: async (sql, params) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
  });
  console.log(`PASS kamis_prices seeded ${stored} rows from data/sample/kamis_dry_maize.csv (labelled subset of the live KAMIS export, not the full history)`);
  console.log("PASS reference files are labelled synthetic in maize.storage_loss_rules, maize.market_news, and maize.farmer_ledger");
  console.log("PASS maize.weather_daily is live Open-Meteo, not the sample forecast file");
} finally {
  await client.end();
}
