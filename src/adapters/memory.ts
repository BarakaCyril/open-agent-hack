/**
 * MemoryPort backed by the H-MEM engine in src/hmem.
 * recall(farmerId) and remember(farmerId, record) stay stable for callers.
 * Each write is an audited H-MEM record (source, provenance, farmer scope).
 * Records for one farmer are kept together with chatId and a farmer tag.
 */

import path from "node:path";
import { projectRoot } from "../config.js";
import { HMEM, type HmemRecord } from "../hmem/index.js";

export interface MemoryRecord {
  farmerId: string;
  kind: string;
  content: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface NewMemoryRecord {
  kind: string;
  content: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface MemoryPort {
  recall(farmerId: string): Promise<MemoryRecord[]>;
  remember(farmerId: string, record: NewMemoryRecord): Promise<void>;
}

const PAYLOAD_MARK = "\n@@payload ";

function encodeContent(summary: string, kind: string, payload: Record<string, unknown>, createdAt: string): string {
  return `${summary}${PAYLOAD_MARK}${JSON.stringify({ kind, payload, createdAt })}`;
}

function decodeContent(record: HmemRecord, farmerId: string): MemoryRecord {
  const marker = record.content.lastIndexOf(PAYLOAD_MARK);
  const summary = marker >= 0 ? record.content.slice(0, marker) : record.content;
  let kind = record.tags.find((tag) => tag.startsWith("kind:"))?.slice("kind:".length) ?? "note";
  let payload: Record<string, unknown> = {};
  let createdAt = new Date(record.timestamp).toISOString();
  if (marker >= 0) {
    try {
      const parsed = JSON.parse(record.content.slice(marker + PAYLOAD_MARK.length)) as {
        kind?: string;
        payload?: Record<string, unknown>;
        createdAt?: string;
      };
      if (parsed.kind) kind = parsed.kind;
      if (parsed.payload && typeof parsed.payload === "object") payload = parsed.payload;
      if (parsed.createdAt) createdAt = parsed.createdAt;
    } catch {
      payload = {};
    }
  }
  return { farmerId, kind, content: summary, payload, createdAt };
}

export class HmemMemory implements MemoryPort {
  constructor(private readonly hmem: HMEM) {}

  async recall(farmerId: string): Promise<MemoryRecord[]> {
    this.hmem.query(`farmer ${farmerId} white maize profile verdict offer benchmark storage`, {
      chatId: farmerId,
      topN: 5,
      threshold: 0,
    });
    return this.hmem.store.all()
      .filter((record) => record.chatId === farmerId || record.tags.includes(`farmer:${farmerId}`))
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
      .map((record) => decodeContent(record, farmerId));
  }

  async remember(farmerId: string, record: NewMemoryRecord): Promise<void> {
    const createdAt = record.createdAt ?? new Date(this.hmem.clock()).toISOString();
    const confidence = typeof record.payload.confidence === "number" ? record.payload.confidence : 0.8;
    this.hmem.add({
      content: encodeContent(record.content, record.kind, record.payload, createdAt),
      type: record.kind === "profile" ? "personal" : "factual",
      layer: record.kind === "verdict" ? "long_term" : "working",
      tags: [`farmer:${farmerId}`, `kind:${record.kind}`, "maize", "project:open-agent-maize"],
      confidence,
      source: `farmer:${farmerId}`,
      provenance: {
        origin: "plan_completion",
        learnedAt: this.hmem.clock(),
        label: record.kind,
        refs: [farmerId],
      },
      chatId: farmerId,
      missionId: farmerId,
    });
  }
}

let singleton: MemoryPort | null = null;

export function getMemory(): MemoryPort {
  if (!singleton) {
    const dir = process.env.HMEM_PERSIST_DIR || path.join(projectRoot(), "data", "hmem");
    singleton = new HmemMemory(new HMEM({ persistDir: dir, actor: "open-agent-maize" }));
  }
  return singleton;
}

export function resetMemoryForTests(port?: MemoryPort): void {
  singleton = port ?? new HmemMemory(new HMEM({ actor: "test" }));
}
