import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { clearReadCache } from "../adapters/zetaris.js";
import type { WeatherSeries } from "../adapters/sampleData.js";
import { traceEvent } from "../tracing.js";
import { lookupCounty } from "./counties.js";
import { upsertWeatherFile } from "./maizeFiles.js";
import { LIVE_USER_AGENT, OPEN_METEO_FORECAST, maizeDirectory, type RefreshReport } from "./refreshReport.js";

const DailySchema = z.object({
  time: z.array(z.string()),
  precipitation_sum: z.array(z.number().nullable()),
  temperature_2m_mean: z.array(z.number().nullable()),
  relative_humidity_2m_mean: z.array(z.number().nullable()).optional(),
}).passthrough();

const OpenMeteoSchema = z.object({
  daily: DailySchema,
  hourly: z.object({
    time: z.array(z.string()),
    relative_humidity_2m: z.array(z.number().nullable()),
  }).passthrough(),
}).passthrough();

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export interface WeatherRefreshOptions {
  fetch?: FetchLike;
  now?: () => Date;
  maizeDir?: string;
  cacheDir?: string;
  forecastDays?: number;
  retryCount?: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function humidityByDay(times: string[], values: Array<number | null>): Map<string, number> {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < times.length; index += 1) {
    const stamp = times[index];
    const value = values[index];
    if (!stamp || value === null || value === undefined || !Number.isFinite(value)) continue;
    const day = stamp.slice(0, 10);
    const list = buckets.get(day) ?? [];
    list.push(value);
    buckets.set(day, list);
  }
  const means = new Map<string, number>();
  for (const [day, samples] of buckets) {
    if (samples.length === 0) continue;
    means.set(day, round1(samples.reduce((sum, sample) => sum + sample, 0) / samples.length));
  }
  return means;
}

/**
 * Daily Open-Meteo fields used here are precipitation_sum and temperature_2m_mean.
 * The forecast docs have no daily humidity field, so humidity is the mean of hourly relative_humidity_2m.
 * A daily relative_humidity_2m_mean is used only when the response actually contains it.
 */
export function parseOpenMeteoForecast(body: unknown, county: string, asOf: string): { series: WeatherSeries | null; rejected: number } {
  const parsed = OpenMeteoSchema.parse(body);
  const derived = humidityByDay(parsed.hourly.time, parsed.hourly.relative_humidity_2m);
  const dailyHumidity = parsed.daily.relative_humidity_2m_mean;
  let rejected = 0;
  const days: WeatherSeries["days"] = [];
  for (let index = 0; index < parsed.daily.time.length; index += 1) {
    const date = parsed.daily.time[index]?.slice(0, 10) ?? "";
    const rain = parsed.daily.precipitation_sum[index];
    const temp = parsed.daily.temperature_2m_mean[index];
    const published = dailyHumidity?.[index];
    const humidity = published === null || published === undefined ? derived.get(date) : published;
    if (!date || rain === null || rain === undefined || temp === null || temp === undefined || humidity === undefined || !Number.isFinite(humidity)) {
      rejected += 1;
      continue;
    }
    days.push({
      date,
      rain_mm: rain,
      humidity_pct: humidity,
      temp_c: temp,
      as_of: asOf,
      source: "open-meteo",
    });
  }
  if (days.length === 0) return { series: null, rejected };
  return {
    series: { county, as_of: asOf, source: "open-meteo", synthetic: false, days },
    rejected,
  };
}

function cacheBody(cacheDir: string | undefined, county: string, body: string): void {
  if (!cacheDir) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${county.replace(/[^\p{L}\p{N}]+/gu, "_")}.json`), body);
}

function traceRefresh(report: RefreshReport, county: string, retryCount: number): void {
  traceEvent({
    action: "refresh_weather",
    input_summary: `Open-Meteo daily forecast for ${county}.`,
    output_summary: `rows fetched ${report.fetched}, rows stored ${report.stored}, rejected ${report.rejected}, status ${report.status}. ${report.detail}`,
    target_agent: "StorageWeatherAnalyst",
    confidence: null,
    retry_count: retryCount,
    status: report.status === "success" ? "success" : report.status === "fallback" ? "fallback" : "error",
  });
}

export async function refreshWeather(county: string, options: WeatherRefreshOptions = {}): Promise<RefreshReport> {
  const retryCount = options.retryCount ?? 0;
  const place = lookupCounty(county);
  if (!place) {
    const report: RefreshReport = {
      status: "error",
      fetched: 0,
      stored: 0,
      rejected: 0,
      detail: `No coordinates for ${county} in data/counties.csv.`,
    };
    traceRefresh(report, county, retryCount);
    return report;
  }
  const days = options.forecastDays ?? 7;
  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("daily", "precipitation_sum,temperature_2m_mean");
  url.searchParams.set("hourly", "relative_humidity_2m");
  url.searchParams.set("timezone", "Africa/Nairobi");
  url.searchParams.set("forecast_days", String(days));
  const fetchImpl = options.fetch ?? fetch;
  const asOf = (options.now ?? (() => new Date()))().toISOString().slice(0, 10);
  let bodyText = "";
  try {
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": LIVE_USER_AGENT },
    });
    bodyText = await response.text();
    if (!response.ok) {
      const report: RefreshReport = {
        status: "error",
        fetched: 0,
        stored: 0,
        rejected: 0,
        detail: `Open-Meteo HTTP ${response.status}.`,
      };
      traceRefresh(report, county, retryCount);
      return report;
    }
  } catch {
    const report: RefreshReport = {
      status: "error",
      fetched: 0,
      stored: 0,
      rejected: 0,
      detail: "Open-Meteo request failed.",
    };
    traceRefresh(report, county, retryCount);
    return report;
  }
  cacheBody(options.cacheDir ?? path.join(process.cwd(), "data", "cache", "open-meteo"), county, bodyText);
  let parsed: { series: WeatherSeries | null; rejected: number };
  try {
    parsed = parseOpenMeteoForecast(JSON.parse(bodyText) as unknown, place.county, asOf);
  } catch {
    const report: RefreshReport = {
      status: "error",
      fetched: 0,
      stored: 0,
      rejected: 0,
      detail: "Open-Meteo response did not match the forecast schema.",
    };
    traceRefresh(report, county, retryCount);
    return report;
  }
  if (!parsed.series) {
    const report: RefreshReport = {
      status: "error",
      fetched: 0,
      stored: 0,
      rejected: parsed.rejected,
      detail: "Open-Meteo returned no complete forecast days.",
    };
    traceRefresh(report, county, retryCount);
    return report;
  }
  const directory = maizeDirectory(options.maizeDir);
  try {
    const stored = upsertWeatherFile(parsed.series, directory);
    clearReadCache();
    const report: RefreshReport = {
      status: "success",
      fetched: parsed.series.days.length,
      stored,
      rejected: parsed.rejected,
      detail: `Wrote ${place.county} forecast issued ${asOf} from coordinates in data/counties.csv.`,
    };
    traceRefresh(report, county, retryCount);
    return report;
  } catch (error) {
    const report: RefreshReport = {
      status: "fallback",
      fetched: parsed.series.days.length,
      stored: 0,
      rejected: parsed.rejected,
      detail: error instanceof Error ? error.message : "The forecast was not written.",
    };
    traceRefresh(report, county, retryCount);
    return report;
  }
}
