import type { RouteSegment } from "../types.js"

export function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")")
}

export function isPrivateSegment(segment: string): boolean {
  return segment.startsWith("_")
}

export function toRouteSegments(routeSegments: readonly string[]): RouteSegment[] {
  return routeSegments.map((segment) => parseRouteSegment(segment))
}

function parseRouteSegment(segment: string): RouteSegment {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return {
      kind: "optional-catchall",
      name: segment.slice(5, -2),
      raw: segment,
    }
  }

  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return {
      kind: "catchall",
      name: segment.slice(4, -1),
      raw: segment,
    }
  }

  if (segment.startsWith("[") && segment.endsWith("]")) {
    return {
      kind: "dynamic",
      name: segment.slice(1, -1),
      raw: segment,
    }
  }

  return {
    kind: "static",
    raw: segment,
  }
}
