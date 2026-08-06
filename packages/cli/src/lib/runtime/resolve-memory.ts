import type { MemoryStoreLike, MemoryWritesMode } from "@dawn-ai/core"
import { loadDawnConfig } from "@dawn-ai/core"
import type { RecallRankingOptions, VectorRankingOptions } from "@dawn-ai/memory"
import { pureJoin } from "./pure-path.js"

/**
 * Resolves the MemoryStore for the given appRoot.
 *
 * Uses `config.memory.store` if the user's `dawn.config.ts` provides one;
 * otherwise falls back to the default SQLite-backed store at
 * `<appRoot>/.dawn/memory.sqlite`.
 */
export async function resolveMemoryStore(appRoot: string): Promise<MemoryStoreLike> {
  let recall: RecallRankingOptions | undefined
  let storeVector: VectorRankingOptions | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.memory?.store) return loaded.config.memory.store
    recall = loaded.config.memory?.recall
    // The store gets only the hybrid TUNING (weights/rrfK/vectorK/recency/
    // confidence) — NOT the embedder. The store never embeds; the capability
    // does, then passes vectors + this tuning into search.
    const vectorCfg = loaded.config.memory?.vector
    if (vectorCfg) {
      storeVector = {
        ...(vectorCfg.weights ? { weights: vectorCfg.weights } : {}),
        ...(vectorCfg.rrfK !== undefined ? { rrfK: vectorCfg.rrfK } : {}),
        ...(vectorCfg.vectorK !== undefined ? { vectorK: vectorCfg.vectorK } : {}),
        ...(vectorCfg.recencyWeight !== undefined
          ? { recencyWeight: vectorCfg.recencyWeight }
          : {}),
        ...(vectorCfg.confidenceWeight !== undefined
          ? { confidenceWeight: vectorCfg.confidenceWeight }
          : {}),
      }
    }
  } catch {
    // no dawn.config.ts / unreadable — use default
  }
  // Imported lazily: removes the static BINDING of sqliteMemoryStore, so
  // the default sqlite store (and node:sqlite behind it) is only reached when
  // this fallback branch actually runs.
  const { sqliteMemoryStore } = await import("@dawn-ai/memory")
  return sqliteMemoryStore({
    path: pureJoin(appRoot, ".dawn", "memory.sqlite"),
    ...(recall ? { recall } : {}),
    ...(storeVector ? { vector: storeVector } : {}),
  })
}

/**
 * Resolves the memory write-governance mode for the given appRoot.
 *
 * Defaults to `"candidate"` when no config is present.
 */
export async function resolveMemoryWrites(appRoot: string): Promise<MemoryWritesMode> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    return loaded.config.memory?.writes ?? "candidate"
  } catch {
    return "candidate"
  }
}

// Re-exported so `resolve-memory.js` stays the one import site callers know;
// the implementation lives in the node-free `memory-context.ts`.
export { buildMemoryContext } from "./memory-context.js"
