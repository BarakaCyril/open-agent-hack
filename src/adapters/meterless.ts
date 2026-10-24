import fs from "node:fs";
import path from "node:path";
import { loadConfig, projectRoot, redact, resetConfigForTests } from "../config.js";
import { noteModelAnswer, toLogSentence, traceEvent } from "../tracing.js";
import { mismatchedNumbers } from "../wording.js";

export const METERLESS_PROVIDER_ID = "meterless";
export const METERLESS_PROVIDER_NAME = "Meterless Runtime";
export const METERLESS_DEFAULT_BASE_URL = "http://127.0.0.1:8088/v1";
export const METERLESS_APP_ID = "open-agent-maize";
/** Settings key from the runtime contract. This app stores that value in METERLESS_RUNTIME_TOKEN. */
export const METERLESS_TOKEN_KEY = "meterless_runtime_token";
export const METERLESS_CHAT_TIMEOUT_MS = 180_000;
export const METERLESS_DISPOSITIONS = ["auto", "fast", "deep", "cheap", "local", "fusion"] as const;
export const METERLESS_ROUTING_MODES = METERLESS_DISPOSITIONS.map((disposition) => `meterless/${disposition}`);

const DETECT_PORTS = [8088, 8090, 8787, 11434] as const;
const DETECT_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;
const DETECT_TIMEOUT_MS = 1500;

export type MeterlessHealth = "online" | "unauthorized" | "offline";

export interface ConnectLink {
  baseUrl: string;
  token: string;
  model: string | null;
  healthUrl: string;
}

export interface MeterlessSettings {
  baseUrl: string;
  token: string;
  model: string;
}

export type ModelProviderId = "meterless" | "nvidia";

export interface ChatTarget {
  provider: ModelProviderId;
  baseUrl: string;
  token: string;
  model: string;
}

export interface ChatResult {
  text: string;
  fallback: boolean;
  wordingRejected: boolean;
  detail: string;
  provider: ModelProviderId;
  model: string;
}

interface TokenCounts {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface ChatText {
  text: string;
  fallback: boolean;
  detail: string;
  reportedModel: string;
  provider: ModelProviderId;
}

class ProviderAuthError extends Error {
  constructor(provider: ModelProviderId, detail: string) {
    super(`${provider} unauthorized: ${detail}`);
    this.name = "ProviderAuthError";
  }
}

export interface MeterlessTestResult {
  status: MeterlessHealth;
  detail: string;
  reply?: string;
  model?: string;
  requested?: string;
  token_key?: string;
}

let discoveredModels: string[] | null = null;

export function resetMeterlessDiscoveryForTests(): void {
  discoveredModels = null;
}

function placeholder(token: string): boolean {
  return token.trim() === "rt-local";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envFile(): string {
  const override = process.env.METERLESS_ENV_FILE;
  if (override && override.trim()) return path.resolve(override);
  return path.join(projectRoot(), ".env");
}

function writeEnvValue(key: string, value: string): void {
  if (/[\r\n]/u.test(value)) throw new Error(`Refusing to store ${key}`);
  const assignment = /[\s#"'\\]/u.test(value)
    ? `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : `${key}=${value}`;
  const file = envFile();
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(raw)
    ? raw.replace(pattern, assignment)
    : `${raw.replace(/\s*$/u, "")}${raw.trim() ? "\n" : ""}${assignment}\n`;
  fs.writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`);
  process.env[key] = value;
  if (key === "METERLESS_BASE_URL") discoveredModels = null;
  resetConfigForTests();
}

function fragmentParam(hash: string, name: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, "%2B"));
    if (key !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).replace(/\+/g, "%2B"));
  }
  return null;
}

/** A connect link is only http(s) with path /connect and fragment k. Anything else is not a link. */
export function parseConnectLink(text: string): ConnectLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (pathname !== "/connect") return null;
  const token = fragmentParam(url.hash, "k");
  if (!token) return null;
  const model = fragmentParam(url.hash, "m");
  return {
    baseUrl: `${url.origin}/v1`,
    token,
    model,
    healthUrl: `${url.origin}/healthz`,
  };
}

