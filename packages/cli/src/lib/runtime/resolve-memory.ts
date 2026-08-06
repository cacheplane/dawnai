import type { DawnConfig, MemoryStoreLike, MemoryWritesMode } from "@dawn-ai/core"
import { loadDawnConfig } from "@dawn-ai/core"
import type { RecallRankingOptions, VectorRankingOptions } from "@dawn-ai/memory"
import type { ModelProviderId } from "@dawn-ai/sdk"
import { inferProvider } from "@dawn-ai/sdk"
import { pureJoin } from "./pure-path.js"
import { type ResolvedEpisodesConfig, resolveEpisodesFromConfig } from "./record-episode.js"

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

/**
 * Resolves the episode-recorder config for the given appRoot, reading
 * `dawn.config.ts` through the same cached `loadDawnConfig` loader as the
 * other resolvers; missing/unreadable config falls back to the defaults.
 *
 * This is the DISK entry point — `dawn memory prune` and any other node caller
 * that has an appRoot but no loaded config. The request path does not come
 * through here: `execute-route-core.ts` applies the same defaulting to the
 * `DawnConfig` it already holds via `resolveEpisodesFromConfig`, which is
 * where the rule itself lives (and which stays reachable from the node-free
 * fetch graph).
 */
export async function resolveEpisodesConfig(appRoot: string): Promise<ResolvedEpisodesConfig> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    return resolveEpisodesFromConfig(loaded.config.memory?.episodes)
  } catch {
    // No dawn.config.ts or unreadable — use defaults.
    return resolveEpisodesFromConfig(undefined)
  }
}

/** Resolved `config.memory.distill` — the distillation commands' knobs. */
export interface ResolvedDistillConfig {
  readonly model: string
  /** Always populated — the EFFECTIVE provider (authored, else inferred from
   *  `model`, else `"openai"`). Pair with `providerAuthored` before overriding. */
  readonly provider: ModelProviderId
  /**
   * True only when `memory.distill.provider` was authored in `dawn.config.ts`.
   *
   * `provider` alone cannot distinguish a deliberate choice from an inferred
   * default, and the two must be treated differently: an authored provider is a
   * decision (a proxy, an OpenAI-compatible endpoint) that outranks inference,
   * while an inferred one is just a guess derived from `model` — so a caller
   * that overrides the model (`dawn memory consolidate --model …`) must re-infer
   * rather than pair a Claude model id with ChatOpenAI.
   */
  readonly providerAuthored: boolean
  readonly maxBatches: number
  readonly consolidate: {
    readonly olderThanMs: number
    readonly minBatchSize: number
    readonly maxBatchSize: number
    /** Absent unless configured — summaries don't expire by default. */
    readonly ttlMs?: number
    /** ALWAYS resolved (unlike `ttlMs`): how long superseded sources stay
     *  inspectable before prune reaps them and returns their cap budget. */
    readonly sourceTtlMs: number
  }
  readonly reflect: {
    readonly minNewRecords: number
    readonly maxRecords: number
    readonly writes: "candidate" | "auto"
  }
}

/**
 * Resolves the distillation config for the given appRoot.
 *
 * Defaults: model `gpt-5-mini`, provider inferred from the resolved model (the
 * same `inferProvider` route agents and the built-in summarizer use) falling
 * back to `"openai"`, 5 batches per invocation, consolidation over records
 * older than 7 days in batches of 5..50 with no summary TTL and a 7-day TTL on
 * the sources it supersedes, and reflection after 10 new records over at most
 * 100 records written as candidates.
 *
 * Uses the same cached `loadDawnConfig` loader as the other resolvers;
 * missing/unreadable config falls back to defaults. Values are passed through
 * as authored — no range validation here (the engine clamps at use-site).
 *
 * Unlike the episodes rule, the defaulting stays INLINE here rather than being
 * split into a pure module: distillation is invoked only by `dawn memory
 * consolidate` / `dawn memory reflect`, so this resolver has exactly one
 * caller and no request-path twin. Nothing in the `@dawn-ai/cli/fetch` graph
 * reaches it (see test/fetch-entry-purity.test.ts) — the file still carries no
 * `node:` import of its own, so the split would buy nothing.
 */
export async function resolveDistillConfig(appRoot: string): Promise<ResolvedDistillConfig> {
  let distill: NonNullable<NonNullable<DawnConfig["memory"]>["distill"]> | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    distill = loaded.config.memory?.distill
  } catch {
    // No dawn.config.ts or unreadable — use defaults.
  }
  const model = distill?.model ?? "gpt-5-mini"
  const consolidate = distill?.consolidate
  const reflect = distill?.reflect
  return {
    model,
    provider: distill?.provider ?? inferProvider(model) ?? "openai",
    providerAuthored: distill?.provider !== undefined,
    maxBatches: distill?.maxBatches ?? 5,
    consolidate: {
      olderThanMs: consolidate?.olderThanMs ?? 7 * 86_400_000,
      minBatchSize: consolidate?.minBatchSize ?? 5,
      maxBatchSize: consolidate?.maxBatchSize ?? 50,
      sourceTtlMs: consolidate?.sourceTtlMs ?? 7 * 86_400_000,
      ...(consolidate?.ttlMs !== undefined ? { ttlMs: consolidate.ttlMs } : {}),
    },
    reflect: {
      minNewRecords: reflect?.minNewRecords ?? 10,
      maxRecords: reflect?.maxRecords ?? 100,
      writes: reflect?.writes ?? "candidate",
    },
  }
}

// Re-exported so `resolve-memory.js` stays the one import site callers know;
// the implementations live in the node-free `memory-context.ts` /
// `record-episode.ts` (both are on the request path).
export { buildMemoryContext } from "./memory-context.js"
export type { ResolvedEpisodesConfig }
