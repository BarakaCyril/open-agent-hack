import fs from "node:fs";
import path from "node:path";
import { cosine, embed, tokenize } from "./embeddings.js";
import { DEFAULTS, clamp01, type MemoryLayer, type MemoryRecord, type MemoryType, type Provenance } from "./types.js";
import type { TrustLedgerService } from "./trustLedger.js";

const TECH_TERMS = [
  "react", "python", "typescript", "javascript", "rust", "sqlite", "postgres", "indexeddb",
  "node", "docker", "graphql", "redis", "webrtc", "tauri", "electron", "llm", "embedding",
];

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  tech: ["code", "bug", "api", "database", "deploy", "framework", "library", "server", ...TECH_TERMS],
  work: ["meeting", "deadline", "client", "project", "sprint", "review", "report"],
  personal: ["family", "hobby", "prefer", "like", "dislike", "morning", "evening"],
};

export interface AddInput {
  content: string;
  type?: MemoryType;
  layer?: MemoryLayer;
  tags?: string[];
  confidence?: number;
  source: string;
  provenance?: Provenance;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  supersedes?: string;
  derivedFrom?: string[];
}

export function snapshot(record: MemoryRecord): Partial<MemoryRecord> {
  const { embedding: _embedding, ...rest } = structuredClone(record);
  return rest;
}

export class MemoryStoreService {
  private records = new Map<string, MemoryRecord>();
  private seq = 0;
  private stateFile?: string;

  constructor(
    private clock: () => number,
    private ledger: TrustLedgerService,
    private actor: string,
    persistDir?: string,
  ) {
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true });
      this.stateFile = path.join(persistDir, "state.json");
      if (fs.existsSync(this.stateFile)) {
        const saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as { seq: number; records: MemoryRecord[] };
        this.seq = saved.seq;
        for (const record of saved.records) this.records.set(record.id, record);
      }
    }
  }

  persist(): void {
    if (!this.stateFile) return;
    const records = [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
    fs.writeFileSync(this.stateFile, `${JSON.stringify({ seq: this.seq, records }, null, 2)}\n`, "utf8");
  }

  add(input: AddInput): MemoryRecord {
    if (!input.source || input.source.trim() === "") {
      throw new Error("H-MEM: a memory record with no source must be rejected by construction (AGENTS.md section 2)");
    }
    const now = this.clock();
    const id = `mem-${++this.seq}`;
    const tags = [...(input.tags ?? [])];
    const type = input.type ?? "general";
    const domain = this.classifyDomain(input.content, tags, type);
    const record: MemoryRecord = {
      id,
      content: input.content,
      type,
      layer: input.layer ?? "working",
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      tags,
      embedding: embed(input.content),
      confidence: clamp01(input.confidence ?? 0.7),
      source: input.source,
      provenance: input.provenance ?? { origin: "manual", learnedAt: now, label: input.source },
      chatId: input.chatId,
      missionId: input.missionId,
      goalRunId: input.goalRunId,
      domain,
      namespace: this.namespace(domain, type),
      entities: this.extractEntities(input.content),
      relatedTo: [],
      supersedes: input.supersedes,
      derivedFrom: input.derivedFrom,
    };
    this.discoverRelationships(record);
    this.records.set(id, record);
    this.ledger.log(id, "create", this.actor, { newState: snapshot(record) });
    this.persist();
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  update(id: string, patch: Partial<MemoryRecord>): MemoryRecord {
    const record = this.mustGet(id);
    const previous = snapshot(record);
    Object.assign(record, patch);
    this.ledger.log(id, "update", this.actor, { previousState: previous, newState: snapshot(record) });
    this.persist();
    return record;
  }

  delete(id: string, reason: string): void {
    const record = this.mustGet(id);
    this.records.delete(id);
    this.ledger.log(id, "delete", this.actor, { previousState: snapshot(record), details: { reason } });
    this.persist();
  }

  touch(id: string): void {
    const record = this.mustGet(id);
    record.lastAccessed = this.clock();
    record.accessCount += 1;
  }

  promote(id: string, layer: MemoryLayer): void {
    const record = this.mustGet(id);
    const previous = snapshot(record);
    record.layer = layer;
    this.ledger.log(id, "promote", this.actor, { previousState: previous, newState: snapshot(record) });
    this.persist();
  }

  restoreAll(records: MemoryRecord[], seq: number): void {
    this.records = new Map(records.map((record) => [record.id, structuredClone(record)]));
    this.seq = seq;
    this.persist();
  }

  snapshotAll(): { records: MemoryRecord[]; seq: number } {
    return { records: structuredClone([...this.records.values()]), seq: this.seq };
  }

  classifyDomain(content: string, tags: string[], type: MemoryType): string {
    for (const tag of tags) {
      if (tag.startsWith("project:")) return tag.slice("project:".length);
      if (tag.startsWith("tech:")) return "tech";
    }
    const tokens = new Set(tokenize(content));
    let best = "general";
    let bestScore = 0;
    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = keywords.reduce((sum, keyword) => sum + (tokens.has(keyword) ? 1 : 0), 0);
      if (domain === "personal" && (type === "personal" || type === "preference")) score += 1;
      if (score > bestScore) {
        best = domain;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : "general";
  }

  extractEntities(content: string): string[] {
    const entities = new Set<string>();
    for (const token of tokenize(content)) if (TECH_TERMS.includes(token)) entities.add(token);
    for (const match of content.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)) {
      const normalized = match[1]?.toLowerCase() ?? "";
      if (normalized && !["the", "this", "that", "with"].includes(normalized)) entities.add(normalized);
    }
    return [...entities].slice(0, DEFAULTS.entityCap);
  }

  private namespace(domain: string, type: MemoryType): string {
    const bucket = type === "preference" || type === "personal" ? "profile" : type === "factual" ? "facts" : "notes";
    return `${domain}/${bucket}`;
  }

  private mustGet(id: string): MemoryRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`H-MEM: unknown memory id ${id}`);
    return record;
  }

  private discoverRelationships(record: MemoryRecord): void {
    const correction = /\b(actually|instead|no longer|not anymore|changed to|correction)\b/i;
    for (const other of this.records.values()) {
      if (record.relatedTo.length >= DEFAULTS.relatedCap) break;
      const shared = other.entities.filter((entity) => record.entities.includes(entity));
      const similarity = cosine(record.embedding, other.embedding);
      if (!record.supersedes && similarity > 0.85 && correction.test(record.content)) {
        record.supersedes = other.id;
        continue;
      }
      if (shared.length >= 1 && other.domain === record.domain) {
        record.relatedTo.push(other.id);
        if (other.relatedTo.length < DEFAULTS.relatedCap && !other.relatedTo.includes(record.id)) {
          other.relatedTo.push(record.id);
        }
      }
    }
  }
}
