import { loadConfig, redact } from "../src/config.js";
import { autoDetectMeterless, meterlessHealth, nvidiaHealth, testMeterlessConnection } from "../src/adapters/meterless.js";
import { runSql } from "../src/adapters/zetaris.js";

loadConfig();

try {
  const rows = await runSql("SELECT 1");
  console.log(`Zetaris: PASS rows=${rows.length}`);
} catch (error) {
  const message = redact(error instanceof Error ? error.message : "error");
  console.log(`Zetaris: FAIL ${message}`);
}

async function reportMeterless(): Promise<void> {
  let health = await meterlessHealth();
  if (health === "offline") {
    const found = await autoDetectMeterless();
    if (found) health = found.status === "online" ? await meterlessHealth() : found.status;
  }
  if (health === "unauthorized") {
    console.log("Meterless: FAIL unauthorized");
    return;
  }
  if (health !== "online") {
    console.log("Meterless: FAIL offline");
    return;
  }
  const test = await testMeterlessConnection();
  if (test.status === "online" && typeof test.reply === "string") {
    console.log(`Meterless: PASS online model=${test.model ?? ""} reply=string`);
    return;
  }
  console.log(`Meterless: FAIL ${test.status}`);
}

async function reportNvidia(): Promise<void> {
  const health = await nvidiaHealth();
  if (health.status === "online" && typeof health.reply === "string") {
    console.log(`NVIDIA: PASS online model=${health.model} reply=string`);
    return;
  }
  console.log(`NVIDIA: FAIL ${health.status}`);
}

const selected = loadConfig().MODEL_PROVIDER;
if (selected === "nvidia") {
  console.log("Meterless: SKIPPED");
  await reportNvidia();
} else {
  console.log("NVIDIA: SKIPPED");
  await reportMeterless();
}
