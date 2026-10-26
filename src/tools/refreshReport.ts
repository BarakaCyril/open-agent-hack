export interface RefreshReport {
  status: "success" | "fallback" | "error" | "skipped";
  fetched: number;
  stored: number;
  rejected: number;
  detail: string;
  /** The price store could not be written. */
  unavailable?: boolean;
}

export interface FetchLike {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
}

export const LIVE_USER_AGENT = "open-agent-maize/0.1 (maize decision support)";
export const KAMIS_EXPORT_ORIGIN = "https://kamis.kilimo.go.ke";
export const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
export const DEFAULT_MAIZE_DIR = "/home/zetaris/customer-data/shared/maize";
export const REQUEST_GAP_MS = 2_000;

export function maizeDirectory(override?: string): string {
  const configured = override?.trim() || process.env.ZETARIS_MAIZE_DIR?.trim();
  return configured || DEFAULT_MAIZE_DIR;
}

export function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return fallback;
  return parsed;
}
