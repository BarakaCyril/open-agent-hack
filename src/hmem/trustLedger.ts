import fs from "node:fs";
import path from "node:path";
import type { LedgerAction, LedgerEntry, MemoryRecord } from "./types.js";

export class TrustLedgerService {
  private entries: LedgerEntry[] = [];
  private file?: string;

  constructor(private clock: () => number, persistDir?: string) {
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true });
      this.file = path.join(persistDir, "ledger.jsonl");
      if (fs.existsSync(this.file)) {
        this.entries = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
      }
    }
  }

  log(
    memoryId: string,
    action: LedgerAction,
    actor: string,
    extra?: { previousState?: Partial<MemoryRecord>; newState?: Partial<MemoryRecord>; details?: Record<string, unknown> },
  ): LedgerEntry {
    const entry: LedgerEntry = { memoryId, action, actor, timestamp: this.clock(), ...extra };
    this.entries.push(entry);
    if (this.file) fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  history(memoryId: string): LedgerEntry[] {
    return this.entries.filter((entry) => entry.memoryId === memoryId);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  stats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) counts[entry.action] = (counts[entry.action] ?? 0) + 1;
    return counts;
  }
}
