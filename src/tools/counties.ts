import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../config.js";

export interface CountyCoordinate {
  county: string;
  latitude: number;
  longitude: number;
  source: string;
  sourceUrl: string;
}

export function normalizeCounty(name: string): string {
  return name.trim().replace(/-/g, " ").replace(/\s+/g, " ");
}

function parseCsv(text: string): Record<string, string>[] {
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

export function loadCountyCatalog(file = path.join(projectRoot(), "data", "counties.csv")): CountyCoordinate[] {
  const records = parseCsv(fs.readFileSync(file, "utf8"));
  const counties: CountyCoordinate[] = [];
  for (const record of records) {
    const latitude = Number(record.latitude);
    const longitude = Number(record.longitude);
    const county = normalizeCounty(record.county ?? "");
    if (!county || !record.source || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    counties.push({
      county,
      latitude,
      longitude,
      source: record.source,
      sourceUrl: record.source_url ?? "",
    });
  }
  return counties;
}

/** Coordinates come only from data/counties.csv. A missing county is not guessed. */
export function lookupCounty(name: string, catalog = loadCountyCatalog()): CountyCoordinate | null {
  const wanted = normalizeCounty(name).toLowerCase();
  return catalog.find((entry) => entry.county.toLowerCase() === wanted) ?? null;
}
