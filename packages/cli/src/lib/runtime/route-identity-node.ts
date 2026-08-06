import { dirname, relative, sep } from "node:path"

import type { RouteIdentity } from "./route-identity.js"

export type RouteIdentityResult =
  | (RouteIdentity & {
      readonly ok: true
    })
  | {
      readonly ok: false
      readonly routePath: string
    }

/**
 * Derives a route's id and app-relative path from filesystem paths.
 *
 * Lives apart from `route-identity.ts` because `relative`/`sep` have no pure
 * equivalent worth hand-rolling, and this function is dynamic-path only (the
 * static manifest carries `routeId`/`routePath` as build-time literals). The
 * split keeps `node:path` out of the fetch graph, which reaches
 * `route-identity.ts` through `static-modules.ts`.
 */
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
