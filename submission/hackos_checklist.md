# HackOS submission checklist — Open Agent Maize

Checked against the public HackOS event page on 24 October 2026: https://hackathon.genai.works/event/open-agent-hackathon-2026

## Project readiness

- [x] Project identified: Open Agent Maize, decision support for a Kenyan smallholder comparing sell, hold and split options for white maize.
- [x] Suggested track: Reasoning Architecture. The project uses bounded analyst and critic loops, memory and a computed decision tool.
- [x] User-facing UI submits a request to the backend, displays the returned verdict and evidence, and loads the real run trace.
- [x] UI typecheck and production build pass.
- [x] Backend TypeScript build passes.
- [x] All 66 backend tests pass (12 test files); backend TypeScript build passes.
- [x] Backend `/health`, React UI load and Vite-to-backend API proxy respond successfully on this Windows machine.
- [x] Eight-slide deck created and rendered. Package integrity and layout checks pass with no findings.
- [x] Repo contains setup, architecture, usage, dependencies, sponsor integration details, data licensing and limitations.
- [x] Cursor use is documented. HackOS event rules list Cursor as optional; an Academy course FAQ conflicts and describes it as required. Keep the truthful Cursor disclosure in the submission.
- [x] No trade is placed; the product is decision support, and sample-only data is labeled synthetic.

## Live integration and demo checks

- [x] Zetaris live integration: `/zetaris/check` returned online for all five views: prices 51, weather 8, news 8, storage rules 8, ledger 4 rows.
- [x] Live case used `data_source=zetaris`; it correctly abstained because the latest price evidence was 6 days old and news was 19 days old.
- [ ] Meterless was reported working on the teammate's machine, but is host-specific and was offline from this Windows workspace. Before recording, run the backend where the teammate's configured Meterless host and token are reachable and verify a successful chat call in the trace.
- [ ] Refresh price and forecast evidence before recording an affirmative recommendation demo. Do not present the current live-data abstention as a successful recommendation.
- [ ] NVIDIA lane/model: selectable configuration exists, but no successful NVIDIA run or assigned lane was verified. Only claim use when a run trace confirms it.
- [ ] Record a 1–4 minute demo video showing the product, a real request, returned recommendation/evidence, and trace. Current environment has no recording tool, so no video file is included.

## HackOS account and upload

- [ ] Verify registration, team membership (1–5 members), and eligibility (16+) in the HackOS account. Public pages do not expose this account-specific state.
- [ ] Submit the video, deck, repository link and any requested project fields on the HackOS entry page.
- [ ] Declare any pre-existing product code/components as requested. The repository documents pre-existing components in its README; confirm the HackOS form disclosure matches your project history.
- [ ] Check that the entry is visible/received before the deadline: 27 October 2026 23:45 UTC (28 October 2026 02:45 EAT).

## Judging criteria to address in the demo

- [ ] Impact (30): make the farmer decision and uncertainty concrete.
- [ ] Technical execution (20): show the bounded agent/critic workflow and evidence trace.
- [ ] Innovation (15): explain claim ownership, critic rejection/refresh, and abstention behavior.
- [ ] Demo (15): keep it within 1–4 minutes and use a live, reproducible run.
- [ ] Product & UX (10): show the request flow and understandable evidence display.
- [ ] Sponsor technology (10): clearly show Zetaris and Meterless in successful trace evidence; disclose NVIDIA only if verified.

## Submission files prepared here

- `submission/Open_Agent_Maize_Deck_2026-10-24_v4.pptx` (latest validation status)
- `submission/impact_and_measurement.md` (global impact hypothesis and pilot measures)
- `submission/demo_script.md`
- `submission/hackos_checklist.md`

The deck and this checklist are prepared locally. They have not been uploaded to HackOS, and account registration/team status cannot be confirmed from the public event page.
