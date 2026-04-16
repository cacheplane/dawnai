import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { registerTsxLoader } from "./register-tsx-loader.js"
import { isRecord } from "./utils.js"

type ToolScope = "route-local" | "shared"

export interface DiscoveredToolDefinition {
  readonly filePath: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown> | unknown
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

async function loadToolDefinition(
  filePath: string,
  scope: ToolScope,
): Promise<DiscoveredToolDefinition> {
  const toolModule = (await import(pathToFileURL(filePath).href)) as {
    readonly default?: unknown
  }
  const definition = toolModule.default

  if (!isRecord(definition)) {
    throw new Error(`Tool module ${filePath} must default export a Dawn tool definition`)
  }

  if (typeof definition.name !== "string" || definition.name.trim().length === 0) {
    throw new Error(`Tool module ${filePath} must define a non-empty tool name`)
  }

  if (typeof definition.run !== "function") {
    throw new Error(`Tool module ${filePath} must define a callable tool.run`)
  }

  return {
    filePath,
    name: definition.name,
    run: definition.run as DiscoveredToolDefinition["run"],
    scope,
  }
}
