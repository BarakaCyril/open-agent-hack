import type { WeatherSeries } from "../adapters/sampleData.js";

export interface ForecastPoint {
  date: string;
  rain_mm: number;
  humidity_pct: number;
  temp_c?: number;
  as_of: string;
  source: string;
}

function syntheticSource(source: string): boolean {
  return source.toLowerCase().includes("synthetic");
}

/** Keep one forecast issue. The newest as_of wins, and days from other issues stay out of the claim. */
export function chooseLatestSeries(county: string, points: ForecastPoint[]): WeatherSeries | null {
  const groups = new Map<string, ForecastPoint[]>();
  for (const point of points) {
    if (!point.as_of || !point.source || !point.date) continue;
    const key = `${point.as_of}\n${point.source}`;
    const list = groups.get(key) ?? [];
    list.push(point);
    groups.set(key, list);
  }
  let best: ForecastPoint[] | null = null;
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    if (!best || !best[0]) {
      best = group;
      continue;
    }
    const current = best[0];
    if (first.as_of > current.as_of) best = group;
    else if (first.as_of === current.as_of && first.source === "open-meteo" && current.source !== "open-meteo") best = group;
  }
  const chosen = best?.[0];
  if (!best || !chosen) return null;
  const seen = new Set<string>();
  const days = best.flatMap((point) => {
    if (seen.has(point.date)) return [];
    seen.add(point.date);
    return [{
      date: point.date,
      rain_mm: point.rain_mm,
      humidity_pct: point.humidity_pct,
      ...(point.temp_c === undefined ? {} : { temp_c: point.temp_c }),
      as_of: point.as_of,
      source: point.source,
    }];
  }).sort((left, right) => left.date.localeCompare(right.date));
  return {
    county,
    as_of: chosen.as_of,
    source: chosen.source,
    synthetic: syntheticSource(chosen.source),
    days,
  };
}