export function normalizeMeterlessBase(raw: string): string {
  const link = parseConnectLink(raw);
  if (link) return link.baseUrl;
  let input = raw.trim();
  const hash = input.indexOf("#");
  if (hash >= 0) input = input.slice(0, hash);
  const query = input.indexOf("?");
  if (query >= 0) input = input.slice(0, query);
  input = input.replace(/\/+$/u, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `http://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return METERLESS_DEFAULT_BASE_URL;
  }
  let pathname = url.pathname.replace(/\/+$/u, "");
  const endings = ["/chat/completions", "/models", "/healthz", "/connect", "/v1"];
  for (let guard = 0; guard < 8; guard += 1) {
    const lower = pathname.toLowerCase();
    const ending = endings.find((suffix) => lower.endsWith(suffix));
    if (!ending) break;
    pathname = pathname.slice(0, -ending.length).replace(/\/+$/u, "");
  }
  return `${url.origin}${pathname}/v1`;
}

export function applyConnectLink(text: string): { baseUrl: string; model: string } | null {
  const link = parseConnectLink(text);
  if (!link) return null;
  writeEnvValue("METERLESS_BASE_URL", link.baseUrl);
  writeEnvValue("METERLESS_RUNTIME_TOKEN", link.token);
  if (link.model && link.model.toLowerCase().startsWith("meterless/")) {
    const suffix = link.model.slice(link.model.indexOf("/") + 1);
    if (suffix) writeEnvValue("METERLESS_MODEL", `meterless/${suffix}`);
  }
  return { baseUrl: link.baseUrl, model: loadConfig().METERLESS_MODEL };
}

function resolveSettings(): MeterlessSettings {
  const config = loadConfig();
  const link = parseConnectLink(config.METERLESS_BASE_URL);
  if (link) {
    const applied = applyConnectLink(config.METERLESS_BASE_URL);
    return {
      baseUrl: link.baseUrl,
      token: link.token,
      model: applied?.model ?? config.METERLESS_MODEL,
    };
  }
  return {
    baseUrl: normalizeMeterlessBase(config.METERLESS_BASE_URL),
    token: config.METERLESS_RUNTIME_TOKEN,
    model: config.METERLESS_MODEL,
  };
}

export function meterlessSettings(): MeterlessSettings {
  const settings = resolveSettings();
  return { baseUrl: settings.baseUrl, token: settings.token, model: settings.model };
}

function meterlessTarget(): ChatTarget {
  const settings = resolveSettings();
  return { provider: "meterless", baseUrl: settings.baseUrl, token: settings.token, model: settings.model };
}

function nvidiaTarget(): ChatTarget {
  const config = loadConfig();
  return {
    provider: "nvidia",
    baseUrl: normalizeMeterlessBase(config.NVIDIA_BASE_URL),
    token: config.NVIDIA_API_KEY,
    model: config.NVIDIA_MODEL,
  };
}

export function activeChatTarget(): ChatTarget {
  return loadConfig().MODEL_PROVIDER === "nvidia" ? nvidiaTarget() : meterlessTarget();
}

export function wordingFallbackNote(): string {
  const selected = activeChatTarget();
  return `Wording fell back to the computed figures because the ${selected.provider} call for model ${selected.model} did not return a usable reply.`;
}

function openAbort(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function chatHeaders(target: ChatTarget): Record<string, string> {
  const result: Record<string, string> = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (target.provider === "meterless") {
    result["meterless-app"] = METERLESS_APP_ID;
    result["meterless-scope"] = "user";
  }
  return result;
}

export function knownMeterlessModels(): { source: "runtime" | "default"; ids: string[] } {
  if (discoveredModels && discoveredModels.length > 0) return { source: "runtime", ids: [...discoveredModels] };
  return { source: "default", ids: [...METERLESS_ROUTING_MODES] };
}

export function selectMeterlessModel(model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed.toLowerCase().startsWith("meterless/")) return false;
  const id = `meterless/${trimmed.slice(trimmed.indexOf("/") + 1)}`;
  if (id === "meterless/" || /\s/u.test(id)) return false;
  writeEnvValue("METERLESS_MODEL", id);
  return true;
}

function headers(token: string, chat: boolean): Record<string, string> {
  const result: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "meterless-app": METERLESS_APP_ID,
    Accept: "application/json",
  };
  if (chat) result["meterless-scope"] = "user";
  return result;
}

function errorText(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return redact(error);
    if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
      return redact((error as { message: string }).message);
    }
    if ("message" in body && typeof (body as { message: unknown }).message === "string") {
      return redact((body as { message: string }).message);
    }
  }
  return `HTTP ${status}`;
}

function modelIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && "id" in item && typeof (item as { id: unknown }).id === "string") {
      return [(item as { id: string }).id];
    }
    return [];
  });
}

/** Keep every meterless/* id, including ones this app does not recognise. Drop everything else. */
export function meterlessModelIds(body: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of modelIds(body)) {
    if (!id.toLowerCase().startsWith("meterless/")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (type.includes("reason") || type === "thinking") return "";
    if (typeof record.text === "string") return record.text;
    return "";
  }).join("");
}

/** Assistant message content only. reasoning_content and think blocks stay out of the log and the reply. */
function assistantText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const message = (body as { choices?: Array<{ message?: unknown }> }).choices?.[0]?.message;
  if (!message || typeof message !== "object") return "";
  return stripHiddenReasoning(textContent((message as { content?: unknown }).content));
}

function reportedFrom(body: unknown, requested: string): { model: string; lane: string | null } {
  let model = requested;
  let lane: string | null = null;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.model === "string" && record.model.trim()) model = record.model.trim();
    const block = record.meterless;
    if (block && typeof block === "object") {
      const extra = block as Record<string, unknown>;
      for (const key of ["lane", "model", "served_model", "backend"]) {
        const value = extra[key];
        if (typeof value === "string" && value.trim()) {
          lane = value.trim();
          break;
        }
      }
    }
  }
  return { model, lane };
}

function modelSummary(body: unknown, requested: string, headerLane: string | null): { reported: string; lane: string | null } {
  const parsed = reportedFrom(body, requested);
  const lane = parsed.lane || headerLane;
  return { reported: parsed.model, lane: lane && lane.trim() ? lane.trim() : null };
}

function tokenCounts(body: unknown): TokenCounts {
  const empty: TokenCounts = { prompt_tokens: null, completion_tokens: null, total_tokens: null };
  if (!body || typeof body !== "object") return empty;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return empty;
  const record = usage as Record<string, unknown>;
  const read = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  };
  return {
    prompt_tokens: read("prompt_tokens", "input_tokens"),
    completion_tokens: read("completion_tokens", "output_tokens"),
    total_tokens: read("total_tokens"),
  };
}

const DECISION_WORDS = ["no_recommendation", "approve", "reject", "escalate", "sell", "hold", "split"] as const;

function mentions(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(text);
}

/** The visible decision and one reason. Hidden reasoning is not part of this text. */
function chatOutcomeSummary(text: string, detail: string): string {
  const visible = text.replace(/\s+/g, " ").trim();
  if (!visible) {
    const why = detail.replace(/\s+/g, " ").trim() || "the model returned no usable reply";
    return toLogSentence(`No decision was returned because ${why.replace(/[.]+$/u, "")}`);
  }
  const reason = visible.split(/(?<=[.!?])\s+/u).map((part) => part.trim()).find(Boolean) ?? visible;
  const decision = DECISION_WORDS.find((word) => mentions(visible, word));
  if (decision && !mentions(reason, decision)) return toLogSentence(`Decision ${decision}. ${reason}`);
  return toLogSentence(reason);
}

function stripHiddenReasoning(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, " ")
    .trim();
}

interface ModelsProbe {
  status: MeterlessHealth;
  ids: string[];
}

async function probeModels(baseUrl: string, token: string, timeoutMs: number): Promise<ModelsProbe> {
  const response = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: headers(token, false),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) return { status: "unauthorized", ids: [] };
  if (response.status !== 200) return { status: "offline", ids: [] };
  let body: unknown = null;
  try {
    body = await response.json() as unknown;
  } catch {
    return { status: "offline", ids: [] };
  }
  const ids = meterlessModelIds(body);
  if (ids.length === 0) return { status: "offline", ids: [] };
  discoveredModels = ids;
  return { status: "online", ids };
}

export async function meterlessHealth(): Promise<MeterlessHealth> {
  const settings = resolveSettings();
  if (placeholder(settings.token)) return "unauthorized";
  const started = Date.now();
  try {
    const config = loadConfig();
    const probe = await probeModels(
      settings.baseUrl,
      settings.token,
      Math.min(config.SOURCE_TIMEOUT_SECONDS, 20) * 1000,
    );
    const latency = Date.now() - started;
    traceEvent({
      agent_name: "smoke",
      action: "meterless_health",
      input_summary: "GET /v1/models",
      output_summary: `provider=meterless model=${settings.model} latency_ms=${latency} status=${probe.status} ids=${probe.ids.length}`,
      provider: "meterless",
      model: settings.model,
      target_agent: null,
      confidence: null,
      retry_count: 0,
      status: probe.status === "online" ? "success" : "error",
    });
    return probe.status;
  } catch {
    return "offline";
  }
}

async function chatWith(target: ChatTarget, options: { agent: string; system: string; user: string }): Promise<ChatResult> {
  if (target.provider === "meterless" && placeholder(target.token)) {
    throw new Error("METERLESS_RUNTIME_TOKEN is the placeholder rt-local and was refused");
  }
  if (typeof options.system !== "string" || typeof options.user !== "string") {
    throw new Error("plain text content must stay a string");
  }
  const url = `${target.baseUrl}/chat/completions`;
  const waits = [2000, 4000, 8000];
  let rateAttempts = 0;
  let networkAttempts = 0;
  const maxNetwork = loadConfig().MAX_RETRIES + 1;
  const ceiling = waits.length + maxNetwork + 2;
  let attempts = 0;
  while (attempts < ceiling) {
    attempts += 1;
    const started = Date.now();
    const abort = openAbort(METERLESS_CHAT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: chatHeaders(target),
        body: JSON.stringify({
          model: target.model,
          temperature: 0.2,
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
        }),
        signal: abort.signal,
      });
      const latency = Date.now() - started;
      const raw = await response.text();
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) as unknown : null;
      } catch {
        body = null;
      }
      const headerLane = target.provider === "meterless"
        ? response.headers.get("x-meterless-model") || response.headers.get("meterless-model")
        : null;
      const described = modelSummary(body, target.model, headerLane);
      const tokens = tokenCounts(body);
      const recordChat = (
        status: "success" | "partial_success" | "fallback" | "error" | "retrying",
        output: string,
        retryCount: number,
        model: string,
        lane: string | null,
        counts: TokenCounts,
      ) => {
        traceEvent({
          agent_name: options.agent,
          action: "chat",
          input_summary: toLogSentence(options.user),
          output_summary: output,
          target_agent: null,
          confidence: null,
          retry_count: retryCount,
          status,
          provider: target.provider,
          model,
          latency_ms: latency,
          prompt_tokens: counts.prompt_tokens,
          completion_tokens: counts.completion_tokens,
          total_tokens: counts.total_tokens,
          lane,
        });
        noteModelAnswer(target.provider, model);
      };
      if (response.status === 429 && rateAttempts < waits.length) {
        const wait = waits[rateAttempts] ?? 8000;
        rateAttempts += 1;
        recordChat("retrying", chatOutcomeSummary("", "the service asked for a retry"), rateAttempts, described.reported, described.lane, tokens);
        await sleep(wait);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        const message = errorText(body, response.status);
        recordChat("error", chatOutcomeSummary("", message), rateAttempts + networkAttempts, described.reported, described.lane, tokens);
        throw new ProviderAuthError(target.provider, message);
      }
      if (!response.ok) {
        const message = errorText(body, response.status);
        const retryable = response.status >= 500;
        if (retryable && networkAttempts + 1 < maxNetwork) {
          networkAttempts += 1;
          recordChat("retrying", chatOutcomeSummary("", message), networkAttempts, described.reported, described.lane, tokens);
          await sleep(200 * 2 ** (networkAttempts - 1));
          continue;
        }
        recordChat("fallback", chatOutcomeSummary("", message), networkAttempts, described.reported, described.lane, tokens);
        return { text: "", fallback: true, wordingRejected: false, detail: message, provider: target.provider, model: described.reported };
      }
      const content = assistantText(body);
      recordChat(
        content.trim() ? "success" : "partial_success",
        chatOutcomeSummary(content, content.trim() ? "ok" : "the model returned an empty completion"),
        rateAttempts + networkAttempts,
        described.reported,
        described.lane,
        tokens,
      );
      const badNumbers = content.trim() ? mismatchedNumbers(content, options.user) : [];
      if (badNumbers.length > 0) {
        const listed = badNumbers.map((value) => String(value)).join(" and ");
        const noun = badNumbers.length === 1 ? "a computed value" : "computed values";
        traceEvent({
          agent_name: options.agent,
          action: "wording_rejected",
          input_summary: toLogSentence(options.user),
          output_summary: toLogSentence(`Rejected the model wording because ${listed} did not match ${noun}, so the reply uses the computed wording.`),
          target_agent: null,
          confidence: null,
          retry_count: rateAttempts + networkAttempts,
          status: "fallback",
          provider: target.provider,
          model: described.reported,
        });
        return {
          text: "",
          fallback: false,
          wordingRejected: true,
          detail: "wording rejected",
          provider: target.provider,
          model: described.reported,
        };
      }
      return {
        text: content.trim(),
        fallback: !content.trim(),
        wordingRejected: false,
        detail: content.trim() ? "ok" : "empty completion",
        provider: target.provider,
        model: described.reported,
      };
    } catch (error) {
      if (error instanceof ProviderAuthError) throw error;
      const name = error instanceof Error ? error.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      const latency = Date.now() - started;
      const recordFailure = (status: "retrying" | "fallback", detail: string, retryCount: number) => {
        traceEvent({
          agent_name: options.agent,
          action: "chat",
          input_summary: toLogSentence(options.user),
          output_summary: chatOutcomeSummary("", detail),
          target_agent: null,
          confidence: null,
          retry_count: retryCount,
          status,
          provider: target.provider,
          model: target.model,
          latency_ms: latency,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          lane: null,
        });
      };
      if (!timedOut && networkAttempts + 1 < maxNetwork) {
        networkAttempts += 1;
        recordFailure("retrying", "the network failed", networkAttempts);
        await sleep(200 * 2 ** (networkAttempts - 1));
        continue;
      }
      const detail = timedOut ? "chat timed out after 180s" : `${target.provider} unreachable`;
      recordFailure("fallback", detail, networkAttempts);
      noteModelAnswer(target.provider, target.model);
      return { text: "", fallback: true, wordingRejected: false, detail, provider: target.provider, model: target.model };
    } finally {
      abort.cancel();
    }
  }
  noteModelAnswer(target.provider, target.model);
  return { text: "", fallback: true, wordingRejected: false, detail: "retry limit reached", provider: target.provider, model: target.model };
}

/** One chat function for every agent. MODEL_PROVIDER chooses meterless or nvidia. */
export async function chat(options: { agent: string; system: string; user: string }): Promise<ChatResult> {
  return chatWith(activeChatTarget(), options);
}

export async function completeText(options: { agent: string; system: string; user: string }): Promise<ChatText> {
  const result = await chat(options);
  return {
    text: result.text,
    fallback: result.fallback,
    detail: result.detail,
    reportedModel: result.model,
    provider: result.provider,
  };
}

export interface ProviderHealth {
  provider: ModelProviderId;
  status: MeterlessHealth;
  model: string;
  reply?: string;
}

/** NVIDIA health is one tiny chat completion. It does not call GET /v1/models. */
export async function nvidiaHealth(): Promise<ProviderHealth> {
  const target = nvidiaTarget();
  try {
    const result = await chatWith(target, {
      agent: "smoke",
      system: "Reply with one word.",
      user: "ok",
    });
    if (result.fallback || !result.text.trim()) {
      return { provider: "nvidia", status: "offline", model: result.model };
    }
    return { provider: "nvidia", status: "online", model: result.model, reply: result.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message.toLowerCase().includes("unauthorized") ? "unauthorized" : "offline";
    return { provider: "nvidia", status, model: target.model };
  }
}

export async function completePlainText(user: string, system = "Reply with one sentence."): Promise<string> {
  const result = await completeText({ agent: "smoke", system, user });
  if (result.fallback) throw new Error(result.detail || "meterless offline");
  return result.text;
}

export async function testMeterlessConnection(): Promise<MeterlessTestResult> {
  const settings = resolveSettings();
  const health = await meterlessHealth();
  if (health === "unauthorized") {
    return {
      status: "unauthorized",
      detail: "unauthorized",
      token_key: METERLESS_TOKEN_KEY,
      requested: settings.model,
    };
  }
  if (health !== "online") return { status: "offline", detail: "offline", requested: settings.model };
  try {
    const result = await chatWith(meterlessTarget(), {
      agent: "smoke",
      system: "Reply with one sentence.",
      user: "Say hello in one sentence.",
    });
    if (result.fallback || typeof result.text !== "string" || !result.text.trim()) {
      return { status: "offline", detail: "offline", requested: settings.model, model: result.model };
    }
    return {
      status: "online",
      detail: "online",
      reply: result.text,
      model: result.model,
      requested: settings.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    if (message.toLowerCase().includes("unauthorized")) {
      return { status: "unauthorized", detail: "unauthorized", token_key: METERLESS_TOKEN_KEY, requested: settings.model };
    }
    return { status: "offline", detail: "offline", requested: settings.model };
  }
}

export async function autoDetectMeterless(): Promise<{ baseUrl: string; status: "online" | "unauthorized" } | null> {
  const settings = resolveSettings();
  for (const port of DETECT_PORTS) {
    for (const host of DETECT_HOSTS) {
      const baseUrl = normalizeMeterlessBase(`http://${host}:${port}`);
      let probe: ModelsProbe;
      try {
        probe = await probeModels(baseUrl, settings.token, DETECT_TIMEOUT_MS);
      } catch {
        probe = { status: "offline", ids: [] };
      }
      const rejected = placeholder(settings.token);
      if (probe.status === "offline") continue;
      const status = rejected ? "unauthorized" : probe.status;
      if (status === "online" || status === "unauthorized") {
        writeEnvValue("METERLESS_BASE_URL", baseUrl);
        if (probe.ids.length > 0) discoveredModels = probe.ids;
        return { baseUrl, status };
      }
    }
  }
  return null;
}
