import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { loadAuthoringRouteDefinition, type ResolvedAuthoringRouteDefinition } from "@dawn/core"

import { registerTsxLoader } from "./register-tsx-loader.js"

export { loadAuthoringRouteDefinition, type ResolvedAuthoringRouteDefinition }

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
): Promise<
  | ((input: unknown, context: unknown) => Promise<unknown> | unknown)
  | { readonly invoke: (input: unknown, context: unknown) => Promise<unknown> | unknown }
> {
  await registerTsxLoader()
  const routeModule = (await import(pathToFileURL(definition.executableFile).href)) as Record<
    string,
    unknown
  >
  const handler = routeModule[definition.kind]

  if (definition.kind === "graph") {
    if (typeof handler === "function") {
      return handler as (input: unknown, context: unknown) => Promise<unknown> | unknown
    }

    if (
      typeof handler === "object" &&
      handler !== null &&
      "invoke" in handler &&
      typeof handler.invoke === "function"
    ) {
      return handler as {
        readonly invoke: (input: unknown, context: unknown) => Promise<unknown> | unknown
      }
    }

    throw new Error(
      `Authoring graph route at ${definition.executableFile} must export a callable "graph" handler or an object exposing invoke(input)`,
    )
  }

  if (typeof handler !== "function") {
    throw new Error(
      `Authoring ${definition.kind} route at ${definition.executableFile} must export a callable "${definition.kind}" handler`,
    )
  }

  return handler as (input: unknown, context: unknown) => Promise<unknown> | unknown
}
