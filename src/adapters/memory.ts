/**
 * MemoryPort is the stable swap point for H-MEM.
 * recall(farmerId) and remember(farmerId, record) must keep these signatures.
 *
 * REPLACE WITH H-MEM. InProcessMemory is a temporary process-local store.
 * The reference implementation lives in memory/hmem and is not wired in.
 * Set HMEM_ENABLED=true to fail loudly instead of pretending H-MEM is active.
 */

import { NotImplementedError } from "../errors.js";

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

/** REPLACE WITH H-MEM. Temporary in-process implementation. */
export class InProcessMemory implements MemoryPort {
  private readonly records: MemoryRecord[] = [];

  async recall(farmerId: string): Promise<MemoryRecord[]> {
    return structuredClone(this.records.filter((record) => record.farmerId === farmerId));
  }

  async remember(farmerId: string, record: NewMemoryRecord): Promise<void> {
    this.records.push({
      farmerId,
      kind: record.kind,
      content: record.content,
      payload: structuredClone(record.payload),
      createdAt: record.createdAt ?? new Date().toISOString(),
    });
  }
}

export function createHmemPort(): MemoryPort {
  throw new NotImplementedError(
    "H-MEM memory port. Wire memory/hmem behind MemoryPort. Leave HMEM_ENABLED unset to use the temporary in-process store.",
  );
}

let singleton: MemoryPort | null = null;

export function getMemory(): MemoryPort {
  if (process.env.HMEM_ENABLED === "true") return createHmemPort();
  if (!singleton) singleton = new InProcessMemory();
  return singleton;
}

export function resetMemoryForTests(): void {
  singleton = null;
}
