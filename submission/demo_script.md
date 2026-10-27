# Demo script: Open Agent Maize (about 3:30)

Project name on the title slide, the UI, and the repo is **Open Agent Maize**. Track: **Reasoning Architecture**. The repo and the deck do not name a team. Leave the team off the title unless you add a real one.

H-MEM is Meterless, and it is in the running product. Nightshift is also Meterless, and it is not what this demo calls. Say that split out loud. Do not say the Nightshift failure was reported.

## Before you record

1. Backend: `npm start` (port 8000). UI: `npm run ui`, then `http://localhost:3001`.
2. `GET /zetaris/check` should show the five `maize` views online. The run you narrate needs `data_source: zetaris`.
3. `.env` should have `MODEL_PROVIDER=nvidia` and `NVIDIA_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b`. The footer then reads **NVIDIA Nemotron 30B**. If it reads **Meterless Runtime**, Nightshift answered and you should say that instead.
4. Phone defaults already match the rehearsal: Kirinyaga, 20 bags, Traditional Open Bags, offer 3,400, cash need 20,000. The request it sends is `farmer_id: FK-001`, `storage: open_bags`, `mode: advise`. There is no county picker and no recheck button.
5. Press Run and read the black trace log. Those lines are the same lines the server prints, and they appear while the run is still going. The badge **Live SSE Stream** means the stream is connected. Do not read any of these, which stay on screen and are not the trace:
   - Confidence **94%** until the live reply replaces it
   - Rain warning **193 mm** and **4.1 bags**
   - Storage label **Loss Risk: 20.4%**
   - Offer caption **Market Median: 3,225 KES**
   - The SQL Inspector query (`p.market`, `p.price_kes`, `buyer_notes`). That box is not the SQL the agents run.
6. The phone headline is only **SELL NOW** or **HOLD GRAIN**. `split` and `no_recommendation` are not labeled. Read the verdict from `plain_reply` and the trace. The big shilling figure is a scored total, not the per-bag band. The band is P10–P90 on the response (`price_range_per_90kg_bag`).
7. The last checked live case, on the 24 October deck, abstained: KAMIS prices were 6 days old and news was 19 days old, so the verdict was `no_recommendation`. Prices older than 3 days (`STALE_DAYS`) still take that path. If that is what this run does, narrate the abstention. Do not call it a sale.

## 0:00–0:20 — Problem

**Screen:** deck slide 1. Title is Open Agent Maize, Reasoning Architecture.

“Our entry is for the Reasoning Architecture track. A smallholder maize farmer in Kenya has twenty bags in open storage, a trader’s offer, and rain on the way. Sell now, or hold? The evidence is scattered across market prices, weather, storage loss and her own history, and a wrong call costs her real money.”

## 0:20–0:45 — Solution

**Screen:** deck slide 3 (the case flow). The README has no architecture diagram. The UI panel titled “Multi-Agent Deliberation DAG” is the same four nodes, and it stays on screen during the run.

“This is Open Agent Maize. The farmer gives a county, bags, storage type, an optional offer and a cash need. Our agents return sell, hold or split, with a price range, a confidence score, cited evidence and a re-check date. If the evidence is too thin, they return no recommendation. Prices are real KAMIS market data, forecasts come live from Open-Meteo, and the storage rules and farmer profile are synthetic.”

## 0:45–1:20 — Agents and collaboration

**Screen:** stay on slide 3 and point at the return arrow: “Rejected claims return to their owning analyst.” Caps on the slide: at most 2 revisions, 2 refreshes, 3 review rounds.

“Four agents and a Watcher. The Planner loads memory, checks data coverage and delegates. The Market Analyst reads prices. The Storage and Weather Analyst estimates loss from the forecast. The Risk Critic can reject any claim, send it back, trigger a price refresh, or stop the run when evidence is too thin. They share one case state, and every handoff is written to a trace. It isn’t a fixed pipeline.”

Do not promise a rejection on this Kirinyaga case. A clean claim is approved. A stale price is a refresh, up to twice, and then a stop if the quotes are still older than three days. Coverage under three fresh white-maize quotes, a cash need the full sale cannot raise, or a missing input stops the run instead of revising.

## 1:20–2:10 — Live run

**Screen:** the UI. Leave the sliders on the defaults. Press **Run Multi-Agent Deliberation**. Cut the wait. Start talking again only after **Live SSE Stream** is on the timeline and the card shows **Source: ZETARIS**.

“A real request: Kirinyaga, twenty bags in open storage, a trader offering 3,400 a bag, and 20,000 shillings needed now.”

Then read the timeline, not the script:

- A row whose status is **NEEDS_REVISION**, or whose action is `revise` or `refresh`, is the critic pushing back. Read that row’s summary. The real notes are one of these: the newest quote is more than 3 days old; the price window is longer than 21 days; an outlier is still in the band; a news item is not white maize; a news item disagrees with the price direction; open bags and heavy rain produced almost no loss; or “Verification mismatch” after the critic recomputed the band. A freshness row is a KAMIS refresh. Say “refresh”, not “the analyst rewrote the claim”, unless a later row is an actual revision and then an approve.
- If nothing is rejected, say: “The Market Analyst files the price claim. The Risk Critic recomputes that band in Zetaris and approves it.” The trace action is `verify_claim`, and a match ends in `match=true`.
- If the card’s reply says no recommendation, or confidence is 0, stop and use the abstention line in the last section. The 24 October live case did this because the newest prices were six days old.

