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
  if (value === "latest") {
    const logDir = resolveLogDir(loadConfig().LOG_DIR);
    const latestFile = path.join(logDir, "latest.jsonl");
    try {
      if (fs.lstatSync(latestFile).isSymbolicLink()) {
        return latestFile;
      }
    } catch {
      // ignore
    }
    try {
      const files = fs.readdirSync(logDir)
        .filter((n) => n.endsWith(".jsonl") && n !== "latest.jsonl")
        .map((n) => ({ name: n, mtime: fs.statSync(path.join(logDir, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files[0]) {
        return path.join(logDir, files[0].name);
      }
    } catch {
      // ignore
    }
    return latestFile;
  }
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
