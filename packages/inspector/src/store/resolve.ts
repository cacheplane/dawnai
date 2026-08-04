import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Embedder } from "@dawn-ai/core"
import type { MemoryStore, RecallRankingOptions, VectorRankingOptions } from "@dawn-ai/memory"

import { importCore, importMemory } from "./runtime-imports"

export interface ResolvedStore {
  readonly store: MemoryStore
  readonly embedder?: Embedder
  readonly appRoot: string
}

let cached: Promise<ResolvedStore> | undefined

/** Resolve the app's LIVE MemoryStore once per server process. */
export function resolveStore(): Promise<ResolvedStore> {
  if (!cached) {
    const attempt = doResolve()
    // Don't cache rejections: a transient failure would otherwise poison the
    // process. Note a FIXED dawn.config.ts still needs a server restart — the
    // ESM module cache holds the previously imported config module.
    attempt.catch(() => {
      if (cached === attempt) cached = undefined
    })
    cached = attempt
  }
  return cached
}

/**
 * resolveStore(), with rejections mapped onto the routes' {error} JSON
 * contract: a missing/typo'd DAWN_APP_ROOT or broken dawn.config.ts must reach
 * the UI as JSON {error}, not Next's generic non-JSON 500 page.
 */
export async function storeOr500(): Promise<ResolvedStore | Response> {
  try {
    return await resolveStore()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return Response.json({ error: message }, { status: 500 })
  }
}

async function doResolve(): Promise<ResolvedStore> {
  const appRoot = process.env.DAWN_APP_ROOT
  if (!appRoot) throw new Error("DAWN_APP_ROOT env var is required to start the Dawn inspector")
  if (!existsSync(appRoot)) {
    // A typo'd path must fail loudly — otherwise we'd silently create
    // <typo>/.dawn/memory.sqlite below and serve an empty store.
    throw new Error(`DAWN_APP_ROOT points at a nonexistent directory: ${appRoot}`)
  }
  const { sqliteMemoryStore } = await importMemory()
  const configPath = join(appRoot, "dawn.config.ts")
  if (!existsSync(configPath)) {
    return { store: sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") }), appRoot }
  }
  // Present but broken must THROW (actionable), not silently fall back.
  const { loadDawnConfig } = await importCore()
  const loaded = await loadDawnConfig({ appRoot })
  const memory = loaded.config.memory
  const embedder = memory?.vector?.embedder
  let store: MemoryStore
  if (memory?.store) {
    // MemoryStoreLike (config-facing) carries the full MemoryStore contract —
    // structurally assignable, no cast needed.
    store = memory.store
  } else {
    // Mirrors packages/cli/src/lib/runtime/resolve-memory.ts: thread the recall
    // + hybrid vector TUNING (never the embedder) into the default sqlite store.
    const recall: RecallRankingOptions | undefined = memory?.recall
    const vectorCfg = memory?.vector
    let vector: VectorRankingOptions | undefined
    if (vectorCfg) {
      vector = {
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
    store = sqliteMemoryStore({
      path: join(appRoot, ".dawn", "memory.sqlite"),
      ...(recall ? { recall } : {}),
      ...(vector ? { vector } : {}),
    })
  }
  return { store, ...(embedder ? { embedder } : {}), appRoot }
}
