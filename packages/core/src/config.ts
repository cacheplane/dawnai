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

export async function loadDawnConfig(options: LoadDawnConfigOptions): Promise<LoadedDawnConfig> {
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
