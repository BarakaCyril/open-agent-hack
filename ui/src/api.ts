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
  evidence: Array<{ source: string; as_of: string; freshness: string }>;
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Try via proxy /api first, and if that fails, try direct localhost:8000
  try {
    const res = await fetch(`${BASE_URL}${path}`, options);
    if (res.ok) return (await res.json()) as T;
  } catch {
    // Attempt direct port 8000 fallback
    const directRes = await fetch(`http://localhost:8000${path}`, options);
    if (!directRes.ok) {
      const err = await directRes.text();
      throw new Error(err || `HTTP ${directRes.status}`);
    }
    return (await directRes.json()) as T;
  }
  throw new Error(`Failed to fetch ${path}`);
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

  runCase: async (payload: RunCaseRequest): Promise<RunCaseResponse> => {
    return request<RunCaseResponse>('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  subscribeTraceEvents: (
    traceId: string,
    onEvent: (event: TraceEvent) => void,
    onEnd: () => void
  ): (() => void) => {
    let source: EventSource;
    try {
      source = new EventSource(`${BASE_URL}/run/${traceId}/events`);
    } catch {
      source = new EventSource(`http://localhost:8000/run/${traceId}/events`);
    }

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data);
      } catch {
        // ignore
      }
    };

    source.addEventListener('end', () => {
      onEnd();
      source.close();
    });

    source.onerror = () => {
      source.close();
      onEnd();
    };

    return () => source.close();
  },
};
