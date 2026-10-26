import { loadConfig } from "../src/config.js";
import { runKamisBackfill } from "../src/tools/kamisBackfill.js";
import { positiveInt } from "../src/tools/refreshReport.js";

loadConfig();
const code = await runKamisBackfill({
  maxPages: positiveInt(process.env.BACKFILL_MAX_PAGES, 40, 500),
});
process.exit(code);
