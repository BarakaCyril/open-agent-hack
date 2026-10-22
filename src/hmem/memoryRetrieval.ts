import { cosine, embed, jaccard, tokenize } from "./embeddings.js";
import { snapshot, type MemoryStoreService } from "./memoryStore.js";
import type { TrustLedgerService } from "./trustLedger.js";
import { DAY_MS, DEFAULTS, FEEDBACK_DELTAS, clamp01, type FeedbackKind, type MemoryRecord, type QueryResult, type RetrievedMemory } from "./types.js";

const LAYER_WEIGHT: Record<MemoryRecord["layer"], number> = {
  long_term: 1,
  working: 0.8,
  short_term: 0.6,
};

export class MemoryRetrievalService {
  constructor(
    private store: MemoryStoreService,
    private ledger: TrustLedgerService,
    private clock: () => number,
    private actor: string,
  ) {}

  query(query: string, opts?: { topN?: number; threshold?: number; chatId?: string }): QueryResult {
    const queryEmbedding = embed(query);
    const queryTokens = tokenize(query).slice(0, 8);
    const queryEntities = this.store.extractEntities(query);
    const queryDomain = this.store.classifyDomain(query, [], "general");
    const threshold = opts?.threshold ?? DEFAULTS.retrievalThreshold;
    const topN = opts?.topN ?? DEFAULTS.retrievalTopN;
    const scored: RetrievedMemory[] = [];
    for (const memory of this.store.all()) {
      if (opts?.chatId && memory.chatId && memory.chatId !== opts.chatId) continue;
      const relevance = this.score(memory, queryEmbedding, queryTokens, queryEntities, queryDomain);
      if (relevance >= threshold) scored.push({ memory, relevance });
    }
    scored.sort((a, b) => b.relevance - a.relevance || a.memory.id.localeCompare(b.memory.id));
    const top = scored.slice(0, topN);
    for (const item of top) {
      this.store.touch(item.memory.id);
      this.ledger.log(item.memory.id, "read", this.actor, { details: { query } });
    }
    const strategy = top.length <= 1
      ? "minimal"
      : top.some((item) => item.memory.type === "personal" || item.memory.type === "preference")
        ? "personal"
        : "comprehensive";
    return {
      memories: top,
      context: this.formatReinjection(top),
      trace: {
        retrievalReason: `hybrid ranking for "${query}" (domain: ${queryDomain})`,
        strategy,
        scores: Object.fromEntries(top.map((item) => [item.memory.id, Number(item.relevance.toFixed(4))])),
      },
    };
  }

  feedback(memoryId: string, kind: FeedbackKind): void {
    const memory = this.store.get(memoryId);
    if (!memory) throw new Error(`H-MEM: unknown memory id ${memoryId}`);
    const previous = snapshot(memory);
    if (kind === "helpful") memory.accessCount += 1;
    memory.confidence = clamp01(memory.confidence + FEEDBACK_DELTAS[kind]);
    if (kind === "wrong" && !memory.tags.includes("review")) memory.tags.push("review");
    this.ledger.log(memoryId, "feedback", this.actor, {
      previousState: previous,
      newState: snapshot(memory),
      details: { kind, delta: FEEDBACK_DELTAS[kind] },
    });
    this.store.persist();
  }

  private score(
    memory: MemoryRecord,
    queryEmbedding: number[],
    queryTokens: string[],
    queryEntities: string[],
    queryDomain: string,
  ): number {
    const semantic = clamp01(cosine(queryEmbedding, memory.embedding));
    const keyword = jaccard(queryTokens, tokenize(memory.content));
    const tag = jaccard(queryTokens, memory.tags.map((item) => item.toLowerCase()));
    const domain = memory.domain === queryDomain ? 1 : 0;
    const entity = jaccard(queryEntities, memory.entities);
    const layer = LAYER_WEIGHT[memory.layer];
    const ageDays = (this.clock() - memory.lastAccessed) / DAY_MS;
    const recency = Math.exp(-ageDays / DEFAULTS.recencyDays);
    const superseded = memory.supersededBy ? 1 : 0;
    const raw = 0.35 * semantic + 0.2 * keyword + 0.1 * tag + 0.1 * domain
      + 0.15 * entity + 0.05 * layer + 0.05 * recency - 0.2 * superseded;
    return clamp01(raw) * memory.confidence;
  }

  private formatReinjection(items: RetrievedMemory[]): string {
    if (items.length === 0) return "";
    const byDomain = new Map<string, RetrievedMemory[]>();
    for (const item of items) {
      const list = byDomain.get(item.memory.domain) ?? [];
      list.push(item);
      byDomain.set(item.memory.domain, list);
    }
    const lines = ["[MEMORY CONTEXT]"];
    for (const [domain, list] of [...byDomain.entries()].sort()) {
      lines.push(`## ${domain}`);
      for (const { memory } of list) {
        const marker = memory.layer === "long_term" ? "LT" : memory.layer === "working" ? "WK" : "ST";
        const entities = memory.entities.length ? ` (entities: ${memory.entities.join(", ")})` : "";
        lines.push(`- [${marker}] ${memory.content}${entities} <${memory.id}>`);
      }
    }
    lines.push("[/MEMORY CONTEXT]");
    return lines.join("\n");
  }
}
