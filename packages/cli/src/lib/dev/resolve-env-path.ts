import { isAbsolute, resolve } from "node:path"

export interface ResolveEnvPathOptions {
  readonly appRoot: string
  /** From the --env-file CLI flag. Highest precedence. */
  readonly flag?: string
  /** From dawn.config.ts `env`. */
  readonly configEnv?: string
}

export interface ResolvedEnvPath {
  readonly absPath: string
  readonly source: "flag" | "config" | "default"
}

function toAbs(appRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(appRoot, p)
}

/** Resolve the env file path: flag > config > "<appRoot>/.env". */
export function resolveEnvPath(options: ResolveEnvPathOptions): ResolvedEnvPath {
  if (options.flag !== undefined && options.flag.length > 0) {
    return { absPath: toAbs(options.appRoot, options.flag), source: "flag" }
  }
  if (options.configEnv !== undefined && options.configEnv.length > 0) {
    return { absPath: toAbs(options.appRoot, options.configEnv), source: "config" }
  }
  return { absPath: resolve(options.appRoot, ".env"), source: "default" }
}
