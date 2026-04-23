import { pathToFileURL } from "node:url"

import type { RouteKind } from "@dawnai.org/sdk"

import { registerTsxLoader } from "./register-tsx-loader.js"

export interface NormalizedRouteModule {
  readonly kind: RouteKind
  readonly entry: unknown
  readonly config: Record<string, unknown>
}

export async function loadRouteKind(routeFile: string): Promise<RouteKind> {
  const normalized = await normalizeRouteModule(routeFile)
  return normalized.kind
}

export async function normalizeRouteModule(routeFile: string): Promise<NormalizedRouteModule> {
  await registerTsxLoader()
  const routeModule = (await import(pathToFileURL(routeFile).href)) as {
    readonly chain?: unknown
    readonly config?: Record<string, unknown>
    readonly graph?: unknown
    readonly workflow?: unknown
  }

  const hasChain = "chain" in routeModule && routeModule.chain !== undefined
  const hasGraph = "graph" in routeModule && routeModule.graph !== undefined
  const hasWorkflow = "workflow" in routeModule && routeModule.workflow !== undefined

  const count = [hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(
      `Route index.ts at ${routeFile} must export exactly one of "workflow", "graph", or "chain"`,
    )
  }

  if (hasChain) {
    return { kind: "chain", entry: routeModule.chain, config: routeModule.config ?? {} }
  }

  if (hasGraph) {
    return { kind: "graph", entry: routeModule.graph, config: routeModule.config ?? {} }
  }

  if (hasWorkflow) {
    return { kind: "workflow", entry: routeModule.workflow, config: routeModule.config ?? {} }
  }

  throw new Error(`Route index.ts at ${routeFile} exports neither "workflow", "graph", nor "chain"`)
}
