import type { MemoryStore } from "@dawn-ai/memory"

export function pgvectorMemoryStore(_opts: {
  connectionString?: string
  dimensions: number
}): MemoryStore {
  throw new Error("pgvectorMemoryStore: not implemented (scaffold)")
}
