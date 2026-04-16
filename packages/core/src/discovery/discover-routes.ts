import { readdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import type {
  DiscoverRoutesOptions,
  RouteDefinition,
  RouteEntryKind,
  RouteManifest,
} from "../types.js"
import { findDawnApp } from "./find-dawn-app.js"
import { loadAuthoringRouteDefinition } from "./load-authoring-route-definition.js"
import { isPrivateSegment, isRouteGroupSegment, toRouteSegments } from "./route-segments.js"

type PrimaryRouteFile = keyof typeof PRIMARY_ROUTE_FILES
type ExecutableRouteFile = keyof typeof EXECUTABLE_ROUTE_FILES

const EXECUTABLE_ROUTE_FILES = {
  "graph.ts": "graph",
  "page.tsx": "page",
  "workflow.ts": "workflow",
} as const satisfies Record<string, Exclude<RouteEntryKind, "route">>

const PRIMARY_ROUTE_FILES = {
  ...EXECUTABLE_ROUTE_FILES,
  "route.ts": "route",
} as const satisfies Record<string, RouteEntryKind>

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
  const entries = (await readdir(routeDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  const primaryEntries = entries.filter(
    (entry): entry is (typeof entries)[number] & { name: PrimaryRouteFile } =>
      entry.isFile() && hasPrimaryRouteFile(entry.name),
  )

  validateRouteEntries(
    routeDir,
    primaryEntries.map((entry) => entry.name),
  )

  const entryFiles = primaryEntries.map((primaryEntry) => primaryEntry.name)
  const entry = resolvePrimaryRouteEntry(entryFiles)

  if (!entry) {
    return null
  }

  const routeSegments = relative(routesDir, routeDir)
    .split(sep)
    .filter(Boolean)
    .filter((segment) => !isRouteGroupSegment(segment))

  if (entryFiles.includes("route.ts")) {
    const authoringDefinition = await loadAuthoringRouteDefinition(resolve(routeDir, "route.ts"))

    if (!authoringDefinition) {
      throw new Error(
        `Route definition ${resolve(routeDir, "route.ts")} must export a Dawn route definition`,
      )
    }

    return {
      boundEntryFile: authoringDefinition.executableFile,
      boundEntryKind: authoringDefinition.kind,
      id: toPathname(routeSegments),
      pathname: toPathname(routeSegments),
      entryKind: "route",
      entryFile: authoringDefinition.routeDefinitionFile,
      routeDir,
      segments: toRouteSegments(routeSegments),
    }
  }

  return {
    id: toPathname(routeSegments),
    pathname: toPathname(routeSegments),
    entryKind: PRIMARY_ROUTE_FILES[entry],
    entryFile: resolve(routeDir, entry),
    routeDir,
    segments: toRouteSegments(routeSegments),
  }
}

export function validateRouteEntries(routeDir: string, entryFiles: readonly string[]): void {
  const executableEntries = entryFiles.filter((entryFile): entryFile is ExecutableRouteFile =>
    isExecutableRouteFile(entryFile),
  )

  if (executableEntries.length === 0 && entryFiles.includes("route.ts")) {
    throw new Error(
      `Route directory ${routeDir} must define exactly one primary executable entry: graph.ts, workflow.ts, or page.tsx`,
    )
  }

  if (executableEntries.length <= 1) {
    return
  }

  throw new Error(
    `Route directory ${routeDir} has multiple primary entries: ${[...entryFiles].sort().join(", ")}`,
  )
}

function resolvePrimaryRouteEntry(
  entryFiles: readonly PrimaryRouteFile[],
): PrimaryRouteFile | null {
  const executableEntry = entryFiles.find(isExecutableRouteFile)

  if (executableEntry) {
    return executableEntry
  }

  return entryFiles[0] ?? null
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

function hasPrimaryRouteFile(fileName: string): fileName is PrimaryRouteFile {
  return Object.hasOwn(PRIMARY_ROUTE_FILES, fileName)
}

function isExecutableRouteFile(fileName: string): fileName is ExecutableRouteFile {
  return Object.hasOwn(EXECUTABLE_ROUTE_FILES, fileName)
}

function toPathname(routeSegments: readonly string[]): string {
  if (routeSegments.length === 0) {
    return "/"
  }

  return `/${routeSegments.join("/")}`
}
