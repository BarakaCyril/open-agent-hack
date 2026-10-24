# Impact hypothesis and measurement plan

## Current product boundary

Fieldnote currently targets white maize in Kenya. The current sample corpus is small and partly synthetic; this is not evidence of farmer outcomes. The service can compare a stated buyer offer with market quotes, weather and storage risk, then abstain when data is stale or too thin. It does not buy or sell grain.

## Impact hypothesis

If a farmer or extension worker can compare a buyer offer with current local prices and expected storage risk, they may make a better informed sell, hold or split decision. The strongest expected value is clearer price context, earlier visibility of storage exposure, and a trace that an advisor can review. This is a hypothesis to test with users, not an outcome claim.

## What a pilot should measure

1. Evidence coverage: share of cases with enough fresh, relevant prices and a current forecast.
2. Decision utility: time from request to an understandable comparison, and share of users who report that it helped them decide.
3. Offer context: stated offer minus the local comparable quote, recorded as a comparison rather than money saved.
4. Follow-up: after a recheck, whether the recommendation changed and what the farmer ultimately chose.
5. Safety: abstention precision for stale, sparse, contradictory or implausible evidence; no recommendation should be scored as success when evidence is inadequate.
6. Adoption: repeat use by farmers, cooperatives or extension workers, with consent and data minimisation.

Do not report modeled value differences as realized income or savings. Validate with a pilot and follow-up records before making those claims.

## Global expansion path

The reasoning workflow is portable in principle, but each deployment needs local market feeds, crop and grade definitions, currencies and units, weather coverage, storage-loss evidence, language support, privacy rules and field validation. Start with one additional market and one crop, adapt its data contracts and thresholds, then repeat the same freshness, coverage and abstention evaluation. Do not reuse Kenya's values or thresholds as universal defaults.

## Sponsor contributions to make visible

- Zetaris: query the five structured maize views; retain table and as-of provenance in the evidence list and trace.
- Meterless: route analyst and critic language; log the selected model and lane where the runtime reports them.
- The planner computes the sell/hold/split values independently. Model wording cannot alter that action. A live demo should show successful service checks and the same run's trace.
