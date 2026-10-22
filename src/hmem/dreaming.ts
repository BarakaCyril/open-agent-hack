import { cosine, jaccard } from "./embeddings.js";
import type { MemoryStoreService } from "./memoryStore.js";
import type { TrustLedgerService } from "./trustLedger.js";
import { DEFAULTS, type DreamProposal, type MemoryRecord } from "./types.js";

export class DreamingService {
  private proposals = new Map<string, DreamProposal>();
  private seq = 0;

  constructor(
    private store: MemoryStoreService,
    private ledger: TrustLedgerService,
    private clock: () => number,
    private actor: string,
  ) {}

  dream(): DreamProposal[] {
    const created: DreamProposal[] = [];
    const propose = (proposal: Omit<DreamProposal, "id" | "status">): void => {
      const stored: DreamProposal = { ...proposal, id: `dream-${++this.seq}`, status: "proposed" };
      this.proposals.set(stored.id, stored);
      created.push(stored);
      this.ledger.log(stored.id, "dream_proposed", this.actor, { details: { type: proposal.type, derivedFrom: proposal.derivedFrom } });
    };
    let insights = 0;
    for (const cluster of this.cluster()) {
      if (insights >= DEFAULTS.maxDreamProposalsPerType) break;
      const domains = [...new Set(cluster.map((memory) => memory.domain))].join("/");
      propose({
        type: "insight",
        content: `Across ${cluster.length} related memories (${domains}): ${cluster.map((memory) => memory.content).join(" + ")}`,
        derivedFrom: cluster.map((memory) => memory.id),
      });
      insights += 1;
    }
    let domains = 0;
    for (const memory of this.store.all()) {
      if (domains >= DEFAULTS.maxDreamProposalsPerType) break;
      if (memory.domain !== "general") continue;
      const suggested = this.store.classifyDomain(memory.content, memory.tags, memory.type);
      if (suggested === "general") continue;
      propose({
        type: "domain",
        content: `Reclassify "${memory.content.slice(0, 60)}" as ${suggested}`,
        derivedFrom: [memory.id],
        suggestedDomain: suggested,
      });
      domains += 1;
    }
    let invariants = 0;
    const preferences = this.store.all().filter((memory) => memory.type === "preference" || memory.type === "personal" || memory.tags.includes("event:user_correction"));
    const byDomain = new Map<string, MemoryRecord[]>();
    for (const preference of preferences) {
      const list = byDomain.get(preference.domain) ?? [];
      list.push(preference);
      byDomain.set(preference.domain, list);
    }
    for (const [domain, list] of byDomain) {
      if (invariants >= DEFAULTS.maxDreamProposalsPerType) break;
      if (list.length < 2) continue;
      propose({
        type: "invariant",
        content: `Stable pattern in ${domain}: ${list.map((memory) => memory.content).join("; ")}`,
        derivedFrom: list.map((memory) => memory.id),
      });
      invariants += 1;
    }
    return created;
  }

  pending(): DreamProposal[] {
    return [...this.proposals.values()].filter((proposal) => proposal.status === "proposed");
  }

  approve(proposalId: string): MemoryRecord | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "proposed") throw new Error(`H-MEM: no pending proposal ${proposalId}`);
    proposal.status = "approved";
    this.ledger.log(proposalId, "dream_approved", this.actor, { details: { type: proposal.type } });
    if (proposal.type === "domain") {
      for (const id of proposal.derivedFrom) {
        const memory = this.store.get(id);
        if (memory && proposal.suggestedDomain) this.store.update(id, { domain: proposal.suggestedDomain });
      }
      return undefined;
    }
    return this.store.add({
      content: proposal.content,
      type: proposal.type === "insight" ? "factual" : "preference",
      layer: "long_term",
      tags: [`dream:${proposal.type}`],
      confidence: 0.75,
      source: "dreaming",
      provenance: { origin: "dream", learnedAt: this.clock(), label: `approved ${proposal.type} proposal` },
      derivedFrom: proposal.derivedFrom,
    });
  }

  reject(proposalId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "proposed") throw new Error(`H-MEM: no pending proposal ${proposalId}`);
    proposal.status = "rejected";
    this.ledger.log(proposalId, "dream_rejected", this.actor, { details: { type: proposal.type } });
  }

  private relatedness(left: MemoryRecord, right: MemoryRecord): number {
    return 0.5 * Math.max(0, cosine(left.embedding, right.embedding))
      + 0.2 * jaccard(left.tags, right.tags)
      + 0.1 * (left.domain === right.domain ? 1 : 0)
      + 0.2 * jaccard(left.entities, right.entities);
  }

  private cluster(): MemoryRecord[][] {
    const all = this.store.all();
    const used = new Set<string>();
    const clusters: MemoryRecord[][] = [];
    for (const seed of all) {
      if (used.has(seed.id)) continue;
      const group = [seed];
      for (const other of all) {
        if (other.id === seed.id || used.has(other.id)) continue;
        if (this.relatedness(seed, other) >= DEFAULTS.dreamRelatedness) group.push(other);
      }
      if (group.length >= DEFAULTS.dreamClusterMinSize) {
        for (const member of group) used.add(member.id);
        clusters.push(group);
      }
    }
    return clusters;
  }
}
