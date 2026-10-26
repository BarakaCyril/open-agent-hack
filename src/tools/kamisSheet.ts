import zlib from "node:zlib";
import { z } from "zod";
import { isWhiteMaizeBag, type KamisRow } from "../adapters/sampleData.js";
import { normalizeCounty } from "./counties.js";

const BAG_KG = 90;

const MappedRow = z.object({
  market_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  county: z.string().min(1),
  market_name: z.string().min(1),
  commodity: z.string().min(1),
  variety: z.string().min(1),
  grade: z.string().min(1),
  unit_kg: z.literal(90),
  wholesale_price_kes: z.number().positive(),
  retail_price_kes: z.number().positive(),
  volume_bags: z.number().int().nonnegative(),
});

export function unzipStore(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if ((flags & 0x8) !== 0) throw new Error("The workbook uses a zip data descriptor");
    if (dataEnd > buffer.length) throw new Error("The workbook is truncated");
    const payload = buffer.subarray(dataStart, dataEnd);
    const body = method === 0 ? Buffer.from(payload) : method === 8 ? zlib.inflateRawSync(payload) : null;
    if (!body) throw new Error(`Unsupported zip method ${method}`);
    files.set(name, body);
    offset = dataEnd;
  }
  return files;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function sharedStrings(xml: string): string[] {
  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) ?? [];
  return items.map((item) => {
    const parts = [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1] ?? ""));
    return parts.join("");
  });
}

function columnIndex(letters: string): number {
  let value = 0;
  for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

export function worksheetRows(sheetXml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of sheetXml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const values: string[] = [];
    let cursor = 0;
    for (const cell of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? "";
      const inner = cell[2] ?? "";
      const letters = /r="([A-Z]+)\d+"/u.exec(attrs)?.[1] ?? "";
      const column = letters ? columnIndex(letters) : cursor;
      while (cursor < column) {
        values.push("");
        cursor += 1;
      }
      const type = /t="([^"]+)"/u.exec(attrs)?.[1] ?? "";
      if (type === "s") {
        values.push(strings[Number(/<v>([\s\S]*?)<\/v>/u.exec(inner)?.[1] ?? "")] ?? "");
      } else if (type === "inlineStr") {
        values.push([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1] ?? "")).join(""));
      } else {
        values.push(decodeXml(/<v>([\s\S]*?)<\/v>/u.exec(inner)?.[1] ?? ""));
      }
      cursor += 1;
    }
    rows.push(values);
  }
  return rows;
}

function perKg(value: string): number | null {
  const compact = value.trim().replace(/\s+/g, "");
  if (!compact || compact === "-") return null;
  const match = /^(-?\d+(?:\.\d+)?)\/kg$/iu.exec(compact);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function headerIndex(header: string[], name: string): number {
  return header.findIndex((cell) => cell.trim().toLowerCase() === name);
}

export interface KamisParseResult {
  rows: KamisRow[];
  rejected: number;
  fetched: number;
  reasons: Record<string, number>;
}

const ZOD_REASON: Record<string, string> = {
  market_date: "bad_market_date",
  county: "missing_county",
  market_name: "missing_market",
  commodity: "missing_commodity",
  variety: "missing_variety",
  grade: "missing_grade",
  unit_kg: "bad_unit",
  wholesale_price_kes: "blank_wholesale",
  retail_price_kes: "blank_retail",
  volume_bags: "bad_volume",
};

function addReason(reasons: Set<string>, reason: string): void {
  reasons.add(reason);
}

/**
 * The export button downloads this workbook. Prices are shown per kg and stored per 90 kg bag.
 * `whiteMaizeOnly` is the backfill keep-rule. The live refresh leaves that filter to the price tools.
 */
export function parseKamisWorkbook(buffer: Buffer, options?: { whiteMaizeOnly?: boolean }): KamisParseResult {
  const files = unzipStore(buffer);
  const sheet = files.get("xl/worksheets/sheet1.xml");
  const stringsXml = files.get("xl/sharedStrings.xml");
  if (!sheet || !stringsXml) throw new Error("The export is not an Excel workbook");
  const table = worksheetRows(sheet.toString("utf8"), sharedStrings(stringsXml.toString("utf8")));
  const header = table[0] ?? [];
  const columns = {
    commodity: headerIndex(header, "commodity"),
    classification: headerIndex(header, "classification"),
    grade: headerIndex(header, "grade"),
    market: headerIndex(header, "market"),
    wholesale: headerIndex(header, "wholesale"),
    retail: headerIndex(header, "retail"),
    supply: headerIndex(header, "supply volume"),
    county: headerIndex(header, "county"),
    date: headerIndex(header, "date"),
  };
  if (Object.entries(columns).some(([name, index]) => name !== "supply" && index < 0)) {
    throw new Error("The export is missing a required column");
  }
  const rows: KamisRow[] = [];
  const reasons: Record<string, number> = {};
  let rejected = 0;
  const fetched = table.slice(1).length;
  for (const cells of table.slice(1)) {
    const cell = (index: number) => (index < 0 ? "" : cells[index] ?? "").trim();
    const county = normalizeCounty(cell(columns.county));
    const market = cell(columns.market);
    const wholesale = perKg(cell(columns.wholesale));
    const retail = perKg(cell(columns.retail));
    const supplyText = cell(columns.supply);
    const supply = supplyText ? Number(supplyText) : 0;
    const commodity = cell(columns.commodity);
    const variety = cell(columns.classification);
    const fake = county.toLowerCase() === "test" || market.toLowerCase() === "test market";
    const candidate = {
      market_date: cell(columns.date).slice(0, 10),
      county,
      market_name: market,
      commodity,
      variety,
      grade: cell(columns.grade) || "-",
      unit_kg: BAG_KG as 90,
      wholesale_price_kes: wholesale === null ? Number.NaN : round2(wholesale * BAG_KG),
      retail_price_kes: retail === null ? Number.NaN : round2(retail * BAG_KG),
      volume_bags: Number.isFinite(supply) && supply >= 0 ? Math.round(supply) : Number.NaN,
    };
    const rowReasons = new Set<string>();
    if (fake) addReason(rowReasons, "test_row");
    if (options?.whiteMaizeOnly && !isWhiteMaizeBag({ commodity, variety, unit_kg: BAG_KG })) {
      addReason(rowReasons, "not_white_maize");
    }
    if (wholesale === null) addReason(rowReasons, "blank_wholesale");
    if (retail === null) addReason(rowReasons, "blank_retail");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate.market_date)) addReason(rowReasons, "bad_market_date");
    if (!county) addReason(rowReasons, "missing_county");
    if (!market) addReason(rowReasons, "missing_market");
    if (!commodity) addReason(rowReasons, "missing_commodity");
    if (!variety) addReason(rowReasons, "missing_variety");
    if (supplyText && !(Number.isFinite(supply) && supply >= 0)) addReason(rowReasons, "bad_volume");
    const parsed = MappedRow.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "row");
        addReason(rowReasons, ZOD_REASON[key] ?? key);
      }
    }
    if (fake || !parsed.success || rowReasons.has("not_white_maize")) {
      rejected += 1;
      for (const reason of rowReasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    rows.push(parsed.data);
  }
  return { rows, rejected, fetched, reasons };
}
