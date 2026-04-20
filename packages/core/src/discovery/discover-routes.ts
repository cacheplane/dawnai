import { readdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { RouteKind } from "@dawn/sdk"
import type { DiscoverRoutesOptions, RouteDefinition, RouteManifest } from "../types.js"
import { findDawnApp } from "./find-dawn-app.js"
import { isPrivateSegment, isRouteGroupSegment, toRouteSegments } from "./route-segments.js"

const INDEX_FILE = "index.ts"

let loaderPromise: Promise<void> | undefined

export async function discoverRoutes(options: DiscoverRoutesOptions = {}): Promise<RouteManifest> {
  const app = await findDawnApp(options)
  const routes = validateRouteCollisions(await collectRouteDefinitions(app.routesDir))

  return {
    appRoot: app.appRoot,
    routes: routes.sort((left, right) => left.pathname.localeCompare(right.pathname)),
  }
}

async function collectRouteDefinitions(routesDir: string): Promise<RouteDefinition[]> {
  const discovered: RouteDefinition[] = []

  await walkRouteTree(routesDir, routesDir, discovered)

  return discovered
}

async function walkRouteTree(
  routesDir: string,
  currentDir: string,
  discovered: RouteDefinition[],
): Promise<void> {
  const routeEntry = await readRouteEntry(routesDir, currentDir)

  if (routeEntry) {
    discovered.push(routeEntry)
  }

  const entries = (await readdir(currentDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )

  for (const entry of entries) {
    if (!entry.isDirectory() || isPrivateSegment(entry.name)) {
      continue
    }

    await walkRouteTree(routesDir, join(currentDir, entry.name), discovered)
  }
}

async function readRouteEntry(
  routesDir: string,
  routeDir: string,
): Promise<RouteDefinition | null> {
  const entries = await readdir(routeDir, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return null
  }

  const hasIndex = entries.some((entry) => entry.isFile() && entry.name === INDEX_FILE)

  if (!hasIndex) {
    return null
  }

  const indexFile = resolve(routeDir, INDEX_FILE)
  const kind = await inferRouteKind(indexFile)

  if (!kind) {
    return null
  }

  const routeSegments = relative(routesDir, routeDir)
    .split(sep)
    .filter(Boolean)
    .filter((segment) => !isRouteGroupSegment(segment))

  return {
    id: toPathname(routeSegments),
    pathname: toPathname(routeSegments),
    kind,
    entryFile: indexFile,
    routeDir,
    segments: toRouteSegments(routeSegments),
  }
}

async function inferRouteKind(indexFile: string): Promise<RouteKind | null> {
  await registerTsxLoader()
  const routeExports = await loadRouteExports(indexFile)
  const hasChain = "chain" in routeExports && routeExports.chain !== undefined
  const hasGraph = "graph" in routeExports && routeExports.graph !== undefined
  const hasWorkflow = "workflow" in routeExports && routeExports.workflow !== undefined

  const count = [hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(`Route index.ts must export exactly one of "workflow", "graph", or "chain"`)
  }

  if (hasChain) {
    return "chain"
  }

  if (hasGraph) {
    return "graph"
  }

  if (hasWorkflow) {
    return "workflow"
  }

  return null
}

async function loadRouteExports(indexFile: string): Promise<{
  readonly chain?: unknown
  readonly graph?: unknown
  readonly workflow?: unknown
}> {
  try {
    return (await import(pathToFileURL(indexFile).href)) as {
      readonly chain?: unknown
      readonly graph?: unknown
      readonly workflow?: unknown
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Failed to load route at ${indexFile}: ${reason}`, { cause })
  }
}

async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= (async () => {
    const { register } = (await import("tsx/esm/api")) as {
      readonly register: () => unknown
    }
    register()
  })()
  await loaderPromise
}

function validateRouteCollisions(routes: readonly RouteDefinition[]): RouteDefinition[] {
  const byPathname = new Map<string, RouteDefinition>()

  for (const route of routes) {
    const existingRoute = byPathname.get(route.pathname)

    if (existingRoute) {
      throw new Error(
        `Duplicate Dawn route pathname "${route.pathname}" detected at ${existingRoute.routeDir} and ${route.routeDir}`,
      )
    }

    byPathname.set(route.pathname, route)
  }

  return [...routes]
}

function toPathname(routeSegments: readonly string[]): string {
  if (routeSegments.length === 0) {
    return "/"
  }

  return `/${routeSegments.join("/")}`
}
