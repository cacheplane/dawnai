import type { MemoryRecord, MemoryStore } from "@dawn-ai/memory"
import { sqliteMemoryStore } from "@dawn-ai/memory"

type SeedInput = Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace" | "content">

/** Seed memory rows into a store (or a sqlite path) with sensible defaults for tests. */
export async function seedMemory(
  target: MemoryStore | { readonly path: string },
  records: readonly SeedInput[],
): Promise<MemoryStore> {
  const store: MemoryStore = "put" in target ? (target as MemoryStore) : sqliteMemoryStore(target)
  for (const r of records) {
    await store.put({
      kind: "semantic",
      data: {},
      source: { type: "eval", id: "seed" },
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...r,
    })
  }
  return store
}
