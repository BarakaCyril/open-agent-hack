import fs from "node:fs";
import path from "node:path";
import { executeStatement } from "../src/adapters/zetaris.js";
import { loadConfig, projectRoot, redact } from "../src/config.js";

const file = path.join(projectRoot(), "zetaris", "setup_maize.sql");
const mode = process.argv.includes("--after-seed") ? "after" : "until";

function blocks(text: string): string[] {
  const [before = "", after = ""] = text.split(/--\s*@seed\b/u);
  const chosen = mode === "after" ? after : before;
  const statements: string[] = [];
  let current = "";
  for (const line of chosen.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    current += `${line}\n`;
    if (line.trim().endsWith(";")) {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function existsError(message: string): boolean {
  return /already exists/iu.test(message);
}

loadConfig();
const statements = blocks(fs.readFileSync(file, "utf8"));
let failed = 0;
for (const [index, original] of statements.entries()) {
  const label = redact(original.replace(/\s+/g, " ").slice(0, 90));
  let statement = original;
  if (statement.includes("MAIZE_PG_PASSWORD")) {
    const secret = process.env.MAIZE_PG_PASSWORD ?? "";
    if (!secret) {
      failed += 1;
      console.log(`FAIL ${index + 1} ${label} MAIZE_PG_PASSWORD is not set`);
      continue;
    }
    statement = statement.replaceAll("MAIZE_PG_PASSWORD", secret);
  }
  try {
    await executeStatement(statement);
    console.log(`PASS ${index + 1} ${label}`);
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : "statement failed");
    if (existsError(message)) {
      console.log(`PASS ${index + 1} ${label} skipped, already exists`);
      continue;
    }
    failed += 1;
    console.log(`FAIL ${index + 1} ${label} ${message}`);
  }
}
if (failed > 0) process.exit(1);
