import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { redact } from "./config.js";
import type { DataSource } from "./schemas.js";

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
  data_source: DataSource | null;
  provider: "meterless" | "nvidia";
  model: string;
  latency_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  lane?: string | null;
}

export interface Tracer {
  readonly traceId: string;
  readonly file: string;
  readonly events: TraceEvent[];
  event(partial: Omit<TraceEvent, "timestamp" | "trace_id">): void;
  finish(): void;
}

export interface RunContext {
  tracer: Tracer;
  agent: string;
  queryCache: Map<string, Promise<Record<string, unknown>[]>>;
  dataSource: () => DataSource | null;
  markSampleFallback: (detail: string) => void;
  markNarrativeFallback: (detail: string) => void;
  modelAnswer: { provider: "meterless" | "nvidia" | null; model: string | null };
}

interface LiveTrace {
  traceId: string;
  file: string;
  events: TraceEvent[];
  listeners: Set<() => void>;
  done: boolean;
}

const traces = new Map<string, LiveTrace>();

export function configuredModel(): { provider: "meterless" | "nvidia"; model: string } {
  const provider = process.env.MODEL_PROVIDER === "nvidia" ? "nvidia" : "meterless";
  const model = provider === "nvidia"
    ? process.env.NVIDIA_MODEL?.trim() || "nvidia/nemotron-3.5-lightning-30b-a3b"
    : process.env.METERLESS_MODEL?.trim() || "meterless/auto";
  return { provider, model };
}

export function noteModelAnswer(provider: "meterless" | "nvidia", model: string): void {
  const ctx = currentContext();
  if (!ctx) return;
  ctx.modelAnswer.provider = provider;
  ctx.modelAnswer.model = model;
}

export function currentModelIdentity(): { provider: "meterless" | "nvidia"; model: string } {
  const ctx = currentContext();
  if (ctx?.modelAnswer.provider && ctx.modelAnswer.model) {
    return { provider: ctx.modelAnswer.provider, model: ctx.modelAnswer.model };
  }
  return configuredModel();
}

export const runContext = new AsyncLocalStorage<RunContext>();

function summarise(value: string): string {
  return redact(value).replace(/\s+/g, " ").slice(0, 180);
}

/** One sentence for a chat log line. Drops secret assignments and key=value fragments. */
export function toLogSentence(value: string): string {
  const stripped = value
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+/gi, "")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = stripped.split(/(?<=[.!?])\s+/u)[0] ?? stripped;
  const ended = !sentence ? "-" : /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
  return summarise(ended);
}

export function resolveLogDir(logDir: string): string {
  return path.isAbsolute(logDir) ? logDir : path.join(process.cwd(), logDir);
}

export function traceFileName(when: Date, county: string, mode: string, traceId: string): string {
  const stamp = when.toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/:/g, "-");
  const safe = (value: string, fallback: string) => {
    const cleaned = value.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return cleaned || fallback;
  };
  return `${stamp}_${safe(county, "county")}_${safe(mode, "mode")}_${traceId.slice(0, 8)}.jsonl`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "00:00:00";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatTraceLine(event: TraceEvent): string {
  const target = event.target_agent ?? "-";
  const summary = event.output_summary.trim().replace(/[.?!]+$/u, "") || "-";
  return `[${clock(event.timestamp)}] ${event.agent_name} -> ${target} | ${event.action} | ${event.status} | ${summary}.`;
}

function attachChatFields(event: TraceEvent, partial: Partial<TraceEvent>): void {
  if (partial.latency_ms !== undefined) event.latency_ms = partial.latency_ms;
  if (partial.prompt_tokens !== undefined) event.prompt_tokens = partial.prompt_tokens;
  if (partial.completion_tokens !== undefined) event.completion_tokens = partial.completion_tokens;
  if (partial.total_tokens !== undefined) event.total_tokens = partial.total_tokens;
  if (partial.lane !== undefined) event.lane = partial.lane;
}

function pointLatest(dir: string, fileName: string): void {
  const latest = path.join(dir, "latest.jsonl");
  fs.rmSync(latest, { force: true });
  fs.symlinkSync(fileName, latest);
}

export function createTracer(traceId: string, logDir: string, meta: { county: string; mode: string }): Tracer {
  const dir = resolveLogDir(logDir);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = traceFileName(new Date(), meta.county, meta.mode, traceId);
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, "", "utf8");
  pointLatest(dir, fileName);
  const events: TraceEvent[] = [];
  const live: LiveTrace = { traceId, file, events, listeners: new Set(), done: false };
  traces.set(traceId, live);
  return {
    traceId,
    file,
    events,
    event(partial) {
      const stamp = configuredModel();
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
        data_source: partial.data_source,
        provider: partial.provider ?? stamp.provider,
        model: partial.model ?? stamp.model,
      };
      attachChatFields(event, partial);
      events.push(event);
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
      console.log(formatTraceLine(event));
      if (!live.done) {
        for (const listener of [...live.listeners]) listener();
      }
    },
    finish() {
      if (live.done) return;
      live.done = true;
      for (const listener of [...live.listeners]) listener();
    },
  };
}

