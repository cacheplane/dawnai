import { basename, join } from "node:path"
import type { MemoryContext, MemoryStoreLike, MemoryWritesMode } from "@dawn-ai/core"
import { loadDawnConfig } from "@dawn-ai/core"
import {
  type RecallRankingOptions,
  serializeNamespace,
  sqliteMemoryStore,
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

/** Resolved `config.memory.episodes` — the runtime episode recorder's knobs. */
export interface ResolvedEpisodesConfig {
  readonly enabled: boolean
  readonly ttlMs: number
  readonly cap: number
  readonly includeFailedRuns: boolean
  readonly embed: boolean
}

let warnedEmbedUnsupported = false

/**
 * Resolves the episode-recorder config for the given appRoot.
 *
 * Defaults: disabled, 30-day TTL, 500-episode per-namespace cap, failed runs
 * included, no embeddings. Uses the same cached `loadDawnConfig` loader as the
 * other resolvers; missing/unreadable config falls back to defaults.
 *
 * `embed: true` is not supported this cycle — it resolves to `false` and logs
 * a one-line warning once per process (honest, forward-compatible).
 */
export async function resolveEpisodesConfig(appRoot: string): Promise<ResolvedEpisodesConfig> {
  let episodes:
    | {
        readonly enabled?: boolean
        readonly ttlMs?: number
        readonly cap?: number
        readonly includeFailedRuns?: boolean
        readonly embed?: boolean
      }
    | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    episodes = loaded.config.memory?.episodes
  } catch {
    // No dawn.config.ts or unreadable — use defaults.
  }
  if (episodes?.embed === true && !warnedEmbedUnsupported) {
    warnedEmbedUnsupported = true
    console.warn(
      "[dawn] memory.episodes.embed is not yet supported; episodes are recorded without embeddings",
    )
  }
  return {
    enabled: episodes?.enabled ?? false,
    ttlMs: episodes?.ttlMs ?? 30 * 86_400_000,
    cap: episodes?.cap ?? 500,
    includeFailedRuns: episodes?.includeFailedRuns ?? true,
    embed: false,
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
