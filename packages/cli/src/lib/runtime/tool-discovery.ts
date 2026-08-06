import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

import { importModule } from "./import-module.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import { type DiscoveredToolDefinition, normalizeToolModule, type ToolScope } from "./tool-shape.js"

export {
  type DiscoveredToolDefinition,
  injectGeneratedSchemas,
  normalizeToolModule,
  type ToolScope,
} from "./tool-shape.js"

export async function discoverToolDefinitions(options: {
  readonly appRoot: string
  readonly routeDir: string
}): Promise<readonly DiscoveredToolDefinition[]> {
  await registerTsxLoader()

  const sharedTools = await loadToolScope({
    appRoot: options.appRoot,
    directory: join(options.appRoot, "src", "tools"),
    scope: "shared",
  })
  const routeLocalTools = await loadToolScope({
    appRoot: options.appRoot,
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
  readonly appRoot: string
  readonly directory: string
  readonly scope: ToolScope
}): Promise<readonly DiscoveredToolDefinition[]> {
  const entries = await readdir(options.directory, {
    withFileTypes: true,
  }).catch(() => null)

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
    const tool = await loadToolDefinition(filePath, options.scope, options.appRoot)
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
  appRoot: string,
): Promise<DiscoveredToolDefinition> {
  const toolModule = await importModule(pathToFileURL(filePath).href, {
    kind: "tool",
    appRoot,
    sourcePath: filePath,
  })
  return normalizeToolModule(toolModule, { filePath, name: basename(filePath, ".ts"), scope })
}
