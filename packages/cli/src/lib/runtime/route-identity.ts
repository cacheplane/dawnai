import { dirname, relative, sep } from "node:path"

export interface RouteIdentity {
  readonly routeId: string
  readonly routePath: string
}

export function createRouteAssistantId(
  routeId: string,
  mode: "chain" | "graph" | "workflow",
): string {
  return `${routeId}#${mode}`
}

export type RouteIdentityResult =
  | (RouteIdentity & {
      readonly ok: true
    })
  | {
      readonly ok: false
      readonly routePath: string
    }

export function deriveRouteIdentity(options: {
  readonly appRoot: string
  readonly routeFile: string
  readonly routesDir: string
}): RouteIdentityResult {
  const routePath = normalizePath(relative(options.appRoot, options.routeFile))
  const relativeRouteDirSegments = relative(options.routesDir, dirname(options.routeFile))
    .split(sep)
    .filter(Boolean)

  if (relativeRouteDirSegments.includes("..")) {
    return {
      ok: false,
      routePath,
    }
  }

  return {
    ok: true,
    routeId: toRouteId(relativeRouteDirSegments.filter((segment) => !isRouteGroupSegment(segment))),
    routePath,
  }
}

function toRouteId(routeSegments: readonly string[]): string {
  if (routeSegments.length === 0) {
    return "/"
  }

  return `/${routeSegments.join("/")}`
}

function normalizePath(path: string): string {
  return path.split(sep).join("/")
}

function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")")
}
