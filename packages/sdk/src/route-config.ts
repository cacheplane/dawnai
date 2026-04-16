export type RouteKind = "graph" | "workflow"

export interface RouteConfig {
  readonly runtime?: "node" | "edge"
  readonly streaming?: boolean
  readonly tags?: readonly string[]
}
