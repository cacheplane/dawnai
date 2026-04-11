export type RouteEntryKind = "graph" | "workflow"

export interface RouteConfig {
  readonly runtime?: "node" | "edge"
  readonly streaming?: boolean
  readonly tags?: readonly string[]
}

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
  readonly kind: RouteEntryKind
  readonly entry: TEntry
  readonly config: RouteConfig
}

export function normalizeRouteModule<TEntry>(
  module: RouteModule<TEntry> | (GraphRouteModule<TEntry> & WorkflowRouteModule<TEntry>),
): NormalizedRouteModule<TEntry> {
  assertExactlyOneEntry(module)

  if ("graph" in module) {
    return {
      kind: "graph",
      entry: module.graph,
      config: module.config ?? {},
    }
  }

  return {
    kind: "workflow",
    entry: module.workflow,
    config: module.config ?? {},
  }
}

export function assertExactlyOneEntry<TEntry>(
  module: RouteModule<TEntry> | (GraphRouteModule<TEntry> & WorkflowRouteModule<TEntry>),
): asserts module is RouteModule<TEntry> {
  const hasGraph = "graph" in module
  const hasWorkflow = "workflow" in module

  if (hasGraph === hasWorkflow) {
    throw new Error(
      "Route modules must define exactly one primary executable entry: graph or workflow",
    )
  }
}
