import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../config.js";
import type { StorageRule } from "../tools/spoilage.js";

export interface KamisRow {
  market_date: string;
  county: string;
  market_name: string;
  commodity: string;
  variety: string;
  grade: string;
  unit_kg: number;
  wholesale_price_kes: number;
  retail_price_kes: number;
  volume_bags: number;
}

export interface WeatherSeries {
  county: string;
  as_of: string;
  source: string;
  synthetic: boolean;
  days: Array<{ date: string; rain_mm: number; humidity_pct: number; temp_c?: number; as_of?: string; source?: string }>;
}

export interface NewsItem {
  id: string;
  as_of: string;
  county: string;
  maize_type: string;
  status: "announced" | "gazetted";
  direction: "up" | "down" | "flat";
  headline: string;
  commodity: string;
}

export interface LedgerEntry {
  farmer_id: string;
  county: string;
  as_of: string;
  record_type: "prior_verdict" | "stock" | "sale";
  verdict?: "sell" | "hold" | "split" | "no_recommendation";
  hold_days?: number;
  bags?: number;
  storage?: string;
  forecast_rain_mm_7d?: number;
  notes?: string;
}

function sampleDir(): string {
  return path.join(projectRoot(), "data", "sample");
}

function readText(name: string): string {
  return fs.readFileSync(path.join(sampleDir(), name), "utf8");
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = headerLine.split(",").map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? "").trim();
    });
    return row;
  });
}

export function isWhiteMaizeBag(row: Pick<KamisRow, "commodity" | "variety" | "unit_kg">): boolean {
  return row.commodity.toLowerCase() === "dry maize" && row.variety.toLowerCase().includes("white") && row.unit_kg === 90;
}

export function loadPriceRows(): KamisRow[] {
  return parseCsv(readText("kamis_dry_maize.csv")).map((row) => ({
    market_date: row.market_date ?? "",
    county: row.county ?? "",
    market_name: row.market_name ?? "",
    commodity: row.commodity ?? "",
    variety: row.variety ?? "",
    grade: row.grade ?? "",
    unit_kg: Number(row.unit_kg),
    wholesale_price_kes: Number(row.wholesale_price_kes),
    retail_price_kes: Number(row.retail_price_kes),
    volume_bags: Number(row.volume_bags),
  })).filter((row) => row.market_date && row.county && Number.isFinite(row.wholesale_price_kes));
}

export function loadWeather(): WeatherSeries[] {
  const parsed = JSON.parse(readText("weather.json")) as { synthetic?: boolean; series?: WeatherSeries[] };
  if (parsed.synthetic !== true) {
    throw new Error("data/sample/weather.json must be marked synthetic");
  }
  return (parsed.series ?? []).map((series) => ({ ...series, synthetic: true }));
}

export function loadRules(): StorageRule[] {
  const rows = parseCsv(readText("storage_loss_rules.csv"));
  if (rows.length === 0) throw new Error("storage_loss_rules.csv has no rows");
  if (rows.some((row) => row.synthetic !== "true")) {
    throw new Error("data/sample/storage_loss_rules.csv must mark every row synthetic=true");
  }
  return rows.map((row) => ({
    storage: row.storage ?? "",
    rain_mm_min: Number(row.rain_mm_min),
    humidity_min: Number(row.humidity_min),
    daily_loss_pct: Number(row.daily_loss_pct),
  }));
}

export function loadNews(): NewsItem[] {
  const parsed = JSON.parse(readText("news.json")) as { synthetic?: boolean; items?: NewsItem[] };
  if (parsed.synthetic !== true) throw new Error("data/sample/news.json must be marked synthetic");
  return parsed.items ?? [];
}

export function loadLedger(): LedgerEntry[] {
  const parsed = JSON.parse(readText("farmer_ledger.json")) as { synthetic?: boolean; entries?: LedgerEntry[] };
  if (parsed.synthetic !== true) throw new Error("data/sample/farmer_ledger.json must be marked synthetic");
  return parsed.entries ?? [];
}

export function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mapKamisRow(raw: Record<string, unknown>): KamisRow | null {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) row[key.toLowerCase()] = value;
  const date = String(row.market_date ?? row.date ?? "");
  const price = finiteNumber(row.wholesale_price_kes ?? row.price ?? row.wholesale);
  const unit = finiteNumber(row.unit_kg);
  if (!date || date === "null" || price === undefined || unit === undefined) return null;
  return {
    market_date: date.slice(0, 10),
    county: String(row.county ?? ""),
    market_name: String(row.market_name ?? ""),
    commodity: String(row.commodity ?? "Dry Maize"),
    variety: String(row.variety ?? ""),
    grade: String(row.grade ?? ""),
    unit_kg: unit,
    wholesale_price_kes: price,
    retail_price_kes: finiteNumber(row.retail_price_kes) ?? price,
    volume_bags: finiteNumber(row.volume_bags) ?? 0,
  };
}
