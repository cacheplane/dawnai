import { dirname, relative, sep } from "node:path"

export interface RouteIdentity {
  readonly routeId: string
  readonly routePath: string
}

export function deriveRouteIdentity(options: {
  readonly appRoot: string
  readonly routeFile: string
  readonly routesDir: string
}): RouteIdentity {
  return {
    routeId: toRouteId(relative(options.routesDir, dirname(options.routeFile))),
    routePath: normalizePath(relative(options.appRoot, options.routeFile)),
  }
}

function toRouteId(relativeRouteDir: string): string {
  const normalizedRouteDir = normalizePath(relativeRouteDir)

  if (normalizedRouteDir === ".") {
    return "/"
  }

  return `/${normalizedRouteDir}`
}

function normalizePath(path: string): string {
  return path.split(sep).join("/")
}
