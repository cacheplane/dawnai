import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Load a .env file from the given directory into process.env.
 * Only sets variables that are not already defined (env vars from the shell take precedence).
 * Returns the count of variables loaded.
 */
export function loadEnvFile(dir: string): number {
  const envPath = join(dir, ".env")
  let content: string

  try {
    content = readFileSync(envPath, "utf8")
  } catch {
    return 0
  }

  let loaded = 0

  for (const line of content.split("\n")) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue
    }

    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded++
    }
  }

  // Auto-enable LangSmith tracing when API key is present
  if (process.env.LANGSMITH_API_KEY && !process.env.LANGCHAIN_TRACING_V2) {
    process.env.LANGCHAIN_TRACING_V2 = "true"
    loaded++
  }

  return loaded
}
