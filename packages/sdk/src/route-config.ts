export type RouteKind = "agent" | "chain" | "graph" | "workflow"

export interface RouteConfig {
  readonly runtime?: "node" | "edge"
  readonly streaming?: boolean
  readonly tags?: readonly string[]
}