export function currentContext(): RunContext | undefined {
  return runContext.getStore();
}

type TraceInput = Omit<TraceEvent, "timestamp" | "trace_id" | "agent_name" | "data_source" | "provider" | "model"> & {
  agent_name?: string;
  data_source?: DataSource | null;
  provider?: TraceEvent["provider"];
  model?: string;
};

export function traceEvent(partial: TraceInput): void {
  const ctx = currentContext();
  const dataSource = partial.data_source !== undefined ? partial.data_source : ctx?.dataSource() ?? null;
  const stamp = configuredModel();
  const provider = partial.provider ?? stamp.provider;
  const model = partial.model ?? stamp.model;
  if (!ctx) {
    const event: TraceEvent = {
      timestamp: new Date().toISOString(),
      trace_id: "-",
      agent_name: partial.agent_name ?? "system",
      action: partial.action,
      input_summary: summarise(partial.input_summary),
      output_summary: summarise(partial.output_summary),
      target_agent: partial.target_agent,
      confidence: partial.confidence,
      retry_count: partial.retry_count,
      status: partial.status,
      data_source: dataSource,
      provider,
      model,
    };
    attachChatFields(event, partial);
    console.log(formatTraceLine(event));
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
    data_source: dataSource,
    provider,
    model,
    latency_ms: partial.latency_ms,
    prompt_tokens: partial.prompt_tokens,
    completion_tokens: partial.completion_tokens,
    total_tokens: partial.total_tokens,
    lane: partial.lane,
  });
}

export async function asAgent<T>(agent: string, fn: () => Promise<T>): Promise<T> {
  const ctx = currentContext();
  if (!ctx) return fn();
  return runContext.run({ ...ctx, agent }, fn);
}

export function readTraceEvents(file: string): TraceEvent[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of raw.split(/\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // A torn final line is ignored so a reader can still show the rest.
    }
  }
  return events;
}

function findTraceFile(traceId: string, logDir: string): string | null {
  const dir = resolveLogDir(logDir);
  if (!fs.existsSync(dir)) return null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl") || name === "latest.jsonl") continue;
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    const events = readTraceEvents(file);
    if (events.some((event) => event.trace_id === traceId)) return file;
  }
  return null;
}

export function hasTrace(traceId: string, logDir: string): boolean {
  if (traces.has(traceId)) return true;
  return findTraceFile(traceId, logDir) !== null;
}

export function followTrace(traceId: string, logDir: string, sink: {
  onEvent: (event: TraceEvent) => void;
  onEnd: () => void;
}): { found: boolean; close: () => void } {
  const live = traces.get(traceId);
  if (!live) {
    const file = findTraceFile(traceId, logDir);
    if (!file) return { found: false, close() {} };
    for (const event of readTraceEvents(file)) sink.onEvent(event);
    sink.onEnd();
    return { found: true, close() {} };
  }
  let index = 0;
  let ended = false;
  const flush = () => {
    if (ended) return;
    while (index < live.events.length) {
      const event = live.events[index];
      index += 1;
      if (event) sink.onEvent(event);
    }
    if (live.done) {
      ended = true;
      live.listeners.delete(flush);
      sink.onEnd();
    }
  };
  flush();
  if (!ended) live.listeners.add(flush);
  return {
    found: true,
    close() {
      ended = true;
      live.listeners.delete(flush);
    },
  };
}

function formatTokens(event: TraceEvent): string {
  if (event.prompt_tokens == null && event.completion_tokens == null && event.total_tokens == null) return "";
  return `${event.prompt_tokens ?? "-"}/${event.completion_tokens ?? "-"}/${event.total_tokens ?? "-"}`;
}

export function formatTraceTable(events: TraceEvent[]): string {
  if (events.length === 0) return "no events";
  const rows = events.map((event) => ({
    time: clock(event.timestamp),
    handoff: `${event.agent_name} -> ${event.target_agent ?? "-"}`,
    action: event.action,
    status: event.status,
    ms: event.latency_ms == null ? "" : String(event.latency_ms),
    tokens: formatTokens(event),
    summary: (() => {
      const clean = event.output_summary.replace(/\s+/g, " ").trim();
      return clean.length <= 72 ? clean : `${clean.slice(0, 71)}…`;
    })(),
  }));
  const columns: Array<{ header: string; key: keyof (typeof rows)[number] }> = [
    { header: "time", key: "time" },
    { header: "from -> to", key: "handoff" },
    { header: "action", key: "action" },
    { header: "status", key: "status" },
    { header: "ms", key: "ms" },
    { header: "tokens", key: "tokens" },
    { header: "summary", key: "summary" },
  ];
  const widths = columns.map((column) => Math.max(
    column.header.length,
    ...rows.map((row) => row[column.key].length),
  ));
  const render = (values: string[]) => values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd();
  const header = render(columns.map((column) => column.header));
  const rule = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) => render(columns.map((column) => row[column.key])));
  return [header, rule, ...body].join("\n");
}
