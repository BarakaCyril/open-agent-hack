import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { redact } from "./config.js";

export const TRACE_STATUSES = [
  "success",
  "needs_revision",
  "retrying",
  "partial_success",
  "fallback",
  "error",
] as const;

export type TraceStatus = (typeof TRACE_STATUSES)[number];

export interface TraceEvent {
  timestamp: string;
  trace_id: string;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent: string | null;
  confidence: number | null;
  retry_count: number;
  status: TraceStatus;
}

export interface Tracer {
  readonly traceId: string;
  readonly events: TraceEvent[];
  event(partial: Omit<TraceEvent, "timestamp" | "trace_id">): void;
}

export interface RunContext {
  tracer: Tracer;
  agent: string;
  markSampleFallback: (detail: string) => void;
  markNarrativeFallback: (detail: string) => void;
}

export const runContext = new AsyncLocalStorage<RunContext>();

function summarise(value: string): string {
  return redact(value).replace(/\s+/g, " ").slice(0, 180);
}

export function createTracer(traceId: string, logDir: string): Tracer {
  const dir = path.isAbsolute(logDir) ? logDir : path.join(process.cwd(), logDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${traceId}.jsonl`);
  const events: TraceEvent[] = [];
  return {
    traceId,
    events,
    event(partial) {
      const event: TraceEvent = {
        timestamp: new Date().toISOString(),
        trace_id: traceId,
        agent_name: partial.agent_name,
        action: partial.action,
        input_summary: summarise(partial.input_summary),
        output_summary: summarise(partial.output_summary),
        target_agent: partial.target_agent,
        confidence: partial.confidence,
        retry_count: partial.retry_count,
        status: partial.status,
      };
      events.push(event);
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
      const target = event.target_agent ?? "-";
      console.log(
        `${event.timestamp} ${event.trace_id} ${event.agent_name} ${event.action} status=${event.status} target=${target} retries=${event.retry_count} ${event.output_summary}`,
      );
    },
  };
}

export function currentContext(): RunContext | undefined {
  return runContext.getStore();
}

export function traceEvent(partial: Omit<TraceEvent, "timestamp" | "trace_id" | "agent_name"> & { agent_name?: string }): void {
  const ctx = currentContext();
  if (!ctx) {
    console.log(
      `${partial.agent_name ?? "system"} ${partial.action} status=${partial.status} ${summarise(partial.output_summary)}`,
    );
    return;
  }
  ctx.tracer.event({
    agent_name: partial.agent_name ?? ctx.agent,
    action: partial.action,
    input_summary: partial.input_summary,
    output_summary: partial.output_summary,
    target_agent: partial.target_agent,
    confidence: partial.confidence,
    retry_count: partial.retry_count,
    status: partial.status,
  });
}

export async function asAgent<T>(agent: string, fn: () => Promise<T>): Promise<T> {
  const ctx = currentContext();
  if (!ctx) return fn();
  return runContext.run({ ...ctx, agent }, fn);
}
