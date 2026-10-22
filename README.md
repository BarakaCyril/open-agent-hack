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

From inside WSL, `127.0.0.1` may not reach Nightshift running on Windows. If `GET /v1/models` fails, set `METERLESS_BASE_URL` to the Windows host address. Do not use the placeholder token `rt-local`.

Smoke check (prints PASS or FAIL, and does not print secrets):

```bash
npx tsx scripts/smoke_test.ts
```

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

`SAMPLE_MODE=true` loads input rows from `data/sample/` only after a live Zetaris call fails or times out. It does not load a verdict. `SAMPLE_MODE=false` returns the source error instead of substituting the sample files. A timeout retries once with a narrower SELECT, then follows that same rule.

## Failure handling

| Failure | What the run does |
| --- | --- |
| Zetaris timeout | One narrower SQL retry, then sample input if `SAMPLE_MODE=true`. Trace status `fallback`. |
| Zetaris HTTP 5xx or network error | Up to `MAX_RETRIES` with backoff, then the same sample rule. 4xx is not retried. |
| Zetaris down and `SAMPLE_MODE=false` | The request fails with the scrubbed source error. No invented rows. |
| Meterless 401 or 403 | Reported as unauthorized. The chat call surfaces the server message and does not treat it as offline. |
| Meterless 429 | Waits 2s, 4s, then 8s. |
| Meterless timeout or unreachable | Chat calls abort at 180s. Wording falls back to the computed figures. Trace status `fallback`. |
| Placeholder token `rt-local` | Refused before any request. Health reports unauthorized. |
| Fewer than 3 fresh white-maize quotes | `no_recommendation`, with the row count and a question. |
| Critic rejection | Back to the owning analyst. Maximum 2 revisions. |
| Stale evidence | Refresh retry. Maximum 2. |
| Rounds | Maximum 3, then `no_recommendation` if still unapproved. |
| H-MEM write without a source | Rejected by construction. Farmer records always carry `source: farmer:<id>`. |

Every external call has a timeout. The revision loop is capped. A run returns or fails; it does not wait forever.

## Data and licensing

See `data/README.md`. The KAMIS-style price file has 51 data rows and was already in the repo (export note: 14 October 2026). KAMIS terms are unconfirmed. Weather, storage-loss rules, news, and the farmer ledger are synthetic and marked as such.

## Limitations

- Decision support only. The Monte Carlo is a scenario model with a fixed seed (`20261022`), a 0.45 trend damp, and a liquidity penalty of 2 on cash that a hold does not raise today.
- Loss percentages come from synthetic rules, not measured spoilage on this farm.
- The price window is short, and several counties have only a handful of quotes.
- Farmer memory persists under `data/hmem` (gitignored). A record with an empty source is rejected.
- Zetaris table names in the adapter (`kamis_prices`, `weather_daily`, `storage_loss_rules`, `market_news`, `farmer_ledger`) are the contract this code sends. They may need a catalog mapping before a live virtual database returns rows.
- Model text cannot change the computed verdict. If it does not match, the reply stays with the numbers.

## Pre-existing components

- `data/sample/kamis_dry_maize.csv`, described as a KAMIS sample exported on 14 October 2026. It was not modified.
- `data/sample/records_sample.json`, `data/sample/metadata.csv`, and `data/download_data.py` were already here. The download script is still a stub. The empty records file is unused.
- `memory/hmem/` is the H-MEM spec and reference. It is not modified. The project implementation is `src/hmem`.

## Sponsor technology

- **Zetaris.** SQL reads go through `src/adapters/zetaris.ts`: `POST {ZETARIS_REST_URL}/sql-editor/sqls/run` with `Authorization`, `X-Org-ID`, and a fresh `X-Request-ID`. One statement per call. Rows are read from `response.data`. Agents call the typed helpers, not ad-hoc SQL.
- **Meterless.** OpenAI-compatible chat in `src/adapters/meterless.ts`. The base URL is normalised to a single `/v1`. Health is `GET /v1/models` (`online` only when the payload contains meterless ids; 401/403 is `unauthorized`; `/healthz` is not used). Chat sends `meterless-app: open-agent-maize` and `meterless-scope: user`.
- **NVIDIA via Nightshift lanes.** Meterless is the runtime in front of those lanes. TODO: record the assigned lane names and GPU placement once they are confirmed for this project.
- **Cursor.** Used to scaffold and edit this repository.
- **H-MEM.** `src/hmem` implements the spec in `memory/hmem/AGENTS.md` (store, retrieval, mining, sleep, dreaming, trust ledger, conflicts). `src/adapters/memory.ts` keeps `MemoryPort.recall(farmerId)` and `remember(farmerId, record)`. The planner recalls before delegating. Each run writes the farmer profile, the verdict with date and reasoning, and the gap between the trader offer and the county P50. The watcher reads that stored verdict on recheck. TODO: schedule an unattended sleep cycle over farmer history.

## Trace

Each run writes `logs/<trace_id>.jsonl`, one JSON object per line:

`timestamp`, `trace_id`, `agent_name`, `action`, `input_summary`, `output_summary`, `target_agent`, `confidence`, `retry_count`, `status`.

Status is one of `success`, `needs_revision`, `retrying`, `partial_success`, `fallback`, `error`. The same event is printed as a single stdout line. Secrets are redacted.
