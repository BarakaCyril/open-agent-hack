import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../config.js";
import { mapKamisRow, type KamisRow, type WeatherSeries } from "../adapters/sampleData.js";
import { normalizeCounty } from "./counties.js";

const PRICE_HEADER = [
  "market_date",
  "county",
  "market_name",
  "commodity",
  "variety",
  "grade",
  "unit_kg",
  "wholesale_price_kes",
  "retail_price_kes",
  "volume_bags",
] as const;

export function parseCsvQuoted(text: string): Record<string, string>[] {
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else quoted = false;
      } else cell += char ?? "";
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.length > 0)) table.push(row);
      row = [];
      continue;
    }
    cell += char ?? "";
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) table.push(row);
  }
  const header = table[0]?.map((name) => name.trim());
  if (!header) return [];
  return table.slice(1).map((values) => {
    const record: Record<string, string> = {};
    header.forEach((name, column) => {
      record[name] = (values[column] ?? "").trim();
    });
    return record;
  });
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/u.test(text)) return `"${text.replaceAll("\"", "\"\"")}"`;
  return text;
}

export function priceKey(row: KamisRow): string {
  return [
    row.market_date,
    normalizeCounty(row.county).toLowerCase(),
    row.market_name.trim().toLowerCase(),
    row.commodity.trim().toLowerCase(),
    row.variety.trim().toLowerCase(),
    row.grade.trim().toLowerCase(),
    String(row.unit_kg),
  ].join("|");
}

function readPrices(file: string): KamisRow[] {
  if (!fs.existsSync(file)) return [];
  return parseCsvQuoted(fs.readFileSync(file, "utf8"))
    .map((row) => mapKamisRow(row))
    .filter((row): row is KamisRow => row !== null)
    .map((row) => ({ ...row, county: normalizeCounty(row.county) }));
}

function samplePrices(): KamisRow[] {
  return readPrices(path.join(projectRoot(), "data", "sample", "kamis_dry_maize.csv"));
}

function sampleWeather(): WeatherSeries[] {
  const file = path.join(projectRoot(), "data", "sample", "weather.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { series?: WeatherSeries[] };
  return parsed.series ?? [];
}

/**
 * Merge into the Lightning filestore CSV. The schema-store view maize.kamis_prices
 * reads this file; there is no INSERT into the view.
 */
export function upsertPriceFile(incoming: KamisRow[], directory: string): number {
  const destination = path.join(directory, "kamis_dry_maize.csv");
  if (!fs.existsSync(directory)) {
    throw new Error(`Zetaris maize directory is not available: ${directory}`);
  }
  const existing = fs.existsSync(destination) ? readPrices(destination) : samplePrices();
  const byKey = new Map(existing.map((row) => [priceKey(row), row]));
  let stored = 0;
  for (const row of incoming) {
    const normalized = { ...row, county: normalizeCounty(row.county) };
    byKey.set(priceKey(normalized), normalized);
    stored += 1;
  }
  const lines = [PRICE_HEADER.join(",")];
  for (const row of byKey.values()) {
    lines.push(PRICE_HEADER.map((column) => csvCell(row[column])).join(","));
  }
  fs.writeFileSync(destination, `${lines.join("\n")}\n`);
  return stored;
}

function readWeather(file: string): WeatherSeries[] | null {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { series?: unknown };
    if (!Array.isArray(parsed.series)) return null;
    return parsed.series as WeatherSeries[];
  } catch {
    return null;
  }
}

/**
 * Merge into the Lightning filestore JSON. maize.weather_daily explodes series and days.
 * A new open-meteo issue replaces that county's synthetic series and the same as_of.
 * Older open-meteo issues stay in the file.
 */
export function upsertWeatherFile(incoming: WeatherSeries, directory: string): number {
  const destination = path.join(directory, "weather.json");
  if (!fs.existsSync(directory)) {
    throw new Error(`Zetaris maize directory is not available: ${directory}`);
  }
  const existing = fs.existsSync(destination) ? readWeather(destination) : sampleWeather();
  if (!existing) throw new Error("weather.json is not a series file and was left unchanged");
  const county = normalizeCounty(incoming.county).toLowerCase();
  const kept = existing.filter((series) => {
    const sameCounty = normalizeCounty(series.county).toLowerCase() === county;
    if (!sameCounty) return true;
    if (incoming.source === "open-meteo" && series.source !== "open-meteo") return false;
    return !(series.as_of === incoming.as_of && series.source === incoming.source);
  });
  const series = [...kept, { ...incoming, county: normalizeCounty(incoming.county) }];
  const synthetic = series.every((item) => item.source.toLowerCase().includes("synthetic"));
  fs.writeFileSync(destination, `${JSON.stringify({ synthetic, series }, null, 2)}\n`);
  return incoming.days.length;
}
