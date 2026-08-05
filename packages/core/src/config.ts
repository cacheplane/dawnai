import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { DawnConfig, LoadDawnConfigOptions, LoadedDawnConfig } from "./types.js"

export const DAWN_CONFIG_FILE = "dawn.config.ts"

let loaderPromise: Promise<void> | undefined

async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= (async () => {
    const { register } = (await import("tsx/esm/api")) as {
      readonly register: () => unknown
    }
    register()
  })()
  await loaderPromise
}

async function loadDawnConfigUncached(options: LoadDawnConfigOptions): Promise<LoadedDawnConfig> {
  const configPath = join(options.appRoot, DAWN_CONFIG_FILE)
  await access(configPath, constants.F_OK)
  await registerTsxLoader()

  const mod = (await import(pathToFileURL(configPath).href)) as {
    readonly default?: unknown
  }

  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`${DAWN_CONFIG_FILE} must export default an object. Got: ${typeof mod.default}`)
  }

  return {
    appRoot: options.appRoot,
    config: mod.default as DawnConfig,
    configPath,
  }
}

const configCache = new Map<string, Promise<LoadedDawnConfig>>()

/**
 * Loads `dawn.config.ts` for the given appRoot, memoized for the lifetime of
 * the process. Config edits during `dawn dev` are picked up because the dev
 * loop restarts the child process on config changes — a fresh process means
 * a fresh (empty) cache.
 */
export function loadDawnConfig(options: LoadDawnConfigOptions): Promise<LoadedDawnConfig> {
  const cached = configCache.get(options.appRoot)
  if (cached) return cached
  const loading = loadDawnConfigUncached(options)
  configCache.set(options.appRoot, loading)
  // A failed load must not be cached forever (e.g. a transient syntax error
  // would otherwise poison the process) — evict on rejection.
  loading.catch(() => configCache.delete(options.appRoot))
  return loading
}

/** Test-only: clear the memo so fixtures can reload a mutated config. */
export function __clearDawnConfigCacheForTests(): void {
  configCache.clear()
}
