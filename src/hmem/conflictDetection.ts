import { cosine } from "./embeddings.js";
import { snapshot, type MemoryStoreService } from "./memoryStore.js";
import type { TrustLedgerService } from "./trustLedger.js";
import { DEFAULTS, clamp01, type ConflictRecord, type MemoryRecord } from "./types.js";

const OPPOSING_PAIRS: [RegExp, RegExp][] = [
  [/\balways\b/i, /\bnever\b/i],
  [/\benable[ds]?\b/i, /\bdisable[ds]?\b/i],
  [/\bprefer[s]?\b/i, /\bavoid[s]?|dislike[s]?\b/i],
  [/\bon\b/i, /\boff\b/i],
  [/\byes\b/i, /\bno\b/i],
];

export class ConflictDetectionService {
  private conflicts: ConflictRecord[] = [];
  private seq = 0;

  constructor(
    private store: MemoryStoreService,
    private ledger: TrustLedgerService,
    private clock: () => number,
    private actor: string,
  ) {}

  scan(): ConflictRecord[] {
    const found: ConflictRecord[] = [];
    const all = this.store.all();
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const left = all[i];
        const right = all[j];
        if (!left || !right) continue;
        const conflict = this.check(left, right);
        if (!conflict) continue;
        found.push(conflict);
        this.conflicts.push(conflict);
        this.ledger.log(conflict.memoryA, "conflict_detected", this.actor, {
          details: { with: conflict.memoryB, reason: conflict.reason, confidence: conflict.confidence },
        });
      }
    }
    return found;
  }

  autoResolve(conflict: ConflictRecord): "resolved" | "queued" {
    const left = this.store.get(conflict.memoryA);
    const right = this.store.get(conflict.memoryB);
    if (!left || !right) throw new Error(`H-MEM: conflict ${conflict.id} refers to a missing memory`);
    const scoreOf = (memory: MemoryRecord) => 0.3 * (memory.lastAccessed / Math.max(1, this.clock()))
      + 0.2 * Math.min(1, memory.accessCount / 10)
      + 0.25 * memory.confidence
      + 0.1 * Math.min(1, memory.content.length / 200)
      + 0.15 * (memory.provenance.origin === "user_correction" ? 1 : 0.5);
    const leftScore = scoreOf(left);
    const rightScore = scoreOf(right);
    const margin = Math.abs(leftScore - rightScore) / Math.max(leftScore, rightScore);
    const decisionConfidence = clamp01(conflict.confidence * 0.6 + margin * 0.8);
    if (decisionConfidence < DEFAULTS.conflictAutoResolveGate) return "queued";
    const winner = leftScore >= rightScore ? left : right;
    const loser = leftScore >= rightScore ? right : left;
    const previous = snapshot(loser);
    loser.supersededBy = winner.id;
    conflict.resolved = true;
    conflict.resolution = winner.id === conflict.memoryA ? "keep_a" : "keep_b";
    this.ledger.log(loser.id, "conflict_resolved", this.actor, {
      previousState: previous,
      newState: snapshot(loser),
      details: { conflictId: conflict.id, winner: winner.id, decisionConfidence: Number(decisionConfidence.toFixed(3)) },
    });
    this.store.persist();
    return "resolved";
  }

  queue(): ConflictRecord[] {
    return this.conflicts.filter((conflict) => !conflict.resolved);
  }

  private check(left: MemoryRecord, right: MemoryRecord): ConflictRecord | undefined {
    if (left.supersedes === right.id || right.supersedes === left.id || left.supersededBy === right.id || right.supersededBy === left.id) {
      return undefined;
    }
    const similarity = cosine(left.embedding, right.embedding);
    let reason = "";
    let confidence = 0;
    for (const [first, second] of OPPOSING_PAIRS) {
      const opposed = (first.test(left.content) && second.test(right.content)) || (second.test(left.content) && first.test(right.content));
      if (opposed && similarity > 0.5) {
        reason = "opposing phrase pair on similar content";
        confidence = 0.5 + 0.3 * similarity;
      }
    }
    if (!reason && similarity > 0.8) {
      const leftNumbers = left.content.match(/\d+(\.\d+)?/g) ?? [];
      const rightNumbers = right.content.match(/\d+(\.\d+)?/g) ?? [];
      if (leftNumbers.length && rightNumbers.length && leftNumbers.join() !== rightNumbers.join()) {
        reason = "high-similarity conflicting numeric values";
        confidence = 0.55 + 0.25 * similarity;
      }
    }
    if (!reason) return undefined;
    const shared = left.entities.filter((entity) => right.entities.includes(entity));
    if (shared.length > 0) confidence += 0.1;
    if (left.domain === right.domain) confidence += 0.05;
    if (left.relatedTo.includes(right.id)) confidence -= 0.1;
    return {
      id: `conflict-${++this.seq}`,
      memoryA: left.id,
      memoryB: right.id,
      reason,
      confidence: clamp01(confidence),
      resolved: false,
    };
  }
}
