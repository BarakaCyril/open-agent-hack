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
| StorageWeatherAnalyst | Reads the forecast and the storage-loss rules and turns them into an expected-loss distribution. | Revises, or refreshes when the critic marks the forecast stale. |
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

## Zetaris data setup

The agents read schema-store views, not the raw files:

| View | Columns the adapter selects |
| --- | --- |
| `maize.kamis_prices` | `market_date`, `county`, `market_name`, `commodity`, `variety`, `grade`, `unit_kg`, `wholesale_price_kes`, `retail_price_kes`, `volume_bags` |
| `maize.weather_daily` | `county`, `as_of`, `source`, `forecast_date`, `rain_mm`, `humidity_pct`, `temp_c` |
| `maize.market_news` | `id`, `as_of`, `county`, `maize_type`, `status`, `direction`, `headline`, `commodity` |
| `maize.storage_loss_rules` | `storage`, `rain_mm_min`, `humidity_min`, `daily_loss_pct` |
| `maize.farmer_ledger` | `farmer_id`, `county`, `as_of`, `record_type`, `verdict`, `hold_days`, `bags`, `storage`, `forecast_rain_mm_7d`, `notes` |

Those views sit in the schema-store container `maize`. The files behind them are Lightning tables in database `MAIZE_FILES`, stored on the Zetaris host:

| Host file | Lightning table |
| --- | --- |
| `/home/zetaris/customer-data/shared/maize/kamis_dry_maize.csv` | `MAIZE_FILES.kamis_prices_raw` |
| `/home/zetaris/customer-data/shared/maize/weather.json` | `MAIZE_FILES.weather_raw` |
| `/home/zetaris/customer-data/shared/maize/news.json` | `MAIZE_FILES.market_news_raw` |
| `/home/zetaris/customer-data/shared/maize/storage_loss_rules.csv` | `MAIZE_FILES.storage_loss_rules_raw` |
| `/home/zetaris/customer-data/shared/maize/farmer_ledger.json` | `MAIZE_FILES.farmer_ledger_raw` |

`weather_daily` explodes `series` and each series `days`. `market_news` explodes `items`. `farmer_ledger` explodes `entries`. `storage_loss_rules` keeps the four numeric columns and leaves out `synthetic` and `note`.

A clean clone has `data/sample/` and does not create the remote schema by itself. To reload:

1. Copy the five files from `data/sample/` onto the host paths above, keeping those file names.
2. If `MAIZE_FILES` and the `maize` views are already registered, stop there. The filestore reads those paths on each query. Run `npx tsx scripts/check_zetaris_tables.ts` and confirm each table returns a count.
3. If the organisation has no `maize` container, open `scripts/zetaris_maize_setup.sql` and run each statement on its own in the Zetaris SQL editor. `CREATE LIGHTNING DATABASE` and `CREATE SCHEMASTORE CONTAINER` fail when the name already exists; skip those. Then run the count script.

Do not point `ZETARIS_REST_URL` at port 8889.

## Live refresh

`maize.kamis_prices` and `maize.weather_daily` are schema-store views. They are not insertable. A refresh writes the same Lightning filestore files the initial load copies onto the Zetaris host:

| Script | Host file | View |
| --- | --- | --- |
| `npx tsx scripts/refresh_kamis.ts` | `$ZETARIS_MAIZE_DIR/kamis_dry_maize.csv` | `maize.kamis_prices` |
| `npx tsx scripts/refresh_weather.ts <county>` | `$ZETARIS_MAIZE_DIR/weather.json` | `maize.weather_daily` |

`ZETARIS_MAIZE_DIR` defaults to `/home/zetaris/customer-data/shared/maize`. The filestore reads those paths on the next query, which is the same route as the one-time copy in the setup above. Rows are upserted: a repeated market quote replaces that quote, and an older date stays. A new Open-Meteo issue for a county replaces that county's synthetic series and the same issue date. Other counties, and older Open-Meteo issue dates, stay in the file. If the host directory is not mounted here, the script does not create it and does not report the rows as stored. The analysts then keep the rows already in Zetaris or, when that read fails in sample mode, the files in `data/sample/`. Those sample files are not overwritten.

The forecast comes from the Open-Meteo forecast API. No API key. Daily fields are `precipitation_sum` and `temperature_2m_mean`. The forecast API has no daily humidity field, so humidity is the mean of that day's hourly `relative_humidity_2m`. Coordinates are looked up in `data/counties.csv` and are OpenStreetMap Nominatim relation centroids (ODbL 1.0). A county that is not in that file is an error. The forecast is not requested with a guessed point. Weather data by [Open-Meteo.com](https://open-meteo.com/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

KAMIS prices use the market-page export at `https://kamis.kilimo.go.ke/site/market`: Dry Maize is `product=1`, the entries control is `per_page`, and the Export to Excel control adds `export=excel`. Later pages use the same query with the row offset in the path (`/site/market/100` is the second page when `per_page` is 100). The client sends `User-Agent: open-agent-maize/0.1 (maize decision support)`, waits 2 seconds between requests, and saves raw responses under `data/cache/` (gitignored). `KAMIS_MAX_PAGES` defaults to 2 and `KAMIS_PER_PAGE` defaults to 100 (one of 10, 50, 100, 500, 1500, 3000). `robots.txt` is fetched first. HTTP 404 means the site published no rules, and the export still waits 2 seconds. A failed robots fetch stops the run. KAMIS terms of use are unconfirmed.

