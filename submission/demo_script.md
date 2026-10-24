# Demo script: Open Agent Maize (about 2 minutes)

**Recording rule:** Use this script for the recommendation path only after Zetaris and Meterless are online and the trace confirms live source reads, fresh prices/forecast and successful Meterless calls. The latest checked local run used sample fallback and correctly returned `no_recommendation`; that is useful as a brief safety branch, but it does not prove the live sponsor path.

## Before recording

1. Start the backend from the repository root with `.env` configured: `npm start` (port 8000).
2. In another terminal, start the UI: `npm run ui` (port 3001). Open `http://localhost:3001`.
3. Check the provider status, use the Meterless connection check, and confirm the Zetaris-backed tables respond. Do not show secrets on screen.
4. Use a request with current county prices and forecast, at least three fresh white-maize quotes, a known storage type, and a realistic optional buyer offer/cash need. The bundled example may be stale; inspect dates before recording.
5. Keep the response trace ID visible. After the run, verify the trace shows Zetaris for the required reads and successful Meterless model calls. If NVIDIA is claimed, verify the actual provider/model/lane in that same trace.

## Narration and screen actions

**0:00–0:20 — Problem and user**  
“Open Agent Maize helps a smallholder compare selling a maize lot today with holding it through storage and forecast risk. It gives decision support, and it never places a trade.” Show the clean request panel.

**0:20–0:45 — Enter a case**  
“Here I enter the farmer record, county, number of 90-kilogram bags and storage type. I can add a buyer offer and cash need, which affect the comparison.” Fill the form with values backed by the live data you checked.

**0:45–1:20 — Run and explain the workflow**  
“Zetaris supplies market, weather and storage evidence. The market and storage analysts make claims, then the risk critic checks freshness, coverage and contradictions. Rejected claims return to their analyst, with bounded revisions and refreshes.” Submit the request; show the real progress trace.

**1:20–1:45 — Result and evidence**  
“The planner compares sell, hold and split with a fixed-seed expected-value simulation. This result shows the price range, evidence dates and source, what could change the recommendation, and when to recheck.” Point to the returned result and evidence. State the provider/model only when the trace confirms it.

**1:45–2:00 — Safety and close**  
“When evidence is stale or too thin, the system abstains and asks for the missing input instead of guessing. The decision is computed from the evidence; model wording cannot change the action.” If a current run abstains, explain the actual failed freshness/coverage gate and do not call it a recommendation.

## If live services are still unavailable

Do not imply sponsor integrations succeeded. Record a clearly labeled sample-mode safety demo only if useful: show the sample-source label, the stale evidence dates, and the `no_recommendation` result. Explain that it demonstrates safe abstention, while a separate verified live run is still required to demonstrate Zetaris and Meterless use.
