import { relative } from "node:path"
import { loadDawnConfig } from "../node-config.js"
import { type CommandIo, writeLine } from "../output.js"
import { loadEnvFiles } from "./load-env.js"
import { resolveEnvPath } from "./resolve-env-path.js"

export interface LoadAppEnvOptions {
  readonly appRoot: string
  /** From the --env-file CLI flag. Highest precedence. */
  readonly flag?: string | undefined
  readonly io: CommandIo
  /** Directory the "Loaded N variable(s) from …" line is printed relative to. Defaults to appRoot. */
  readonly cwd?: string | undefined
}

/**
 * Load the app's env file into process.env with dawn dev's precedence
 * (--env-file flag > dawn.config.ts `env` > "<appRoot>/.env") and report how
 * many variables were loaded. Shared by dawn dev and dawn inspect.
 */
export async function loadAppEnv(options: LoadAppEnvOptions): Promise<number> {
  let configEnv: string | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot: options.appRoot })
    configEnv = loaded.config.env
  } catch {
    // No dawn.config.ts (or it failed to load) — fall through to default.
    configEnv = undefined
  }

  const resolved = resolveEnvPath({
    appRoot: options.appRoot,
    flag: options.flag,
    configEnv,
  })
  const envLoaded = loadEnvFiles([resolved.absPath])
  if (envLoaded > 0) {
    const base = options.cwd ?? options.appRoot
    writeLine(
      options.io.stdout,
      `Loaded ${envLoaded} variable(s) from ${relative(base, resolved.absPath) || ".env"}`,
    )
  }
  return envLoaded
}