The sheet shows wholesale and retail per kilogram. Stored prices are that figure times 90, because the price tools keep white maize only when `unit_kg` is 90. Supply volume is stored as the number in the sheet. A row is dropped when wholesale or retail is blank, the county or market is the site's `test` placeholder, or the cells do not match the row schema. The run logs how many rows were rejected.

`STALE_DAYS` defaults to 3. RiskCritic rejects a claim when the newest price date or the forecast issue date is older than that. A price window longer than 21 days is still treated as mixed. On that rejection the planner calls `refresh_kamis` for prices and `refresh_weather` for the county forecast, then the analysts query Zetaris again. The SQL cache is cleared only after a file is actually written. The loop allows 2 refreshes. Each one is a trace line `refresh_kamis` or `refresh_weather` with rows fetched, rows stored, and status. A failed refresh keeps the previous rows. Evidence then shows that older `as_of`, not the time of the failed attempt.

Claim evidence is `<origin> via zetaris:<table>` or `<origin> via sample:<file>`. Price origin is `kamis`. Forecast origin is the series source, such as `open-meteo` or `synthetic-forecast`. `as_of` is the quote date or the forecast issue date. Freshness is `same-day`, `Nd`, or `stale-Nd` from `STALE_DAYS`. News and storage rules that have no observation date are `undated`.

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
| `input_examples/example_3.json` | Garissa: one white-maize quote, plus a stale forecast with a 400 mm day. |
| `input_examples/example_4.json` | Recheck. The synthetic ledger has a prior HOLD from 12 Oct 2026, when 7-day rain was 4 mm. |

`output_examples/` does not contain fabricated responses. Save a real `POST /run` body there if you want a fixture.

## Sample mode

`SAMPLE_MODE=true` loads input rows from `data/sample/` only after a live Zetaris call fails or times out. It does not load a verdict. The response field `data_source` is `zetaris` when every read hit `maize.<table>`, `sample` when every read used a file, and `mixed` when both happened. The route inside a claim is `zetaris:<table>` or `sample:<file>`, prefixed with the origin (`kamis`, `open-meteo`, `synthetic-forecast`, and the same pattern for news and rules). A fallback is also a trace line with status `fallback`, and the closing trace line repeats `data_source`. `SAMPLE_MODE=false` returns the source error instead of substituting the sample files. A timeout retries once with a narrower SELECT, then follows that same rule. Identical SQL inside one run is cached and traced as `cache`. A successful filestore refresh clears that cache before the analysts run again.

## Failure handling

| Failure | What the run does |
| --- | --- |
| Zetaris timeout | One narrower SQL retry, then sample input if `SAMPLE_MODE=true`. Trace status `fallback`. Response `data_source` is `sample` or `mixed`. |
| Zetaris HTTP 5xx or network error | Up to `MAX_RETRIES` with backoff, then the same sample rule. 4xx is not retried. |
| Zetaris down and `SAMPLE_MODE=false` | The request fails with the scrubbed source error. No invented rows. |
| Meterless 401 or 403 | Reported as unauthorized. The chat call surfaces the server message and does not treat it as offline. |
| Meterless 429 | Waits 2s, 4s, then 8s. |
| Meterless timeout or unreachable | Chat calls abort at 180s. Wording falls back to the computed figures. Trace status `fallback`. |
| Placeholder token `rt-local` | Refused before any request. Health reports unauthorized. |
| Fewer than 3 fresh white-maize quotes | `no_recommendation`, with the row count and a question. |
| Critic rejection | Back to the owning analyst. Maximum 2 revisions. |
| Stale prices or forecast (`STALE_DAYS`, default 3) | RiskCritic rejects. The planner calls the KAMIS and Open-Meteo refresh tools, then the analysts query again. Maximum 2 refreshes. A failed refresh keeps the previous rows and their real age. |
| Rounds | Maximum 3, then `no_recommendation` if still unapproved. |
| H-MEM write without a source | Rejected by construction. Farmer records always carry `source: farmer:<id>`. |

Every external call has a timeout. The revision loop is capped. A run returns or fails; it does not wait forever.

## Data and licensing

See `data/README.md`. The KAMIS-style price file has 51 data rows and was already in the repo (export note: 14 October 2026). KAMIS terms are unconfirmed. A live pull uses the market-page Excel export, throttled to one request every 2 seconds. Weather, storage-loss rules, news, and the farmer ledger in `data/sample/` are synthetic and marked as such. A live forecast is Open-Meteo (CC BY 4.0; attribution: Weather data by Open-Meteo.com) at the Nominatim county centroids in `data/counties.csv` (ODbL 1.0).

## Limitations

- Decision support only. The Monte Carlo is a scenario model with a fixed seed (`20261022`), a 0.45 trend damp, and a liquidity penalty of 2 on cash that a hold does not raise today.
- Loss percentages come from synthetic rules, not measured spoilage on this farm.
- The price window is short, and several counties have only a handful of quotes.
- Farmer memory persists under `data/hmem` (gitignored). A record with an empty source is rejected.
- Live reads use `maize.kamis_prices`, `maize.weather_daily`, `maize.market_news`, `maize.storage_loss_rules`, and `maize.farmer_ledger`. A fresh clone still needs the one-time load in `scripts/zetaris_maize_setup.sql` before those views exist.
- Model text cannot change the computed verdict. If it does not match, the reply stays with the numbers.

## Pre-existing components

- `data/sample/kamis_dry_maize.csv`, described as a KAMIS sample exported on 14 October 2026. It was not modified.
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
