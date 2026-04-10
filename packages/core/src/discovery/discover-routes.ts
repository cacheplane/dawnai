import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { findDawnApp } from "./find-dawn-app.js";
import { isPrivateSegment, isRouteGroupSegment, toRouteSegments } from "./route-segments.js";
import type {
  DiscoverRoutesOptions,
  RouteDefinition,
  RouteEntryKind,
  RouteManifest,
} from "../types.js";

type PrimaryRouteFile = keyof typeof PRIMARY_ROUTE_FILES;

const PRIMARY_ROUTE_FILES = {
  "graph.ts": "graph",
  "page.tsx": "page",
  "route.ts": "route",
  "workflow.ts": "workflow",
} as const satisfies Record<string, RouteEntryKind>;

export async function discoverRoutes(options: DiscoverRoutesOptions = {}): Promise<RouteManifest> {
  const app = await findDawnApp(options);
  const routes = validateRouteCollisions(await collectRouteDefinitions(app.routesDir));

  return {
    appRoot: app.appRoot,
    routes: routes.sort((left, right) => left.pathname.localeCompare(right.pathname)),
  };
}

async function collectRouteDefinitions(routesDir: string): Promise<RouteDefinition[]> {
  const discovered: RouteDefinition[] = [];

  await walkRouteTree(routesDir, routesDir, discovered);

  return discovered;
}

async function walkRouteTree(
  routesDir: string,
  currentDir: string,
  discovered: RouteDefinition[],
): Promise<void> {
  const routeEntry = await readRouteEntry(routesDir, currentDir);

  if (routeEntry) {
    discovered.push(routeEntry);
  }

  const entries = await readdir(currentDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !isPrivateSegment(entry.name))
      .map((entry) => walkRouteTree(routesDir, join(currentDir, entry.name), discovered)),
  );
}

async function readRouteEntry(routesDir: string, routeDir: string): Promise<RouteDefinition | null> {
  const entries = await readdir(routeDir, { withFileTypes: true });
  const primaryEntries = entries.filter(
    (entry): entry is (typeof entries)[number] & { name: PrimaryRouteFile } =>
      entry.isFile() && hasPrimaryRouteFile(entry.name),
  );

  validateRouteEntries(routeDir, primaryEntries.map((entry) => entry.name));

  const entry = primaryEntries[0];

  if (!entry) {
    return null;
  }

  const routeSegments = relative(routesDir, routeDir)
    .split(sep)
    .filter(Boolean)
    .filter((segment) => !isRouteGroupSegment(segment));

  return {
    id: toPathname(routeSegments),
    pathname: toPathname(routeSegments),
    entryKind: PRIMARY_ROUTE_FILES[entry.name],
    entryFile: resolve(routeDir, entry.name),
    routeDir,
    segments: toRouteSegments(routeSegments),
  };
}

export function validateRouteEntries(routeDir: string, entryFiles: readonly string[]): void {
  if (entryFiles.length <= 1) {
    return;
  }

  throw new Error(`Route directory ${routeDir} has multiple primary entries: ${entryFiles.join(", ")}`);
}

function validateRouteCollisions(routes: readonly RouteDefinition[]): RouteDefinition[] {
  const byPathname = new Map<string, RouteDefinition>();

  for (const route of routes) {
    const existingRoute = byPathname.get(route.pathname);

    if (existingRoute) {
      throw new Error(
        `Duplicate Dawn route pathname "${route.pathname}" detected at ${existingRoute.routeDir} and ${route.routeDir}`,
      );
    }

    byPathname.set(route.pathname, route);
  }

  return [...routes];
}

function hasPrimaryRouteFile(fileName: string): fileName is PrimaryRouteFile {
  return Object.hasOwn(PRIMARY_ROUTE_FILES, fileName);
}

function toPathname(routeSegments: readonly string[]): string {
  if (routeSegments.length === 0) {
    return "/";
  }

  return `/${routeSegments.join("/")}`;
}
