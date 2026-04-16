import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { registerTsxLoader } from "./register-tsx-loader.js"

export interface ResolvedAuthoringRouteDefinition {
  readonly entry: "./graph.ts" | "./workflow.ts"
  readonly executableFile: string
  readonly kind: "graph" | "workflow"
  readonly routeDefinitionFile: string
  readonly routeDir: string
}

export async function loadAuthoringRouteDefinition(
  routeDefinitionFile: string,
): Promise<ResolvedAuthoringRouteDefinition | null> {
  if (!(await fileExists(routeDefinitionFile))) {
    return null
  }

  await registerTsxLoader()
  const routeModule = (await import(pathToFileURL(routeDefinitionFile).href)) as {
    readonly default?: unknown
    readonly route?: unknown
  }
  const definition = routeModule.route ?? routeModule.default

  if (!isRecord(definition)) {
    throw new Error(`Route definition ${routeDefinitionFile} must export a Dawn route definition`)
  }

  const routeDir = dirname(routeDefinitionFile)
  const kind = definition.kind
  const entry = definition.entry

  if (kind !== "graph" && kind !== "workflow") {
    throw new Error(
      `Route definition ${routeDefinitionFile} must define kind as "graph" or "workflow"`,
    )
  }

  if (entry !== "./graph.ts" && entry !== "./workflow.ts") {
    throw new Error(
      `Route definition ${routeDefinitionFile} kind "${kind}" must bind entry "./${kind}.ts", received ${JSON.stringify(entry)}`,
    )
  }

  if (
    (kind === "graph" && entry !== "./graph.ts") ||
    (kind === "workflow" && entry !== "./workflow.ts")
  ) {
    throw new Error(
      `Route definition ${routeDefinitionFile} kind "${kind}" must bind entry "./${kind}.ts", received ${JSON.stringify(entry)}`,
    )
  }

  const executableFile = resolve(routeDir, entry.slice(2))

  if (!(await fileExists(executableFile))) {
    throw new Error(
      `Route definition ${routeDefinitionFile} binds to missing executable file: ${executableFile}`,
    )
  }

  return {
    entry,
    executableFile,
    kind,
    routeDefinitionFile,
    routeDir,
  }
}

export async function resolveAuthoringRouteDefinitionForTarget(
  routeFile: string,
): Promise<ResolvedAuthoringRouteDefinition | null> {
  const resolvedRouteFile = resolve(routeFile)
  const routeDefinitionFile = join(dirname(resolvedRouteFile), "route.ts")
  const definition = await loadAuthoringRouteDefinition(routeDefinitionFile)

  if (!definition) {
    return null
  }

  if (definition.executableFile !== resolvedRouteFile) {
    throw new Error(
      `Route definition ${routeDefinitionFile} binds to ${basename(definition.executableFile)}, not requested file: ${resolvedRouteFile}`,
    )
  }

  return definition
}

export async function loadAuthoringRouteHandler(
  definition: ResolvedAuthoringRouteDefinition,
): Promise<(input: unknown, context: unknown) => Promise<unknown> | unknown> {
  await registerTsxLoader()
  const routeModule = (await import(pathToFileURL(definition.executableFile).href)) as Record<
    string,
    unknown
  >
  const handler = routeModule[definition.kind]

  if (typeof handler !== "function") {
    throw new Error(
      `Authoring ${definition.kind} route at ${definition.executableFile} must export a callable "${definition.kind}" handler`,
    )
  }

  return handler as (input: unknown, context: unknown) => Promise<unknown> | unknown
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
