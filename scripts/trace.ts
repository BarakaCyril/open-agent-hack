import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { formatTraceTable, readTraceEvents, resolveLogDir } from "../src/tracing.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run trace -- <file|latest>");
  process.exit(1);
}

function resolveArg(value: string): string {
  if (value === "latest") return path.join(resolveLogDir(loadConfig().LOG_DIR), "latest.jsonl");
  const direct = path.resolve(value);
  if (fs.existsSync(direct)) return direct;
  const inLogs = path.join(resolveLogDir(loadConfig().LOG_DIR), value);
  if (fs.existsSync(inLogs)) return inLogs;
  return direct;
}

const file = resolveArg(arg);
if (!fs.existsSync(file)) {
  console.error(`trace file not found: ${arg}`);
  process.exit(1);
}

const resolved = fs.realpathSync(file);
const events = readTraceEvents(resolved);
console.log(resolved);
console.log(formatTraceTable(events));
