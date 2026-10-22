import { z } from "zod";

export const CRITIC_REASONS = [
  "freshness",
  "coverage",
  "contradiction",
  "missing_evidence",
  "outlier",
  "maize_type_mismatch",
  "missing_input",
  "farmer_limits",
] as const;

export const CriticReasonSchema = z.enum(CRITIC_REASONS);
export type CriticReason = z.infer<typeof CriticReasonSchema>;

export const RunRequestSchema = z.object({
  farmer_id: z.string().min(1),
  county: z.string().min(1),
  bags: z.number().int().positive().default(20),
  storage: z.enum(["open_bags", "dry_store", "hermetic", "crib"]),
  offer_per_bag: z.number().positive().optional(),
  cash_need: z.number().nonnegative().optional(),
  mode: z.enum(["advise", "recheck"]),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;

export const EvidenceSchema = z.object({
  source: z.string().min(1),
  as_of: z.string().min(1),
  freshness: z.string().min(1),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.object({
  id: z.string(),
  agent: z.string(),
  statement: z.string(),
  evidence: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "approved", "rejected", "escalated"]),
  revision: z.number().int().nonnegative(),
});

export type Claim = z.infer<typeof ClaimSchema>;

export const CriticDecisionSchema = z.object({
  action: z.enum(["approve", "reject", "escalate"]),
  reasons: z.array(CriticReasonSchema),
  notes: z.array(z.string()),
  target_agents: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type CriticDecision = z.infer<typeof CriticDecisionSchema>;

export const MemoryRecallSchema = z.object({
  farmer_id: z.string(),
  kind: z.string(),
  content: z.string(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export type MemoryRecall = z.infer<typeof MemoryRecallSchema>;

export const PriorVerdictSchema = z.object({
  verdict: z.enum(["sell", "hold", "split", "no_recommendation"]),
  as_of: z.string(),
  forecast_rain_mm_7d: z.number().nullable(),
  source: z.string(),
});

export type PriorVerdict = z.infer<typeof PriorVerdictSchema>;

export const CaseStateSchema = z.object({
  trace_id: z.string(),
  question: z.string(),
  request: RunRequestSchema,
  today: z.string(),
  memory_recall: z.array(MemoryRecallSchema),
  claims: z.array(ClaimSchema),
  critic_decisions: z.array(CriticDecisionSchema),
  last_decision: CriticDecisionSchema.nullable(),
  revision_counts: z.object({
    total: z.number().int().nonnegative(),
    market: z.number().int().nonnegative(),
    storage: z.number().int().nonnegative(),
  }),
  refresh_counts: z.object({
    total: z.number().int().nonnegative(),
    market: z.number().int().nonnegative(),
    storage: z.number().int().nonnegative(),
  }),
  round: z.number().int().nonnegative(),
  coverage: z.object({
    price_rows: z.number().int().nonnegative(),
    fresh_price_rows: z.number().int().nonnegative(),
    thin: z.boolean(),
    blocking: z.boolean(),
    note: z.string(),
  }),
  prior: PriorVerdictSchema.nullable(),
  escalation: z.object({
    reason: z.string(),
    question: z.string().nullable(),
  }).nullable(),
  approved: z.boolean(),
  sources: z.object({
    prices: z.enum(["zetaris", "sample"]).optional(),
    weather: z.enum(["zetaris", "sample"]).optional(),
    rules: z.enum(["zetaris", "sample"]).optional(),
    news: z.enum(["zetaris", "sample"]).optional(),
    ledger: z.enum(["zetaris", "sample"]).optional(),
  }),
  synthetic_inputs: z.array(z.string()),
  narrative_fallback: z.boolean(),
});

export type CaseState = z.infer<typeof CaseStateSchema>;

export const DataSourceSchema = z.enum(["zetaris", "mixed", "sample"]);
export type DataSource = z.infer<typeof DataSourceSchema>;

export const RunResponseSchema = z.object({
  verdict: z.enum(["sell", "hold", "split", "no_recommendation"]),
  data_source: DataSourceSchema,
  hold_days: z.number().int().nullable(),
  price_range_per_90kg_bag: z.object({
    p10: z.number(),
    p50: z.number(),
    p90: z.number(),
  }).nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
  reasoning_trace_summary: z.string(),
  what_would_change_this_advice: z.array(z.string()),
  limitations: z.array(z.string()),
  recheck_schedule: z.string(),
  plain_reply: z.string(),
  trace_id: z.string(),
  reason: z.string().nullable(),
  question_for_farmer: z.string().nullable(),
});

export type RunResponse = z.infer<typeof RunResponseSchema>;
