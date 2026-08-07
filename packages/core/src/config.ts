import type { DawnConfig, LoadDawnConfigOptions, LoadedDawnConfig } from "./types.js"

export const DAWN_CONFIG_FILE = "dawn.config.ts"

/**
 * How a config is materialized for an appRoot. The only implementation Dawn
 * ships reads `dawn.config.ts` from disk through the tsx loader and lives in
 * `config-node.ts` (`@dawn-ai/core/node`) — this module stays free of `node:`
 * imports so the request path never drags the filesystem or a TS loader in.
 */
export type DawnConfigLoader = (options: LoadDawnConfigOptions) => Promise<LoadedDawnConfig>

let configLoader: DawnConfigLoader | undefined

/**
 * Opt this process into loading configs. The node lane registers the disk
 * loader (`registerNodeConfigLoader` in `@dawn-ai/core/node`); an embedder on a
 * runtime with no filesystem either registers its own or seeds the memo with
 * `seedDawnConfig` and never reaches this path at all.
 */
export function registerConfigLoader(loader: DawnConfigLoader): void {
  configLoader = loader
}

/** Test-only: drop the registered loader so a suite can exercise its absence. */
export function __clearConfigLoaderForTests(): void {
  configLoader = undefined
}

const configCache = new Map<string, Promise<LoadedDawnConfig>>()

/**
 * Loads the config for the given appRoot through the registered loader,
 * memoized for the lifetime of the process. Config edits during `dawn dev` are
 * picked up because the dev loop restarts the child process on config changes
 * — a fresh process means a fresh (empty) cache.
 */
export function loadDawnConfig(options: LoadDawnConfigOptions): Promise<LoadedDawnConfig> {
  const cached = configCache.get(options.appRoot)
  if (cached) return cached
  const loader = configLoader
  if (!loader) {
    // Rejected, never thrown synchronously: every caller treats this as a
    // promise-returning function.
    return Promise.reject(
      new Error(
        `${options.appRoot}: no config loader registered — this runtime cannot read ${DAWN_CONFIG_FILE}; pass \`config\` to the runtime instead (see the edge deployment docs).`,
      ),
    )
  }
  const loading = loader(options)
  configCache.set(options.appRoot, loading)
  // A failed load must not be cached forever (e.g. a transient syntax error
  // would otherwise poison the process) — evict on rejection, but only if the
  // cache still holds THIS load: a seedDawnConfig that raced in while the
  // load was in flight must not be evicted by the stale rejection.
  loading.catch(() => {
    if (configCache.get(options.appRoot) === loading) {
      configCache.delete(options.appRoot)
    }
  })
  return loading
}

/**
 * Prime the per-appRoot config memo with an already-constructed DawnConfig —
 * the static-wiring seam for runtimes with no filesystem (edge) and for
 * callers that carry their config as an object. Symmetric with
 * seedPreparedRouteModules. Overwrites any cached entry: an explicit seed
 * always beats a disk load, and survives an in-flight disk load rejecting
 * after the seed lands (the rejection eviction is identity-checked).
 */
export function seedDawnConfig(appRoot: string, config: DawnConfig): void {
  configCache.set(appRoot, Promise.resolve({ appRoot, config, configPath: "<seeded>" }))
}

/** Test-only: clear the memo so fixtures can reload a mutated config. */
export function __clearDawnConfigCacheForTests(): void {
  configCache.clear()
}
