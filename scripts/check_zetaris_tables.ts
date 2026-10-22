import { loadConfig, redact } from "../src/config.js";
import { MAIZE_TABLES, maizeFrom, runSql } from "../src/adapters/zetaris.js";

loadConfig();

const tables = [
  MAIZE_TABLES.prices.table,
  MAIZE_TABLES.weather.table,
  MAIZE_TABLES.news.table,
  MAIZE_TABLES.rules.table,
  MAIZE_TABLES.ledger.table,
];

let failed = false;
for (const table of tables) {
  const sql = `SELECT COUNT(*) AS row_count FROM ${maizeFrom(table)}`;
  try {
    const rows = await runSql(sql, 1);
    const count = rows[0]?.row_count;
    console.log(`${table} ${count}`);
  } catch (error) {
    failed = true;
    const message = redact(error instanceof Error ? error.message : "error");
    console.log(`${table} FAIL ${message}`);
  }
}

if (failed) process.exit(1);
