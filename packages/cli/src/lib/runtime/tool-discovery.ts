import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

import type { WorkspaceFs } from "@dawn-ai/sdk"

import { registerTsxLoader } from "./register-tsx-loader.js"
import { isRecord } from "./utils.js"

type ToolScope = "route-local" | "shared"

export interface DiscoveredToolDefinition {
  readonly description?: string
  readonly filePath: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
      // Optional here because pre-wrap invokers (langchain tool-converter/loop)
      // omit it; the prepareRouteExecution wrapper guarantees it at runtime,
      // which is why the author-facing DawnToolContext declares it required.
      readonly fs?: WorkspaceFs
    },
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

    return {
      ...tool,
      ...(description ? { description } : {}),
      ...(schema ? { schema } : {}),
    }
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

  if (looksLikeLangChainTool(definition)) {
    throw new Error(
      `Tool file ${filePath} default-exports a LangChain tool() (StructuredTool "${definition.name}").\n` +
        `Dawn tools are plain functions — Dawn infers the input/output types from the\n` +
        `function signature, so there's no schema wrapper. Convert it like this:\n\n` +
        `  const search = /* your existing tool or client */\n\n` +
        `  /** Describe what the tool does. */\n` +
        `  export default async (input: { readonly query: string }) =>\n` +
        `    search.invoke({ query: input.query })\n\n` +
        `Docs: https://dawnai.org/docs/tools`,
    )
  }

  throw new Error(
    `Tool file ${filePath} must default export a function (got ${describeExport(definition)}).\n` +
      `Docs: https://dawnai.org/docs/tools`,
  )
}

/**
 * Structural detection of a @langchain/core StructuredTool instance —
 * `.invoke()` plus `.name` plus a `schema` — without importing langchain.
 */
function looksLikeLangChainTool(value: unknown): value is { readonly name: string } {
  return (
    isRecord(value) &&
    typeof value.invoke === "function" &&
    typeof value.name === "string" &&
    "schema" in value
  )
}

function describeExport(value: unknown): string {
  if (value === undefined) return "no default export"
  if (value === null) return "null"
  if (isRecord(value)) return `an object with keys [${Object.keys(value).join(", ")}]`
  return `a ${typeof value}`
}
