import { basename, join } from "node:path"
import type { MemoryContext, MemoryStoreLike, MemoryWritesMode } from "@dawn-ai/core"
import { loadDawnConfig } from "@dawn-ai/core"
import {
  type RecallRankingOptions,
  serializeNamespace,
  type VectorRankingOptions,
} from "@dawn-ai/memory"
import type { LoadedRouteMemory } from "./load-memory.js"

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
  // Imported lazily: the default sqlite-backed store is resolved only when
  // this fallback branch actually runs, keeping sqliteMemoryStore off this
  // module's static import surface (a config-provided store never loads it).
  const { sqliteMemoryStore } = await import("@dawn-ai/memory")
  return sqliteMemoryStore({
    path: join(appRoot, ".dawn", "memory.sqlite"),
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

/** Build the per-request memory capability context for a route with a memory.ts. */
export function buildMemoryContext(args: {
  defined: LoadedRouteMemory
  store: MemoryContext["store"]
  writes: MemoryWritesMode
  appRoot: string
  routePath: string
  now: string
  indexMaxEntries?: number
  extraScope?: Record<string, string>
  /** Resolved embedder when vector recall is enabled — the capability embeds
   *  writes + queries through it. Absent → keyword-only. */
  embedder?: MemoryContext["embedder"]
  /** Hybrid recall tuning threaded to the store's search (no embedder). */
  vector?: MemoryContext["vector"]
}): MemoryContext {
  const { defined } = args
  // Build all available dimensions from known sources.
  const allDims: Record<string, string> = {
    workspace: basename(args.appRoot) || "app",
    route: args.routePath,
    ...(args.extraScope ?? {}),
  }
  // Restrict to only the dimensions this route declared in scope.
  // serializeNamespace accepts the MemoryScopeTuple keys (workspace, route, tenant, user, agent).
  const tuple: Record<string, string> = {}
  for (const dim of defined.scope) {
    if (allDims[dim] !== undefined) tuple[dim] = allDims[dim]
  }
  const namespace = serializeNamespace(
    tuple as import("@dawn-ai/memory").MemoryScopeTuple & Record<string, string>,
  )
  const schema = defined.schema as {
    safeParse(d: unknown): {
      success: boolean
      data?: unknown
      error?: { message: string }
    }
  }
  return {
    store: args.store,
    namespace,
    writes: args.writes,
    defined: {
      kind: defined.kind,
      scope: defined.scope,
      ...(defined.identity ? { identity: defined.identity } : {}),
    },
    // The route's zod schema — surfaced as the `remember` tool's `data` shape.
    schema: defined.schema,
    validate: (data: unknown) => {
      const r = schema.safeParse(data)
      return r.success
        ? {
            ok: true as const,
            value: (r.data ?? {}) as Record<string, unknown>,
          }
        : {
            ok: false as const,
            errors: r.error?.message ?? "memory data failed schema validation",
          }
    },
    now: args.now,
    ...(args.indexMaxEntries !== undefined ? { indexMaxEntries: args.indexMaxEntries } : {}),
    ...(args.embedder ? { embedder: args.embedder } : {}),
    ...(args.vector ? { vector: args.vector } : {}),
  }
}