When a real verdict is on the card, read it from `plain_reply` and the confidence chip:

“[Sell now / Hold / Split], with a price band of [P10] to [P90] shillings per 90-kilo bag, at [the chip] percent confidence.”

Take P10 and P90 from `price_range_per_90kg_bag` in the response. Do not read the large shilling total as the per-bag band.

## 2:10–2:50 — Sponsor technology

**Screen:** the live timeline, scrolled to events whose action is `zetaris_sql` or `county_case`. Then run this in the Zetaris SQL editor. It is the cross-source query the planner traces once per run. `maize.county_case` joins that county’s prices, the Open-Meteo forecast, and the storage rules.

```sql
SELECT county, latest_market_date, quote_count, forecast_date,
       precipitation_sum, temperature_2m_mean, humidity_pct,
       storage, daily_loss_pct, rules_synthetic
FROM maize.county_case
WHERE county = 'Kirinyaga';
```

Then show the `verify_claim` row, then the `recall` row (`memories=…`) and the closing `remember` row (`stored profile verdict=…`).

“Zetaris is the only data path. Weather is a live REST table that Zetaris calls at query time. KAMIS prices sit in Postgres, registered as a Zetaris source, and storage rules and farmer history are views. Here is one SQL query joining prices, forecast and rules. Before the critic approves a price claim, it runs its own query and writes `verify_claim` with the recomputed count, percentiles and newest date. A mismatch sends the claim back.

Meterless H-MEM remembers each farmer’s profile, past verdict and offer gap. That store runs locally under `data/hmem`. It does not need the Nightshift gateway, and you can see the recall and the remember on this trace. Reasoning runs on NVIDIA Nemotron, and we built it in Cursor.

One honest note: Meterless’s Nightshift gateway would not start on our machine, so these model calls go to NVIDIA directly. The Meterless provider path is in the code, and we could not test it against a running gateway. H-MEM is the Meterless piece this run actually uses.”

## 2:50–3:30 — Output and impact

**Screen:** the live reply, then say the receipt line while you point at evidence in the response (source, `as_of`, freshness, and `synthetic` where it is set). The phone does not render the full receipt list. If you only have the phone card, read `plain_reply`, the confidence chip, the source chip and `recheck_schedule`, and do not invent receipts.

“The answer is something she can act on: a verdict, a price band per bag, and a receipt for every fact, with its source and its age. Real data is labelled real and synthetic is labelled synthetic. It says what would change the advice, and it says what it can’t know. This is decision support. It does not place a trade.”

**Recheck, off the phone.** The phone always sends `mode: advise` for farmer `FK-001`. The bundled recheck is `input_examples/example_4.json`: farmer `farmer-kirinyaga-003`, Kirinyaga, 20 bags, open bags, offer 3,450, `mode: recheck`. The synthetic ledger’s prior for that farmer is **hold** on 12 October 2026, with 4 mm of rain over seven days. H-MEM wins if that farmer already has a stored verdict, so use a farmer id that has not been remembered, or clear `data/hmem` for that id first.

Post it, then read the trace action `recheck`:

- Flip, only if the new verdict is sell and seven-day rain is at least 14 mm: “Prior HOLD is not supported. 7-day rain moved from 4 mm to [X] mm and the computed action is SELL.”
- Otherwise read the other sentence the watcher writes: “Prior verdict was hold. Computed verdict is [sell, hold or split]. 7-day rain is [X] mm.”

Say whichever sentence is in the trace. Do not promise a flip.

**Garissa.** Also off the phone. The county on screen is fixed to Kirinyaga. Post `input_examples/example_3.json` (Garissa, 20 bags, open bags, farmer `farmer-garissa-001`). The planner’s coverage gate blocks a county with fewer than three fresh white-maize quotes in 14 days, before the analysts run. The sample case has one quote. The reply is `no_recommendation`, confidence 0, no price band, and the question is: “Which market in Garissa should we price, and what written buyer offer do you have per 90 kg bag?” If this pull now has three or more fresh Garissa quotes, it will not abstain. Say what the response says.

“And when the data is too thin, as in Garissa, it refuses to guess and asks a question. Open Agent Maize turns scattered data into a decision a farmer can act on before the rain.”

## What not to claim

- Do not say Shamba Council. That name is not in this repo.
- Do not say we reported Nightshift to Meterless.
- Do not say Meterless served the model calls unless the trace `provider` is `meterless`. H-MEM still counts: it is Meterless’s memory architecture, vendored from their spec and called on every run.
- Do not narrate the placeholder timeline, the 193 mm banner, or the SQL Inspector text as a live result.
