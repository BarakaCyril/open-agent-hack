import { cosine } from "./embeddings.js";
import type { MemoryStoreService } from "./memoryStore.js";
import type { TrustLedgerService } from "./trustLedger.js";
import { DAY_MS, DEFAULTS, type MemoryRecord, type SleepPreview, type SleepReport } from "./types.js";

const HUB_THRESHOLD = 3;

export class SleepCycleService {
  private backups = new Map<string, { records: MemoryRecord[]; seq: number }>();
  private backupSeq = 0;

  constructor(
    private store: MemoryStoreService,
    private ledger: TrustLedgerService,
    private clock: () => number,
    private actor: string,
  ) {}

  preview(): SleepPreview {
    const now = this.clock();
    const all = this.store.all();
    const referenced = new Set<string>();
    for (const memory of all) {
      for (const related of memory.relatedTo) referenced.add(related);
      if (memory.supersedes) referenced.add(memory.supersedes);
      for (const derived of memory.derivedFrom ?? []) referenced.add(derived);
    }
    const toConsolidate = all
      .filter((memory) => memory.layer === "short_term" && now - memory.lastAccessed >= DEFAULTS.consolidationDays * DAY_MS)
      .map((memory) => memory.id);
    const toArchive = all.filter((memory) => {
      const oldEnough = now - memory.timestamp >= DEFAULTS.archiveMinDays * DAY_MS;
      const lowAccess = memory.accessCount <= DEFAULTS.archiveMaxAccess;
      const unreferenced = !referenced.has(memory.id);
      if (!(oldEnough && lowAccess && unreferenced)) return false;
      if (memory.supersedes) return false;
      if ((memory.derivedFrom ?? []).length > 0) return false;
      if (memory.relatedTo.length >= HUB_THRESHOLD) return false;
      return true;
    }).map((memory) => memory.id);
    const toSynthesize: string[][] = [];
    const used = new Set<string>();
    for (let i = 0; i < all.length; i += 1) {
      const seed = all[i];
      if (!seed || used.has(seed.id)) continue;
      const group = [seed];
      for (let j = i + 1; j < all.length; j += 1) {
        const other = all[j];
        if (!other || used.has(other.id)) continue;
        if (cosine(seed.embedding, other.embedding) >= DEFAULTS.synthesisCosine) group.push(other);
      }
      if (group.length >= 2) {
        for (const member of group) used.add(member.id);
        toSynthesize.push(group.map((member) => member.id));
      }
    }
    return { toConsolidate, toArchive, toSynthesize };
  }

  execute(preview?: SleepPreview): SleepReport {
    const plan = preview ?? this.preview();
    const backupId = `backup-${++this.backupSeq}`;
    this.backups.set(backupId, this.store.snapshotAll());
    const actionLog = [`backup ${backupId} created`];
    for (const id of plan.toConsolidate) {
      if (!this.store.get(id)) continue;
      this.store.promote(id, "long_term");
      this.ledger.log(id, "sleep_consolidate", this.actor, { details: { from: "short_term", to: "long_term" } });
      actionLog.push(`consolidated ${id}`);
    }
    for (const id of plan.toArchive) {
      const memory = this.store.get(id);
      if (!memory) continue;
      this.ledger.log(id, "sleep_archive", this.actor, { details: { age: this.clock() - memory.timestamp, accessCount: memory.accessCount } });
      this.store.delete(id, "sleep archive");
      actionLog.push(`archived ${id}`);
    }
    let synthesized = 0;
    for (const group of plan.toSynthesize) {
      const members = group.map((id) => this.store.get(id)).filter((memory): memory is MemoryRecord => !!memory);
      if (members.length < 2) continue;
      const merged = this.store.add({
        content: `Synthesis: ${members.map((memory) => memory.content).join(" | ")}`,
        type: "factual",
        layer: "long_term",
        tags: [...new Set(members.flatMap((memory) => memory.tags))],
        confidence: Math.max(...members.map((memory) => memory.confidence)),
        source: "sleep:synthesis",
        provenance: { origin: "sleep_synthesis", learnedAt: this.clock(), label: `synthesized from ${members.length} memories` },
        derivedFrom: members.map((memory) => memory.id),
      });
      this.ledger.log(merged.id, "sleep_synthesize", this.actor, { details: { sources: group } });
      for (const member of members) this.store.delete(member.id, "merged by sleep synthesis");
      synthesized += 1;
      actionLog.push(`synthesized ${merged.id} from ${group.join(", ")}`);
    }
    this.store.persist();
    return { backupId, consolidated: plan.toConsolidate.length, archived: plan.toArchive.length, synthesized, actionLog };
  }

  restore(backupId: string): void {
    const backup = this.backups.get(backupId);
    if (!backup) throw new Error(`H-MEM: unknown backup ${backupId}`);
    this.store.restoreAll(backup.records, backup.seq);
    this.ledger.log("*", "restore", this.actor, { details: { backupId } });
  }
}
