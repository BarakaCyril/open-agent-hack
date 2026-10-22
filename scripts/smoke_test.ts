import { loadConfig, redact } from "../src/config.js";
import { meterlessHealth } from "../src/adapters/meterless.js";
import { runSql } from "../src/adapters/zetaris.js";

loadConfig();

try {
  const rows = await runSql("SELECT 1");
  console.log(`Zetaris: PASS rows=${rows.length}`);
} catch (error) {
  const message = redact(error instanceof Error ? error.message : "error");
  console.log(`Zetaris: FAIL ${message}`);
}

const health = await meterlessHealth();
if (health === "online") console.log("Meterless: PASS online");
else console.log(`Meterless: FAIL ${health}`);
