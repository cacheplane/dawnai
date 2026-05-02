import { existsSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

import { registerTsxLoader } from "./register-tsx-loader.js"

export interface DiscoveredStateDefinition {
  readonly defaults: Map<string, unknown>
  readonly reducerOverrides: Map<string, (current: unknown, incoming: unknown) => unknown>
}

export async function discoverStateDefinition(options: {
  readonly routeDir: string
}): Promise<DiscoveredStateDefinition | null> {
  const stateFile = join(options.routeDir, "state.ts")
  if (!existsSync(stateFile)) return null

  await registerTsxLoader()

  const stateModule = (await import(`${pathToFileURL(stateFile).href}?t=${Date.now()}`)) as {
    readonly default?: unknown
  }
  const schema = stateModule.default
  if (!schema || typeof schema !== "object") return null

  const defaults = extractDefaults(schema)
  if (!defaults) return null

  const reducerOverrides = await discoverReducerOverrides(options.routeDir)

  return { defaults, reducerOverrides }
}

function extractDefaults(schema: unknown): Map<string, unknown> | null {
  // Standard Schema v1 check
  if (isStandardSchema(schema)) {
    const result = schema["~standard"].validate({})
    if ("issues" in result && result.issues) return null
    if (typeof result.value !== "object" || result.value === null) return null
    return new Map(Object.entries(result.value as Record<string, unknown>))
  }

  // Fallback: zod-compatible .parse()
  if (hasParseMethod(schema)) {
    try {
      const parsed = schema.parse({})
      if (typeof parsed === "object" && parsed !== null) {
        return new Map(Object.entries(parsed))
      }
    } catch {
      return null
    }
  }

  return null
}

function isStandardSchema(value: unknown): value is {
  "~standard": { validate: (input: unknown) => { value?: unknown; issues?: unknown[] } }
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    typeof (value as Record<string, unknown>)["~standard"] === "object"
  )
}

function hasParseMethod(value: unknown): value is { parse: (input: unknown) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "parse" in value &&
    typeof (value as Record<string, unknown>).parse === "function"
  )
}

async function discoverReducerOverrides(
  routeDir: string,
): Promise<Map<string, (current: unknown, incoming: unknown) => unknown>> {
  const reducersDir = join(routeDir, "reducers")
  const overrides = new Map<string, (current: unknown, incoming: unknown) => unknown>()

  if (!existsSync(reducersDir)) return overrides

  const entries = readdirSync(reducersDir)
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue
    if (entry.endsWith(".d.ts")) continue

    const fieldName = basename(entry, ".ts")
    const filePath = join(reducersDir, entry)
    const mod = (await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`)) as {
      readonly default?: unknown
    }

    if (typeof mod.default === "function") {
      overrides.set(fieldName, mod.default as (current: unknown, incoming: unknown) => unknown)
    }
  }

  return overrides
}
