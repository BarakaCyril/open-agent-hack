# Open Agent Maize

Reasoning-architecture demo for the hackathon. A smallholder farmer in Kenya is deciding whether to sell white maize now, hold it, or split the lot. The default case is 20 bags of 90 kg. County is a parameter. The deep demo county is Kirinyaga, Ngurubani Market.

The service returns decision support. It is not financial advice and it does not place a trade.

## Problem

White-maize prices move, rain spoils grain that is stored in the open, and a thin county may have only one usable quote. The farmer needs a traceable comparison of selling at a stated offer versus holding through a short forecast, plus a clear stop when the evidence is too thin.

## User

A smallholder white-maize farmer. The request names the farmer, the county, the bag count, the storage type, an optional buyer offer per 90 kg bag, an optional cash need, and `advise` or `recheck`.

## Agents

| Agent | Responsibility | Can block or retry |
| --- | --- | --- |
| Planner | Loads memory, runs the per-county coverage gate, delegates, assembles the verdict from the expected-value tool, and sets the recheck date. | Blocks the run with `no_recommendation` when fresh white-maize quotes are below 3, or when the review loop gives up. |
| MarketAnalyst | Reads prices through the Zetaris helpers, drops outliers, builds P10/P50/P90, compares the offer with the county P50, and filters news to white maize. | Revises the claim when the critic rejects it (maize-type mismatch, contradiction, outlier, missing evidence). |
| StorageWeatherAnalyst | Reads `maize.weather_daily` for the requested county and the storage-loss rules, then turns them into an expected-loss distribution. | Revises when the critic rejects the claim. The forecast is the live Open-Meteo view, so there is no file refresh. |
| RiskCritic | Applies freshness, coverage, contradiction, missing evidence, outlier, maize-type mismatch, missing input, and farmer-limit checks. | Approves, sends the claim back, or escalates to a farmer question. |
| Watcher | On `mode: "recheck"`, loads the prior verdict from memory or the farmer ledger and compares it with the new run. | Records a HOLD to SELL change when the computed action is now sell and 7-day rain has risen by at least 10 mm. |

Shared case state holds the question, the farmer request, memory recall, claims with evidence, critic decisions, and revision and refresh counts. A hand-written loop runs Planner, then the two analysts, then RiskCritic. A rejection sends the claim back to the analyst that owns it. Revisions stop at 2. Stale-data refreshes stop at 2. The whole loop stops at 3 rounds. Low coverage, an impossible cash need, or a missing input escalates instead of spinning.

## What makes this an agent system

The agents do not form a straight line that always succeeds. They write claims into one case, the critic can reject those claims, and the owning analyst runs again with the rejection reasons. A stale forecast is a refresh, not the same revision counter. When the counters or the coverage gate say the evidence is not good enough, the planner stops with `no_recommendation` and a question. Watcher mode reruns a stored case and can show that a worsening forecast no longer supports the earlier HOLD. Every handoff is a line in the trace.

The sell, hold, or split verdict is the higher value from a fixed-seed Monte Carlo over the cleaned price band and the loss distribution. It is not a table of prewritten answers. If a model call fails, the wording falls back to those computed figures and the trace status is `fallback`. Unimplemented H-MEM wiring throws `NotImplementedError` instead of inventing a memory result (`HMEM_ENABLED=true`).

## Tech stack

TypeScript on Node 22. Fastify, Zod, Vitest, tsx. Zetaris for SQL reads. Meterless (OpenAI-compatible, via Nightshift) for compact agent wording. H-MEM (`src/hmem`) stores farmer profile, verdicts, and offer gaps behind `MemoryPort`.

## Setup

```bash
cp .env.example .env
# fill the values in .env; do not commit it
npm install
npm start
```

The process listens on port 8000.

### Connect the web UI to a local Zetaris Docker service

The browser talks to Fastify; it must not connect to Zetaris directly. The Vite `/api` proxy forwards UI calls to the backend on port 8000, and the backend sends SQL to the Zetaris REST proxy. Each developer uses a local, untracked `.env` because Docker hostnames, organisation IDs, and credentials differ by machine.

