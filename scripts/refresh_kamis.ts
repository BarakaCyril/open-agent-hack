import { loadConfig } from "../src/config.js";
import { refreshKamis } from "../src/tools/refreshKamis.js";

loadConfig();
const report = await refreshKamis();
console.log(`${report.status}: fetched ${report.fetched}, stored ${report.stored}, rejected ${report.rejected}. ${report.detail}`);
process.exit(report.status === "success" ? 0 : 1);
