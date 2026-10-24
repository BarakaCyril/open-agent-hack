import fs from "node:fs";
import path from "node:path";
import { loadConfig, projectRoot } from "../src/config.js";
import { hostDirectoryProblem } from "../src/tools/maizeFiles.js";
import { maizeDirectory } from "../src/tools/refreshReport.js";

const FILES = [
  "kamis_dry_maize.csv",
  "weather.json",
  "news.json",
  "storage_loss_rules.csv",
  "farmer_ledger.json",
];

loadConfig();
const directory = maizeDirectory();
const problem = hostDirectoryProblem(directory);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const sample = path.join(projectRoot(), "data", "sample");
for (const name of FILES) {
  fs.copyFileSync(path.join(sample, name), path.join(directory, name));
  console.log(`${name} -> ${directory}`);
}
