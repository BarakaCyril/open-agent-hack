import { loadConfig, redact } from "../config.js";
import { traceEvent } from "../tracing.js";

export type MeterlessHealth = "online" | "unauthorized" | "offline";

export function normalizeMeterlessBase(raw: string): string {
  let url = raw.trim().replace(/\/+$/u, "");
  url = url.replace(/(\/v1)+$/u, "/v1");
  if (!url.endsWith("/v1")) url = `${url}/v1`;
  return url;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "meterless-app": "open-agent-maize",
    "meterless-scope": "user",
    Accept: "application/json",
  };
}

function placeholder(token: string): boolean {
  return token.trim() === "rt-local";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function meterlessHealth(): Promise<MeterlessHealth> {
  const config = loadConfig();
  if (placeholder(config.METERLESS_RUNTIME_TOKEN)) return "unauthorized";
  const url = `${normalizeMeterlessBase(config.METERLESS_BASE_URL)}/models`;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: headers(config.METERLESS_RUNTIME_TOKEN),
      signal: AbortSignal.timeout(Math.min(config.SOURCE_TIMEOUT_SECONDS, 20) * 1000),
    });
    const latency = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      traceEvent({
        agent_name: "smoke",
        action: "meterless_health",
        input_summary: "GET /v1/models",
        output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} http=${response.status}`,
        target_agent: null,
        confidence: null,
        retry_count: 0,
        status: "error",
      });
      return "unauthorized";
    }
    if (response.status !== 200) return "offline";
    const ids = modelIds(await response.json() as unknown);
    const online = ids.some((id) => id.toLowerCase().includes("meterless"));
    traceEvent({
      agent_name: "smoke",
      action: "meterless_health",
      input_summary: "GET /v1/models",
      output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} ids=${ids.length}`,
      target_agent: null,
      confidence: null,
      retry_count: 0,
      status: online ? "success" : "error",
    });
    return online ? "online" : "offline";
  } catch {
    return "offline";
  }
}

export interface ChatText {
  text: string;
  fallback: boolean;
  detail: string;
}

export async function completeText(options: { agent: string; system: string; user: string }): Promise<ChatText> {
  const config = loadConfig();
  if (placeholder(config.METERLESS_RUNTIME_TOKEN)) {
    throw new Error("METERLESS_RUNTIME_TOKEN is the placeholder rt-local and was refused");
  }
  const url = `${normalizeMeterlessBase(config.METERLESS_BASE_URL)}/chat/completions`;
  const waits = [2000, 4000, 8000];
  let rateAttempts = 0;
  let networkAttempts = 0;
  const maxNetwork = config.MAX_RETRIES + 1;
  while (true) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers(config.METERLESS_RUNTIME_TOKEN), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.METERLESS_MODEL,
          temperature: 0.2,
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const latency = Date.now() - started;
      const raw = await response.text();
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) as unknown : null;
      } catch {
        body = null;
      }
      if (response.status === 429 && rateAttempts < waits.length) {
        const wait = waits[rateAttempts] ?? 8000;
        rateAttempts += 1;
        traceEvent({
          agent_name: options.agent,
          action: "meterless_chat",
          input_summary: options.user.slice(0, 80),
          output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} http=429`,
          target_agent: null,
          confidence: null,
          retry_count: rateAttempts,
          status: "retrying",
        });
        await sleep(wait);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        const message = errorText(body, response.status);
        traceEvent({
          agent_name: options.agent,
          action: "meterless_chat",
          input_summary: options.user.slice(0, 80),
          output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} ${message}`,
          target_agent: null,
          confidence: null,
          retry_count: rateAttempts + networkAttempts,
          status: "error",
        });
        throw new Error(`Meterless unauthorized: ${message}`);
      }
      if (!response.ok) {
        const message = errorText(body, response.status);
        const retryable = response.status >= 500;
        if (retryable && networkAttempts + 1 < maxNetwork) {
          networkAttempts += 1;
          traceEvent({
            agent_name: options.agent,
            action: "meterless_chat",
            input_summary: options.user.slice(0, 80),
            output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} ${message}`,
            target_agent: null,
            confidence: null,
            retry_count: networkAttempts,
            status: "retrying",
          });
          await sleep(200 * 2 ** (networkAttempts - 1));
          continue;
        }
        traceEvent({
          agent_name: options.agent,
          action: "meterless_chat",
          input_summary: options.user.slice(0, 80),
          output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} ${message}`,
          target_agent: null,
          confidence: null,
          retry_count: networkAttempts,
          status: "fallback",
        });
        return { text: "", fallback: true, detail: message };
      }
      const content = body && typeof body === "object"
        ? (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? ""
        : "";
      traceEvent({
        agent_name: options.agent,
        action: "meterless_chat",
        input_summary: options.user.slice(0, 80),
        output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} chars=${content.length}`,
        target_agent: null,
        confidence: null,
        retry_count: rateAttempts + networkAttempts,
        status: content.trim() ? "success" : "partial_success",
      });
      return { text: content.trim(), fallback: !content.trim(), detail: content.trim() ? "ok" : "empty completion" };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Meterless unauthorized")) throw error;
      const name = error instanceof Error ? error.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      const latency = Date.now() - started;
      if (!timedOut && networkAttempts + 1 < maxNetwork) {
        networkAttempts += 1;
        traceEvent({
          agent_name: options.agent,
          action: "meterless_chat",
          input_summary: options.user.slice(0, 80),
          output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} network`,
          target_agent: null,
          confidence: null,
          retry_count: networkAttempts,
          status: "retrying",
        });
        await sleep(200 * 2 ** (networkAttempts - 1));
        continue;
      }
      const detail = timedOut ? "chat timed out after 180s" : "meterless unreachable";
      traceEvent({
        agent_name: options.agent,
        action: "meterless_chat",
        input_summary: options.user.slice(0, 80),
        output_summary: `model=${config.METERLESS_MODEL} latency_ms=${latency} ${detail}`,
        target_agent: null,
        confidence: null,
        retry_count: networkAttempts,
        status: "fallback",
      });
      return { text: "", fallback: true, detail };
    }
  }
}
