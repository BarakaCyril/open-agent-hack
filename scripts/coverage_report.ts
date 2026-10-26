import { maizePgConfig } from "../src/adapters/maizePg.js";
import { loadConfig } from "../src/config.js";
import { COVERAGE_WINDOW_DAYS, SUPPORTED_MIN_QUOTES, coverageFromQuoteCount, postgresCountyQuoteSql } from "../src/tools/coverage.js";
import { loadCountyCatalog } from "../src/tools/counties.js";

loadConfig();
const config = maizePgConfig();
if (!config.password) {
  console.error("MAIZE_PG_PASSWORD is not set");
  process.exit(1);
}
const pg = await import("pg");
const client = new pg.default.Client({ ...config, password: String(config.password) });
await client.connect();
let failed = false;
try {
  const result = await client.query(postgresCountyQuoteSql());
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const county = String(row.county ?? "").trim();
    const n = Number(row.n);
    if (county) counts.set(county, Number.isFinite(n) ? n : 0);
  }
  for (const entry of loadCountyCatalog()) {
    const known = [...counts.keys()].find((name) => name.toLowerCase() === entry.county.toLowerCase());
    if (!known) counts.set(entry.county, 0);
  }
  const lines = [...counts.entries()]
    .map(([county, quotes]) => ({ county, quotes, coverage: coverageFromQuoteCount(quotes) }))
    .sort((a, b) => b.quotes - a.quotes || a.county.localeCompare(b.county));
  console.log(`dry maize quotes in the last ${COVERAGE_WINDOW_DAYS} days (${SUPPORTED_MIN_QUOTES} or more is supported)`);
  const width = Math.max(6, ...lines.map((line) => line.county.length));
  console.log(`${"county".padEnd(width)}  quotes  coverage`);
  for (const line of lines) {
    console.log(`${line.county.padEnd(width)}  ${String(line.quotes).padStart(6)}  ${line.coverage}`);
  }
  const supported = lines.filter((line) => line.coverage === "supported").map((line) => line.county);
  console.log(`supported: ${supported.join(", ") || "(none)"}`);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : "coverage report failed");
} finally {
  await client.end();
}
if (failed) process.exit(1);
