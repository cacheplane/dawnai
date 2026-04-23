import type { RouteConfig, RouteKind } from "@dawnai.org/sdk"

export type { RouteConfig, RouteKind }

export interface GraphRouteModule<TEntry = unknown> {
  readonly graph: TEntry
  readonly workflow?: never
  readonly config?: RouteConfig
}

export interface WorkflowRouteModule<TEntry = unknown> {
  readonly workflow: TEntry
  readonly graph?: never
  readonly config?: RouteConfig
}

export type RouteModule<TEntry = unknown> = GraphRouteModule<TEntry> | WorkflowRouteModule<TEntry>

export interface NormalizedRouteModule<TEntry = unknown> {
  readonly kind: RouteKind
  readonly entry: TEntry
  readonly config: RouteConfig
}

export function normalizeRouteModule<TEntry>(
  module: RouteModule<TEntry> | (GraphRouteModule<TEntry> & WorkflowRouteModule<TEntry>),
): NormalizedRouteModule<TEntry> {
  assertExactlyOneEntry(module)

  if (hasDefinedKey(module, "graph")) {
    return {
      kind: "graph",
      entry: module.graph as TEntry,
      config: module.config ?? {},
    }
  }

  return {
    kind: "workflow",
    entry: module.workflow as TEntry,
    config: module.config ?? {},
  }
}

export function assertExactlyOneEntry<TEntry>(
  module: RouteModule<TEntry> | (GraphRouteModule<TEntry> & WorkflowRouteModule<TEntry>),
): asserts module is RouteModule<TEntry> {
  const hasGraph = hasDefinedKey(module, "graph")
  const hasWorkflow = hasDefinedKey(module, "workflow")

  if (hasGraph && hasWorkflow) {
    throw new Error(`Route index.ts must export exactly one of "workflow" or "graph"`)
  }

  if (!hasGraph && !hasWorkflow) {
    throw new Error(`Route index.ts exports neither "workflow" nor "graph"`)
  }
}

function hasDefinedKey(module: object, key: "graph" | "workflow"): boolean {
  return key in module && (module as Record<string, unknown>)[key] !== undefined
}
