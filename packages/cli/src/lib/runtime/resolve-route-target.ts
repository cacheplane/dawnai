import type { Stats } from "node:fs"
import { stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

import { findDawnApp } from "@dawn/core"
import {
  createRuntimeFailureResult,
  formatErrorMessage,
  type RuntimeExecutionFailureResult,
} from "./result.js"
import { deriveRouteIdentity } from "./route-identity.js"

export interface ResolveRouteTargetOptions {
  readonly cwd?: string
  readonly invocationCwd?: string
  readonly routePath: string
}

export interface ResolvedRouteTarget {
  readonly appRoot: string
  readonly routeId: string
  readonly routeFile: string
  readonly routePath: string
}

const LEGACY_BASENAMES = new Set(["workflow.ts", "graph.ts", "route.ts"])

export async function resolveRouteTarget(
  options: ResolveRouteTargetOptions,
): Promise<ResolvedRouteTarget | RuntimeExecutionFailureResult> {
  const startedAt = Date.now()
  const discoveredApp = await discoverApp(options)

  if (!discoveredApp.ok) {
    return createRuntimeFailureResult({
      appRoot: null,
      executionSource: "in-process",
      kind: "app_discovery_error",
      message: discoveredApp.message,
      routePath: options.routePath,
      startedAt,
    })
  }

  const rawTarget = toAbsolutePath(options.routePath, {
    appRoot: discoveredApp.appRoot,
    ...(options.invocationCwd ? { invocationCwd: options.invocationCwd } : {}),
  })

  let targetStat: Stats | null

  try {
    targetStat = await stat(rawTarget)
  } catch {
    targetStat = null
  }

  if (!targetStat) {
    return failure({
      appRoot: discoveredApp.appRoot,
      routesDir: discoveredApp.routesDir,
      routeFile: rawTarget,
      message: `Route target does not exist: ${rawTarget}`,
      startedAt,
    })
  }

  if (targetStat.isDirectory()) {
    const indexFile = resolve(rawTarget, "index.ts")
    let indexStat: Stats | null

    try {
      indexStat = await stat(indexFile)
    } catch {
      indexStat = null
    }

    if (!indexStat?.isFile()) {
      return failure({
        appRoot: discoveredApp.appRoot,
        routesDir: discoveredApp.routesDir,
        routeFile: rawTarget,
        message: `Route directory has no index.ts: ${rawTarget}`,
        startedAt,
      })
    }

    return ok({
      appRoot: discoveredApp.appRoot,
      routesDir: discoveredApp.routesDir,
      routeFile: indexFile,
    })
  }

  if (basename(rawTarget) !== "index.ts") {
    if (LEGACY_BASENAMES.has(basename(rawTarget))) {
      return failure({
        appRoot: discoveredApp.appRoot,
        routesDir: discoveredApp.routesDir,
        routeFile: rawTarget,
        message: `Route target must be a route directory or its index.ts: ${rawTarget}`,
        startedAt,
      })
    }

    return failure({
      appRoot: discoveredApp.appRoot,
      routesDir: discoveredApp.routesDir,
      routeFile: rawTarget,
      message: `Route target must be a route directory or its index.ts: ${rawTarget}`,
      startedAt,
    })
  }

  return ok({
    appRoot: discoveredApp.appRoot,
    routesDir: discoveredApp.routesDir,
    routeFile: rawTarget,
  })
}

function ok(options: {
  readonly appRoot: string
  readonly routesDir: string
  readonly routeFile: string
}): ResolvedRouteTarget | RuntimeExecutionFailureResult {
  const identity = deriveRouteIdentity({
    appRoot: options.appRoot,
    routeFile: options.routeFile,
    routesDir: options.routesDir,
  })

  if (!identity.ok) {
    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file is outside the configured appDir: ${options.routeFile}`,
      routePath: identity.routePath,
      startedAt: Date.now(),
    })
  }

  return {
    appRoot: options.appRoot,
    routeId: identity.routeId,
    routeFile: options.routeFile,
    routePath: identity.routePath,
  }
}

function failure(options: {
  readonly appRoot: string
  readonly routesDir: string
  readonly routeFile: string
  readonly message: string
  readonly startedAt: number
}): RuntimeExecutionFailureResult {
  const identity = deriveRouteIdentity({
    appRoot: options.appRoot,
    routeFile: options.routeFile,
    routesDir: options.routesDir,
  })

  return createRuntimeFailureResult({
    appRoot: options.appRoot,
    executionSource: "in-process",
    kind: "route_resolution_error",
    message: options.message,
    ...(identity.ok ? { routeId: identity.routeId } : {}),
    routePath: identity.routePath,
    startedAt: options.startedAt,
  })
}

async function discoverApp(options: ResolveRouteTargetOptions): Promise<
  | {
      readonly appRoot: string
      readonly ok: true
      readonly routesDir: string
    }
  | {
      readonly message: string
      readonly ok: false
    }
> {
  try {
    const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})

    return {
      appRoot: app.appRoot,
      ok: true,
      routesDir: app.routesDir,
    }
  } catch (error) {
    return {
      message: formatErrorMessage(error),
      ok: false,
    }
  }
}

function toAbsolutePath(
  routePath: string,
  options: {
    readonly appRoot: string
    readonly invocationCwd?: string
  },
): string {
  if (routePath.startsWith("./") || routePath.startsWith("../")) {
    return resolve(options.invocationCwd ?? process.cwd(), routePath)
  }

  return resolve(options.appRoot, routePath)
}
