/**
 * Route identity primitives that carry no `node:` imports — this module sits
 * on the fetch graph (reached via `static-modules.ts`). The filesystem-derived
 * counterpart, `deriveRouteIdentity`, lives in `route-identity-node.ts`.
 */

export interface RouteIdentity {
  readonly routeId: string
  readonly routePath: string
}

export function createRouteAssistantId(
  routeId: string,
  mode: "agent" | "chain" | "graph" | "workflow",
): string {
  return `${routeId}#${mode}`
}
