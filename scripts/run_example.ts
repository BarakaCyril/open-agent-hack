import fs from "node:fs";
import path from "node:path";
import { runCase } from "../src/orchestration/graph.js";
import { RunRequestSchema } from "../src/schemas.js";
import { projectRoot } from "../src/config.js";

const examplePath = path.join(projectRoot(), "input_examples", "example_1.json");
const raw = fs.readFileSync(examplePath, "utf-8");
const request = RunRequestSchema.parse(JSON.parse(raw));

console.log(`Running case for farmer: ${request.farmer_id} in county: ${request.county}...`);
const response = await runCase(request);

console.log("\n==================== VERDICT ====================");
console.log(`Verdict: ${response.verdict.toUpperCase()}`);
console.log(`Data Source: ${response.data_source}`);
console.log(`Confidence: ${(response.confidence * 100).toFixed(0)}%`);
console.log(`Price Range (KES): P10=${response.price_range_per_90kg_bag?.p10}, P50=${response.price_range_per_90kg_bag?.p50}, P90=${response.price_range_per_90kg_bag?.p90}`);
console.log(`Hold Days: ${response.hold_days ?? "N/A"}`);
console.log(`Plain Reply: ${response.plain_reply}`);
console.log(`Reasoning Trace: ${response.reasoning_trace_summary}`);
console.log(`What Would Change Advice: ${response.what_would_change_this_advice.join("; ")}`);
console.log(`Recheck Schedule: ${response.recheck_schedule}`);
console.log("=================================================\n");
