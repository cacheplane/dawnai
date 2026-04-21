import { relative, sep } from "node:path"

import { discoverRoutes, type RouteManifest } from "@dawn/core"
import {
  createRuntimeFailureResult,
  formatErrorMessage,
  type RuntimeExecutionFailureResult,
} from "./result.js"

export interface ResolveRouteTargetOptions {
  readonly cwd?: string
  readonly routePath: string
}

export interface ResolvedRouteTarget {
  readonly appRoot: string
  readonly routeId: string
  readonly routeFile: string
  readonly routePath: string
}

export async function resolveRouteTarget(
  options: ResolveRouteTargetOptions,
): Promise<ResolvedRouteTarget | RuntimeExecutionFailureResult> {
  const startedAt = Date.now()

  let manifest: RouteManifest

  try {
    manifest = await discoverRoutes(options.cwd ? { cwd: options.cwd } : {})
  } catch (error) {
    return createRuntimeFailureResult({
      appRoot: null,
      executionSource: "in-process",
      kind: "app_discovery_error",
      message: formatErrorMessage(error),
      routePath: options.routePath,
      startedAt,
    })
  }

  const normalizedPathname = normalizePathname(options.routePath)
  const route = manifest.routes.find((candidate) => candidate.pathname === normalizedPathname)

  if (!route) {
    const available = manifest.routes.map((r) => r.pathname)
    const availableList =
      available.length > 0
        ? `\n\nAvailable routes:\n${available.map((p) => `  ${p}`).join("\n")}`
        : ""

    return createRuntimeFailureResult({
      appRoot: manifest.appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route not found: ${normalizedPathname}${availableList}`,
      routePath: options.routePath,
      startedAt,
    })
  }

  return {
    appRoot: manifest.appRoot,
    routeId: route.id,
    routeFile: route.entryFile,
    routePath: relative(manifest.appRoot, route.entryFile).split(sep).join("/"),
  }
}

function normalizePathname(input: string): string {
  if (input.startsWith("/")) {
    return input
  }

  return `/${input}`
}