1. Start the Zetaris stack and publish its REST proxy port to the host. Confirm the proxy is reachable at `http://127.0.0.1:3000/api/proxy` (or use the actual host port from that machine's Docker setup).
2. Copy `.env.example` to `.env`. Set `ZETARIS_REST_URL`, the organisation ID, and a valid Zetaris API token. An opaque API key is sent as-is. A JWT is refreshed when it is within a minute of expiry, using `ZETARIS_USERNAME` and `ZETARIS_PASSWORD` (or `ZETARIS_ADMIN_EMAIL` and `ZETARIS_ADMIN_PASSWORD`). On a `/api/v1.0` base URL the refresh is `GET /api/v1.0/auth/login` with basic auth. The app does not write refreshed tokens to `.env`.
3. From the repo root, run `npm start`. In another terminal run `npm run ui`; open `http://localhost:3001`.
4. Confirm `http://localhost:8000/zetaris/check` reports all five tables online. The UI's Zetaris inspector uses the same check through `/api/zetaris/check`.

If Fastify itself runs inside Docker, `127.0.0.1` points at the backend container. Use `host.docker.internal` for a Zetaris port published on the Windows host, or the Zetaris service name and internal port when both services share a Docker network. The host, port, and published route must match the running Zetaris deployment; copying the repo cannot start or configure that external stack by itself.

The maize views are created by the setup order below. A successful connectivity check proves queries work. The API reports `data_source`; a live demo should show `zetaris`. Evidence from `maize.storage_loss_rules`, `maize.market_news`, and `maize.farmer_ledger` is labelled synthetic.

Never commit `.env`, a JWT, API key, organisation-specific secret, or admin password. `.env.example` is a template only. Each teammate creates their own `.env` after cloning.

Docker:

```bash
docker build -t open-agent-maize .
docker run --env-file .env -p 8000:8000 open-agent-maize
```

From inside WSL, `127.0.0.1` may not reach Nightshift running on Windows. If `GET /v1/models` fails, set `METERLESS_BASE_URL` to the Windows host address. Do not use the placeholder token `rt-local`. The default base URL is `http://127.0.0.1:8088/v1`.

Smoke check (prints PASS or FAIL, and does not print secrets):

```bash
npx tsx scripts/smoke_test.ts
```

Count the rows in each `maize` table (prints the count, or FAIL):

```bash
npx tsx scripts/check_zetaris_tables.ts
```

## What is live and what is synthetic

Live:

- `maize.weather_daily` is one Open-Meteo REST table per county in `OPEN_METEO`. A read is always `WHERE county = '<requested>'`, so only that county's endpoint is called. The connectivity check counts Kirinyaga only, for the same reason. Humidity is the daily mean of hourly `relative_humidity_2m`. The forecast is fetched when the view is queried, so its freshness is same-day.
- `maize.kamis_prices` reads the Postgres container `maize-db` (Zetaris datasource `maize_pg`). `refresh_kamis` parses the live KAMIS Excel export and upserts those parsed rows with `INSERT ... ON CONFLICT DO UPDATE`. It does not write price files and it does not insert hand-written rows.

Synthetic, loaded once from `data/sample/` and flagged in the view:

- `maize.storage_loss_rules`
- `maize.market_news`
- `maize.farmer_ledger`

`maize.counties` is the seven sourced centroids in `data/counties.csv`. It is not a synthetic farmer profile. `maize.county_case` joins that county's latest price statistics, its forecast, and the storage rules in one statement. The run traces that query once.

## Setup order

1. Copy `.env.example` to `.env`. Set the Zetaris REST values and `MAIZE_PG_PASSWORD`. The host and port default to `127.0.0.1:5433`. Do not point `MAIZE_PG_*` at the Zetaris metadata database.
2. `bash scripts/setup_zetaris.sh` starts `maize-db` from `docker/maize-db.compose.yml` on the `zetaris_default` network, waits until it is healthy, and copies `data/counties.csv` plus the sample reference files into `zetaris-driver-1:/home/zetaris/customer-data/shared/maize/`.
3. The script runs `npm run setup:zetaris`, which sends `zetaris/setup_maize.sql` over REST one statement at a time and prints PASS or FAIL. An "already exists" error is a PASS. It stops before the `-- @seed` marker.
4. `npm run seed:zetaris` creates `kamis_prices` if needed and loads `data/sample/kamis_dry_maize.csv` into Postgres. The log names that file as a sample export, and names the three synthetic views.
5. The script runs `npm run setup:zetaris -- --after-seed`, which registers datasource `maize_pg` and replaces `maize.kamis_prices` with the Postgres view. The password stays in `.env`. The SQL file contains the token `MAIZE_PG_PASSWORD`.

`GET /counties` returns the rows in `maize.counties`. A county with at least 3 dry-maize quotes in the last 14 days is `supported`; otherwise it is `limited`. The phone dropdown lists only those counties. `POST /run` with any other county returns HTTP 400 `unknown_county`.

## Seven counties and the centroid limit

`data/counties.csv` has seven counties, not all 47. Each latitude and longitude is an OpenStreetMap Nominatim relation centroid (ODbL). Open-Meteo snaps a request to its own grid cell, so the returned coordinates are not the centroid. The REST table name carries the county. Do not join a forecast back to `maize.counties` on the latitude and longitude in the API response.

## Offline mode

`SAMPLE_MODE=true` reads `data/sample/` only when Zetaris is unreachable (no HTTP response). The trace says `offline mode` and `data_source` is `sample`. A query that Zetaris answers and then rejects is an error. It is never replaced with sample rows. `SAMPLE_MODE=false` and an unreachable Zetaris return HTTP 503 `{ "code": "zetaris_unavailable" }`. A reachable query failure returns HTTP 502 `{ "code": "zetaris_query_failed" }`. The sample loader is the seed script and this offline path. Agents do not read the files themselves.

## Zetaris data setup

The agents read schema-store views through `src/adapters/zetaris.ts`:

| View | Columns the adapter selects |
| --- | --- |
| `maize.kamis_prices` | `market_date`, `county`, `market_name`, `commodity`, `variety`, `grade`, `unit_kg`, `wholesale_price_kes`, `retail_price_kes`, `volume_bags` |
| `maize.weather_daily` | `county`, `as_of`, `source`, `forecast_date`, `rain_mm`, `humidity_pct`, `temp_c` |
| `maize.market_news` | `id`, `as_of`, `county`, `maize_type`, `status`, `direction`, `headline`, `commodity`, `synthetic` |
| `maize.storage_loss_rules` | `storage`, `rain_mm_min`, `humidity_min`, `daily_loss_pct`, `synthetic` |
| `maize.farmer_ledger` | `farmer_id`, `county`, `as_of`, `record_type`, `verdict`, `hold_days`, `bags`, `storage`, `forecast_rain_mm_7d`, `notes`, `synthetic` |

News, rules, and the ledger are filestore views over files copied into the driver. Prices are the Postgres view. Weather is the Open-Meteo REST view. The copied files are:

| Host file | Lightning table |
| --- | --- |
| `/home/zetaris/customer-data/shared/maize/kamis_dry_maize.csv` | `MAIZE_FILES.kamis_prices_raw` |
| `/home/zetaris/customer-data/shared/maize/weather.json` | `MAIZE_FILES.weather_raw` |
| `/home/zetaris/customer-data/shared/maize/news.json` | `MAIZE_FILES.market_news_raw` |
| `/home/zetaris/customer-data/shared/maize/storage_loss_rules.csv` | `MAIZE_FILES.storage_loss_rules_raw` |
| `/home/zetaris/customer-data/shared/maize/farmer_ledger.json` | `MAIZE_FILES.farmer_ledger_raw` |

`market_news` explodes `items`. `farmer_ledger` explodes `entries`. Both views, and `storage_loss_rules`, project `synthetic`. Do not point `ZETARIS_REST_URL` at port 8889. `npm run load:sample` only copies sample files into a host directory that already exists. The agent path does not use it. Use `scripts/setup_zetaris.sh` instead.

## Live refresh

`npx tsx scripts/refresh_kamis.ts` keeps the KAMIS throttle, `robots.txt` check, raw cache under `data/cache/`, and page cap. Parsed rows are upserted into Postgres on `MAIZE_PG_HOST`:`MAIZE_PG_PORT` (default `127.0.0.1:5433`). The primary key is `market_date, county, market_name, commodity, variety, grade, unit_kg`. A successful write clears the SQL cache. If Postgres cannot be written, the trace is `refresh_unavailable` and that line is added to `limitations`. There is no weather file refresh.

`REFRESH_ENABLED` defaults to true. Set it to `false` and the price refresh does not call the network. After a successful write, the time is stored in `data/cache/refresh_state.json` (gitignored). A later refresh is skipped while the stamp is newer than `REFRESH_TTL_MINUTES` (default 360). The trace action is `refresh_skipped`.

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The county coordinates are © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [Open Database Licence (ODbL)](https://opendatacommons.org/licenses/odbl/).

KAMIS prices use the market-page export at `https://kamis.kilimo.go.ke/site/market`: Dry Maize is `product=1`, the entries control is `per_page`, and the Export to Excel control adds `export=excel`. Later pages use the same query with the row offset in the path (`/site/market/100` is the second page when `per_page` is 100). The client sends `User-Agent: open-agent-maize/0.1 (maize decision support)`, waits 2 seconds between requests, and saves raw responses under `data/cache/` (gitignored). `KAMIS_MAX_PAGES` defaults to 2 and `KAMIS_PER_PAGE` defaults to 100 (one of 10, 50, 100, 500, 1500, 3000). `robots.txt` is fetched first. HTTP 404 means the site published no rules, and the export still waits 2 seconds. A failed robots fetch stops the run. KAMIS terms of use are unconfirmed.

The sheet shows wholesale and retail per kilogram. Stored prices are that figure times 90, because the price tools keep white maize only when `unit_kg` is 90. Supply volume is stored as the number in the sheet. A row is dropped when wholesale or retail is blank, the county or market is the site's `test` placeholder, or the cells do not match the row schema. The run logs how many rows were rejected.

`STALE_DAYS` defaults to 3. RiskCritic rejects a price claim when the newest quote is older than that. A live Open-Meteo forecast is same-day, so the forecast freshness check passes. A price window is mixed when the oldest quote and the newest quote are more than 21 days apart. The percentile band then blends a stale quote with a current one, so it is not one market moment. The response states that in `limitations` and in `reasoning_trace_summary`. On a price freshness rejection the planner calls `refresh_kamis`, then the analysts query Zetaris again, unless the TTL or `REFRESH_ENABLED=false` skips the network. The loop allows 2 refreshes. Before it approves a numeric price claim, RiskCritic runs its own Zetaris query for the count, percentiles, and newest date. The trace action is `verify_claim`. A mismatch rejects the claim.

Claim evidence is `<origin> via zetaris:<table>` or, in offline mode, `<origin> via sample:<file>`. Origin is `kamis`, `open-meteo`, or `synthetic`. A planted critic case is selected with `"fixture": "dirty"` (see `input_examples/example_3.json`) and its evidence source is `fixture:data/fixtures/dirty_market.json`. Synthetic rows also set `synthetic: true` on the evidence object, which the phone screen shows. `as_of` is the quote date or the forecast issue date. Freshness is `same-day`, `Nd`, or `stale-Nd` from `STALE_DAYS`. News and storage rules that have no observation date are `undated`.

## Usage

```bash
curl -s http://localhost:8000/health

curl -s -X POST http://localhost:8000/run \
  -H 'content-type: application/json' \
  -d @input_examples/example_1.json
```

| Example | Case |
| --- | --- |
| `input_examples/example_1.json` | Kirinyaga, open bags, rain on the synthetic forecast, prices rising, a cash need. |
| `input_examples/example_2.json` | Same county, dry store. |
| `input_examples/example_3.json` | Garissa: one white-maize quote, plus a stale forecast with a 400 mm day. `"fixture": "dirty"` adds the planted outlier and yellow-maize news item from `data/fixtures/dirty_market.json`. |
| `input_examples/example_4.json` | Recheck. The synthetic ledger has a prior HOLD from 12 Oct 2026, when 7-day rain was 4 mm. |

`output_examples/` does not contain fabricated responses. Save a real `POST /run` body there if you want a fixture.

## Sample mode

Offline mode is described above. `data_source` is `zetaris` when every read hit a `maize` view, `sample` when Zetaris was unreachable and `SAMPLE_MODE=true`, and `mixed` when a run used both. Identical SQL inside one run is cached and traced as `cache`. A successful Postgres upsert clears that cache.

## Failure handling

| Failure | What the run does |
| --- | --- |
| Zetaris unreachable and `SAMPLE_MODE=true` | Labelled offline mode. Trace status `fallback`. Response `data_source` is `sample`. |
| Zetaris unreachable and `SAMPLE_MODE=false` | HTTP 503 `zetaris_unavailable`. No sample rows. |
| Zetaris answers and the query fails | HTTP 502 `zetaris_query_failed`. The error is traced. Sample rows are not substituted. |
| Meterless 401 or 403 | Reported as unauthorized. The chat call surfaces the server message and does not treat it as offline. |
| Meterless 429 | Waits 2s, 4s, then 8s. |
| Meterless timeout or unreachable | Chat calls abort at 180s. Wording falls back to the computed figures. Trace status `fallback`. |
| Placeholder token `rt-local` | Refused before any request. Health reports unauthorized. |
| Fewer than 3 fresh white-maize quotes | `no_recommendation`, with the row count and a question. |
| Critic rejection | Back to the owning analyst. Maximum 2 revisions. |
| Stale prices or forecast (`STALE_DAYS`, default 3), or a price window longer than 21 days | RiskCritic rejects. The planner calls the KAMIS and Open-Meteo refresh tools, then the analysts query again, unless `REFRESH_ENABLED` is false or the last success is inside `REFRESH_TTL_MINUTES`. Maximum 2 refreshes. A failed refresh keeps the previous rows and their real age. A missing or read-only host directory is `refresh_unavailable` in the trace and in `limitations`. A mixed window is stated as mixed-age prices. |
| Rounds | Maximum 3, then `no_recommendation` if still unapproved. |
| H-MEM write without a source | Rejected by construction. Farmer records always carry `source: farmer:<id>`. |

Every external call has a timeout. The revision loop is capped. A run returns or fails; it does not wait forever.

## Data and licensing

See `data/README.md`. The KAMIS-style price file has 50 data rows and was already in the repo (export note: 14 October 2026), apart from one planted 9,999 KES quote that now lives only in `data/fixtures/dirty_market.json`. KAMIS terms of use for `https://kamis.kilimo.go.ke/site/market` are unconfirmed. Do not assume a redistribution licence. A live pull uses the market-page Excel export, throttled to one request every 2 seconds. Weather, storage-loss rules, news, and the farmer ledger in `data/sample/` are synthetic and marked as such. They are never labelled as KAMIS, Open-Meteo, or a gazette notice.

Attribution:

- Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- County coordinates in `data/counties.csv` are © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [Open Database Licence (ODbL)](https://opendatacommons.org/licenses/odbl/).
- KAMIS (`https://kamis.kilimo.go.ke/site/market`) is the price source. Terms of use are unconfirmed.

## Limitations

- Decision support only. The Monte Carlo is a scenario model with a fixed seed (`20261022`), a 0.45 trend damp, and a liquidity penalty of 2 on cash that a hold does not raise today.
- Loss percentages come from synthetic rules, not measured spoilage on this farm.
- The price window is short, and several counties have only a handful of quotes.
- Farmer memory persists under `data/hmem` (gitignored). A record with an empty source is rejected.
- Live reads use `maize.kamis_prices`, `maize.weather_daily`, `maize.market_news`, `maize.storage_loss_rules`, and `maize.farmer_ledger`. A fresh clone still needs the one-time load in `scripts/zetaris_maize_setup.sql` before those views exist.
- Model text cannot change the computed verdict. If it does not match, the reply stays with the numbers.

## Pre-existing components and third-party material

The build window starts 22 October 2026 00:00 UTC.

`git log --reverse --format="%h %ad %s" --date=iso | head -5` shows:

```text
546140c 2026-10-22 14:56:04 +0300 Add H-MEM spec and reference
6dd879e 2026-10-22 15:44:53 +0300 Add sample data layout and example input/output folders.
c22eaa2 2026-10-22 18:43:08 +0300 Project Structure Setup
f7659cc 2026-10-22 19:30:37 +0300 Implement H-MEM backed MemoryPort in memory.ts, replacing the in-process memory store. Update memory recall and remember methods to utilize H-MEM for storing farmer profiles, verdicts, and offer gaps. Adjust README and other files to reflect changes in memory handling and data persistence under data/hmem. Update watcher and planner agents to accommodate new memory structure.
323497b 2026-10-22 19:34:31 +0300 Enhance planner logic to include liquidity penalty descriptions and improve summary outputs. Update price range handling and refine evidence reporting. Add new utility functions for deduplication and no recommendation summaries. Extend tests to validate cash need penalties and ensure correct behavior with missing directories in H-MEM. Update .dockerignore to exclude new data directory.
```

No application code was committed before the window. The first commit is 2026-10-22 14:56:04 +0300, which is 11:56:04 UTC, inside the window.

Pre-existing before the build window:

- The KAMIS dry-maize sample export in `data/sample/kamis_dry_maize.csv`, collected 14 October 2026. It was committed during the window in `6dd879e`.
- Planning notes and the "Shamba Council" README draft: not present in this repository. [FILL IN: path or link if they were kept outside the repo.]
- The mobile UI in `ui/` was first committed during the window, `c41e8ab` on 2026-10-24 18:51:33 +0300. Nothing in git shows a UI before the window.

Third-party and open source:

- Meterless H-MEM spec and reference in `memory/hmem/`, Apache-2.0, https://github.com/Meterless/Meterless
- Zetaris platform. Getting-started recipes: [FILL IN: title and URL of the recipe pack]. Local setup for this project is `scripts/zetaris_maize_setup.sql`.
- Open-Meteo, CC BY 4.0, https://open-meteo.com/
- OpenStreetMap contributors, ODbL, for `data/counties.csv`
- KAMIS prices, Ministry of Agriculture, https://kamis.kilimo.go.ke/site/market. Terms of use are unconfirmed.
- npm dependencies in `package.json`: fastify, zod; devDependencies @types/node, tsx, typescript, vitest.
- npm dependencies in `ui/package.json`: clsx, lucide-react, react, react-dom, recharts, tailwind-merge; devDependencies @types/react, @types/react-dom, @vitejs/plugin-react, autoprefixer, postcss, tailwindcss, typescript, vite.

Synthetic, and labelled synthetic in the files:

- Farmer profiles and ledger: `data/sample/farmer_ledger.json`
- News items: `data/sample/news.json`
- Storage-loss rules: `data/sample/storage_loss_rules.csv`
- Forecast series: `data/sample/weather.json`
- Planted critic cases: `data/fixtures/dirty_market.json`

## Pre-existing components

- `data/sample/kamis_dry_maize.csv`, described as a KAMIS sample exported on 14 October 2026. The planted 9,999 KES quote was moved to `data/fixtures/dirty_market.json` so the sample file is not presented as a real KAMIS outlier.
- `data/sample/records_sample.json`, `data/sample/metadata.csv`, and `data/download_data.py` were already here. The download script is still a stub. The empty records file is unused.
- `memory/hmem/` is the H-MEM spec and reference. It is not modified. The project implementation is `src/hmem`.

## Sponsor technology

- **Zetaris.** SQL reads go through `src/adapters/zetaris.ts`: `POST {ZETARIS_REST_URL}/sql-editor/sqls/run` with `Authorization`, `X-Org-ID`, and a fresh `X-Request-ID`. One statement per call. The body returns `headers` plus row arrays in `data`; the adapter zips them into named columns. Agents call the typed helpers, which select from `maize.<table>`.
- **Meterless Runtime** (`meterless`) is the primary provider for every agent reasoning call (`src/adapters/meterless.ts`). Settings are `METERLESS_BASE_URL`, `METERLESS_RUNTIME_TOKEN` (contract key `meterless_runtime_token`), and `METERLESS_MODEL` (default `meterless/auto`). A pasted base URL is normalised to `<origin>/v1`, including values with no scheme or with `/v1/chat/completions`, `/v1/models`, or `/healthz`. A connect link (`http://<host>:<port>/connect#k=<key>`) sets the base URL and the token; the key is never logged. `GET /v1/models` decides health: 401/403 is `unauthorized`, 200 with `meterless/*` ids is `online`, anything else is `offline`. `GET /healthz` is not a health decision. `POST /meterless/test` checks models and then one sentence. `POST /meterless/detect` tries ports 8088, 8090, 8787, and 11434 on `127.0.0.1`, `localhost`, and `[::1]`. Chat sends `Authorization: Bearer`, `meterless-app: open-agent-maize`, and `meterless-scope: user`, with a 180s timeout. Each chat line in the trace records the provider, the model Meterless reports, latency, and token counts when the API returns them.
- **NVIDIA via Nightshift lanes.** Meterless is the runtime in front of those lanes. TODO: record the assigned lane names and GPU placement once they are confirmed for this project.
- **Cursor.** Used to scaffold and edit this repository.
- **H-MEM.** `src/hmem` implements the spec in `memory/hmem/AGENTS.md` (store, retrieval, mining, sleep, dreaming, trust ledger, conflicts). `src/adapters/memory.ts` keeps `MemoryPort.recall(farmerId)` and `remember(farmerId, record)`. The planner recalls before delegating. Each run writes the farmer profile, the verdict with date and reasoning, and the gap between the trader offer and the county P50. The watcher reads that stored verdict on recheck. TODO: schedule an unattended sleep cycle over farmer history.

## Trace

Each run writes `logs/<UTC timestamp>_<county>_<mode>_<first 8 chars of trace_id>.jsonl`, one JSON object per line. `logs/latest.jsonl` is a symlink to the newest file.

`timestamp`, `trace_id`, `agent_name`, `action`, `input_summary`, `output_summary`, `target_agent`, `confidence`, `retry_count`, `status`, `data_source`, `provider`, `model`. A chat line also records `latency_ms`, `prompt_tokens`, `completion_tokens`, and `total_tokens` when the API sends them, plus `lane` when Meterless reports one. The chat `input_summary` is one sentence about what the agent asked, with secrets and key=value fragments removed. The chat `output_summary` is the decision and one sentence of rationale. Hidden reasoning text is not logged.

`data_source` on each line is `zetaris`, `mixed`, `sample`, or `null` before any table has been read. The response carries the same field without `null`. Status is one of `success`, `needs_revision`, `retrying`, `partial_success`, `fallback`, `error`. The closing line is `fallback` when any table used a sample file, or when the wording fell back. While the run executes, each event is printed as one line: `[10:15:31] MarketAnalyst -> RiskCritic | claim | needs_revision | <summary>.` Secrets are redacted.

Follow a run while it is in progress, or replay it afterwards:

```bash
curl -N http://localhost:8000/run/<trace_id>/events
```

Pretty-print a file, or the symlink:

```bash
npm run trace -- latest
npm run trace -- logs/<file>.jsonl
```

After a model writes wording, numbers in that wording are checked against the computed text. A mismatch discards the model text, keeps the computed wording, and logs `wording_rejected`. `plain_reply` is at most two plain sentences.

## Web interface

The React interface runs separately from the API during development. Start the backend in one terminal, then start the UI in another:

```bash
npm start
npm run ui
```

Open `http://localhost:3001`. Vite proxies `/api/*` to the backend at `http://127.0.0.1:8000` and removes the `/api` prefix. The farmer screen is `ui/src/App.tsx`. It loads counties from `GET /counties`, posts the form to `POST /run`, and loads that run's events from `GET /trace/:id`. `GET /run/:traceId/events` is still the live server-sent stream. The production UI bundle can be built with `npm run ui:build`; serve the generated `ui/dist` through a static host configured with the same API proxy. It is not served by the Fastify process.

The **Check Zetaris tables** action runs read-only row counts against all five configured `maize` views. The Meterless card accepts its `/connect#k=...` link and stores the token only in the local `.env`; the field clears after submission. A passing connection check proves the current runtime can reach that service. Each case result also labels its live/sample source and includes the actual service/model trace.

For the hackathon demo and submission status, see the [latest slide deck](submission/Open_Agent_Maize_Deck_2026-10-24_v3.pptx), [`submission/hackos_checklist.md`](submission/hackos_checklist.md), [`submission/demo_script.md`](submission/demo_script.md), and [`submission/impact_and_measurement.md`](submission/impact_and_measurement.md).
