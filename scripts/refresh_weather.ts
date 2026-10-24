import { loadConfig } from "../src/config.js";
import { refreshWeather } from "../src/tools/refreshWeather.js";

const county = process.argv[2]?.trim();
if (!county) {
  console.error("usage: npx tsx scripts/refresh_weather.ts <county>");
  process.exit(1);
}

loadConfig();
const report = await refreshWeather(county);
console.log(`${report.status}: fetched ${report.fetched}, stored ${report.stored}, rejected ${report.rejected}. ${report.detail}`);
process.exit(report.status === "success" || report.status === "skipped" ? 0 : 1);
