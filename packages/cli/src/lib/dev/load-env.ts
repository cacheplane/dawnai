import { readFileSync } from "node:fs"
import { join } from "node:path"

function parseAndApply(absPath: string): number {
  let content: string
  try {
    content = readFileSync(absPath, "utf8")
  } catch {
    return 0
  }

  let loaded = 0
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue
    }
    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) {
      continue
    }
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded++
    }
  }
  return loaded
}

function applyLangsmithTracing(): number {
  if (process.env.LANGSMITH_API_KEY && !process.env.LANGCHAIN_TRACING_V2) {
    process.env.LANGCHAIN_TRACING_V2 = "true"
    return 1
  }
  return 0
}

/**
 * Load one or more .env files into process.env, in order.
 * Only sets variables not already defined (shell + earlier files win).
 * Returns the total count of variables set.
 */
export function loadEnvFiles(absPaths: readonly string[]): number {
  let loaded = 0
  for (const p of absPaths) {
    loaded += parseAndApply(p)
  }
  loaded += applyLangsmithTracing()
  return loaded
}

/**
 * Back-compat: load `<dir>/.env`.
 * @deprecated prefer resolveEnvPath + loadEnvFiles.
 */
export function loadEnvFile(dir: string): number {
  return loadEnvFiles([join(dir, ".env")])
}
