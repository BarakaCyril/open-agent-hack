// API Client for Open Agent Maize Backend (Fastify Port 8000)

const BASE_URL = '/api';

export interface ZetarisTableCheck {
  table: string;
  status: 'online' | 'error';
  row_count?: number;
  detail?: string;
}

export interface ZetarisCheckResponse {
  status: 'online' | 'partial' | 'offline';
  tables: ZetarisTableCheck[];
}

export interface ProviderItem {
  id: 'meterless' | 'nvidia' | 'zetaris';
  name: string;
  role: string;
  selected: boolean;
  base_url?: string;
  model?: string;
  models?: string[];
  token_key?: string;
}

export interface ProvidersResponse {
  primary: 'meterless' | 'nvidia';
  providers: ProviderItem[];
}

export interface MeterlessTestResponse {
  status: 'online' | 'unauthorized' | 'offline';
  detail: string;
  reply?: string;
  model?: string;
  requested?: string;
  token_key?: string;
}

export interface RunCaseRequest {
  farmer_id: string;
  county: string;
  bags: number;
  storage: 'open_bags' | 'crib' | 'hermetic' | 'dry_store';
  offer_per_bag?: number;
  cash_need?: number;
  mode: 'advise' | 'recheck';
}

export interface RunCaseResponse {
  verdict: 'sell' | 'hold' | 'split' | 'no_recommendation';
  data_source: 'zetaris' | 'mixed' | 'sample';
  hold_days: number | null;
  price_range_per_90kg_bag: {
    p10: number;
    p50: number;
    p90: number;
  } | null;
  decision_values_kes: {
    sell: number;
    hold: number;
    split: number;
    edge_over_next_best: number;
  } | null;
  confidence: number;
  evidence: Array<{ source: string; as_of: string; freshness: string; synthetic?: boolean }>;
  reasoning_trace_summary: string;
  what_would_change_this_advice: string[];
  limitations: string[];
  recheck_schedule: string;
  plain_reply: string;
  provider: 'meterless' | 'nvidia';
  model: string;
  trace_id: string;
  reason: string | null;
  question_for_farmer: string | null;
}

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
  status: string;
  provider: 'meterless' | 'nvidia';
  model: string;
}

async function readBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let message = text || `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // The error body was not JSON.
    }
    throw new Error(message);
  }
  return JSON.parse(text) as T;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  try {
    return await readBody<T>(await fetch(`${BASE_URL}${path}`, options));
  } catch (error) {
    if (error instanceof TypeError) {
      return readBody<T>(await fetch(`http://localhost:8000${path}`, options));
    }
    throw error;
  }
}

export function formatTraceLine(event: TraceEvent): string {
  const date = new Date(event.timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const clock = Number.isNaN(date.getTime()) ? "00:00:00" : `${hh}:${mm}:${ss}`;
  const target = event.target_agent ?? "-";
  const summary = event.output_summary.trim().replace(/[.?!]+$/u, "") || "-";
  return `[${clock}] ${event.agent_name} -> ${target} | ${event.action} | ${event.status} | ${summary}.`;
}

export const api = {
  checkHealth: async (): Promise<boolean> => {
    try {
      const res = await request<{ status: string }>('/health');
      return res.status === 'ok';
    } catch {
      return false;
    }
  },

  checkZetaris: async (): Promise<ZetarisCheckResponse> => {
    return request<ZetarisCheckResponse>('/zetaris/check');
  },

  getProviders: async (): Promise<ProvidersResponse> => {
    return request<ProvidersResponse>('/providers');
  },

  testMeterless: async (): Promise<MeterlessTestResponse> => {
    return request<MeterlessTestResponse>('/meterless/test', { method: 'POST' });
  },

  detectMeterless: async (): Promise<{ status: string; detail: string; base_url?: string }> => {
    return request('/meterless/detect', { method: 'POST' });
  },

  connectMeterless: async (link: string): Promise<any> => {
    return request('/meterless/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link }),
    });
  },

  setMeterlessModel: async (model: string): Promise<any> => {
    return request('/meterless/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  },

  startRun: async (payload: RunCaseRequest): Promise<{ trace_id: string }> => {
    return request<{ trace_id: string }>('/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  runResult: async (traceId: string): Promise<RunCaseResponse> => {
    return request<RunCaseResponse>(`/run/${traceId}/result`);
  },

  runCase: async (payload: RunCaseRequest): Promise<RunCaseResponse> => {
    return request<RunCaseResponse>('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  counties: async (): Promise<{ source: 'zetaris' | 'sample'; counties: Array<{ county: string; coverage: 'supported' | 'limited'; dry_maize_quotes_14d: number }> }> => {
    return request('/counties');
  },

  trace: async (traceId: string): Promise<{ trace_id: string; events: TraceEvent[] }> => {
    return request<{ trace_id: string; events: TraceEvent[] }>(`/trace/${traceId}`);
  },

  subscribeTraceEvents: (
    traceId: string,
    onEvent: (event: TraceEvent) => void,
    onEnd: () => void
  ): (() => void) => {
    let source: EventSource | null = null;
    let closed = false;
    let sawEvent = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      source?.close();
      onEnd();
    };
    const open = (url: string, fallback: string | null) => {
      source = new EventSource(url);
      source.onmessage = (e) => {
        sawEvent = true;
        try {
          onEvent(JSON.parse(e.data) as TraceEvent);
        } catch {
          // Ignore a malformed event frame.
        }
      };
      source.addEventListener('end', finish);
      source.onerror = () => {
        source?.close();
        if (!closed && !sawEvent && fallback) open(fallback, null);
        else finish();
      };
    };
    open(`${BASE_URL}/run/${traceId}/events`, `http://localhost:8000/run/${traceId}/events`);
    return () => {
      closed = true;
      source?.close();
    };
  },
};
