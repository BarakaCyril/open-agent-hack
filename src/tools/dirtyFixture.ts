import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../config.js";
import type { KamisRow, NewsItem } from "../adapters/sampleData.js";

export const DIRTY_FIXTURE_SOURCE = "fixture:data/fixtures/dirty_market.json";

export interface DirtyFixture {
  prices: KamisRow[];
  news: NewsItem[];
}

/** Planted outlier prices and a non-white news item. Not a market extract. */
export function loadDirtyFixture(file = path.join(projectRoot(), "data", "fixtures", "dirty_market.json")): DirtyFixture {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    prices?: Array<KamisRow & { planted_outlier?: boolean }>;
    news?: NewsItem[];
  };
  const prices = (parsed.prices ?? []).filter((row) => row.planted_outlier === true).map((row) => ({
    market_date: row.market_date,
    county: row.county,
    market_name: row.market_name,
    commodity: row.commodity,
    variety: row.variety,
    grade: row.grade,
    unit_kg: row.unit_kg,
    wholesale_price_kes: row.wholesale_price_kes,
    retail_price_kes: row.retail_price_kes,
    volume_bags: row.volume_bags,
  }));
  return { prices, news: parsed.news ?? [] };
}
