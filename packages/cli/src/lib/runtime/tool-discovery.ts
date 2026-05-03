import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

import { registerTsxLoader } from "./register-tsx-loader.js"
import { isRecord } from "./utils.js"

type ToolScope = "route-local" | "shared"

export interface DiscoveredToolDefinition {
  readonly description?: string
  readonly filePath: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
  readonly scope: ToolScope
}

export async function discoverToolDefinitions(options: {
  readonly appRoot: string
  readonly routeDir: string
}): Promise<readonly DiscoveredToolDefinition[]> {
  await registerTsxLoader()

  const sharedTools = await loadToolScope({
    directory: join(options.appRoot, "src", "tools"),
    scope: "shared",
  })
  const routeLocalTools = await loadToolScope({
    directory: join(options.routeDir, "tools"),
    scope: "route-local",
  })

  const discovered = new Map<string, DiscoveredToolDefinition>()

  for (const tool of sharedTools) {
    discovered.set(tool.name, tool)
  }

  for (const tool of routeLocalTools) {
    discovered.set(tool.name, tool)
  }

  return [...discovered.values()]
}

async function loadToolScope(options: {
  readonly directory: string
  readonly scope: ToolScope
}): Promise<readonly DiscoveredToolDefinition[]> {
  const entries = await readdir(options.directory, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return []
  }

  const files = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => join(options.directory, entry.name))
    .sort((left, right) => left.localeCompare(right))

  const discovered: DiscoveredToolDefinition[] = []
  const byName = new Map<string, string>()

  for (const filePath of files) {
    const tool = await loadToolDefinition(filePath, options.scope)
    const existingFile = byName.get(tool.name)

    if (existingFile) {
      throw new Error(
        `Duplicate ${options.scope} Dawn tool name "${tool.name}" detected at ${existingFile} and ${filePath}`,
      )
    }

    byName.set(tool.name, filePath)
    discovered.push(tool)
  }

  return discovered
}

export function injectGeneratedSchemas(
  tools: readonly DiscoveredToolDefinition[],
  generatedSchemas: Record<string, unknown>,
): readonly DiscoveredToolDefinition[] {
  return tools.map((tool) => {
    // User-exported schema takes priority
    if (tool.schema) return tool

    const generated = generatedSchemas[tool.name]
    if (!generated || typeof generated !== "object") return tool

    const entry = generated as { description?: string; parameters?: unknown }
    const description =
      !tool.description && typeof entry.description === "string"
        ? entry.description
        : tool.description
    const schema =
      entry.parameters && typeof entry.parameters === "object" ? entry.parameters : undefined

    if (!description && !schema) return tool

    return { ...tool, ...(description ? { description } : {}), ...(schema ? { schema } : {}) }
  })
}

async function loadToolDefinition(
  filePath: string,
  scope: ToolScope,
): Promise<DiscoveredToolDefinition> {
  const toolModule = (await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`)) as {
    readonly default?: unknown
    readonly description?: unknown
    readonly schema?: unknown
  }
  const definition = toolModule.default
  const name = basename(filePath, ".ts")
  const description =
    typeof toolModule.description === "string" ? toolModule.description : undefined
  const schema = toolModule.schema !== undefined ? toolModule.schema : undefined

  if (typeof definition === "function") {
    return {
      ...(description ? { description } : {}),
      ...(schema ? { schema } : {}),
      filePath,
      name,
      run: definition as DiscoveredToolDefinition["run"],
      scope,
    }
  }

  if (isRecord(definition) && typeof definition.run === "function") {
    return {
      ...(description ? { description } : {}),
      ...(schema ? { schema } : {}),
      filePath,
      name,
      run: definition.run as DiscoveredToolDefinition["run"],
      scope,
    }
  }

  throw new Error(`Tool file ${filePath} must default export a function`)
}
