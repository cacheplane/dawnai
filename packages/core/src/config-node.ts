/**
 * The NODE half of config loading: reading `dawn.config.ts` off disk through
 * the tsx ESM loader. Split out of `config.ts` so the request path keeps the
 * memo (`loadDawnConfig`/`seedDawnConfig`) without `node:fs`, `node:path`,
 * `node:url` or `tsx` entering its module graph.
 *
 * Ships from `@dawn-ai/core/node`.
 */

import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { DAWN_CONFIG_FILE, registerConfigLoader } from "./config.js"
import type { DawnConfig, LoadDawnConfigOptions, LoadedDawnConfig } from "./types.js"

let loaderPromise: Promise<void> | undefined

/**
 * Register the tsx ESM loader (idempotent). Exported so callers that import
 * user-authored TS modules directly (e.g. the inspector loading a route's
 * memory.ts) get deterministic TS loading even when no dawn.config.ts exists —
 * loadDawnConfig only registers the loader when a config file is present.
 */
export async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= (async () => {
    const { register } = (await import("tsx/esm/api")) as {
      readonly register: () => unknown
    }
    register()
  })()
  await loaderPromise
}

export async function loadDawnConfigUncached(
  options: LoadDawnConfigOptions,
): Promise<LoadedDawnConfig> {
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

/** Point `loadDawnConfig` at the disk loader. Idempotent. */
export function registerNodeConfigLoader(): void {
  registerConfigLoader(loadDawnConfigUncached)
}

// Importing this module IS the node opt-in: `@dawn-ai/core/node` re-exports it,
// so every node entry that already reaches for the node barrel gets the disk
// loader with no call site of its own. `registerNodeConfigLoader` stays
// exported for entries that want the wiring explicit and greppable.
registerNodeConfigLoader()
