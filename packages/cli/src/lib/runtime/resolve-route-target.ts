import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { basename, resolve } from "node:path"

import { findDawnApp } from "@dawn/core"

import {
  createRuntimeFailureResult,
  formatErrorMessage,
  type RuntimeExecutionFailureResult,
  type RuntimeExecutionMode,
} from "./result.js"

export interface ResolveRouteTargetOptions {
  readonly cwd?: string
  readonly invocationCwd?: string
  readonly routePath: string
}

export interface ResolvedRouteTarget {
  readonly appRoot: string
  readonly mode: RuntimeExecutionMode
  readonly routeFile: string
}

export async function resolveRouteTarget(
  options: ResolveRouteTargetOptions,
): Promise<ResolvedRouteTarget | RuntimeExecutionFailureResult> {
  const discoveredApp = await discoverApp(options)

  if (!discoveredApp.ok) {
    return createRuntimeFailureResult({
      appRoot: null,
      kind: "app_discovery_error",
      message: discoveredApp.message,
    })
  }

  const routeFile = toRouteFilePath(options.routePath, {
    appRoot: discoveredApp.appRoot,
    ...(options.invocationCwd ? { invocationCwd: options.invocationCwd } : {}),
  })
  const mode = toRouteMode(routeFile)

  if (!mode) {
    return createRuntimeFailureResult({
      appRoot: discoveredApp.appRoot,
      kind: "route_resolution_error",
      message: `Route file must end with graph.ts or workflow.ts: ${routeFile}`,
    })
  }

  if (!(await fileExists(routeFile))) {
    return createRuntimeFailureResult({
      appRoot: discoveredApp.appRoot,
      kind: "route_resolution_error",
      message: `Route file does not exist: ${routeFile}`,
      mode,
    })
  }

  return {
    appRoot: discoveredApp.appRoot,
    mode,
    routeFile,
  }
}

async function discoverApp(options: ResolveRouteTargetOptions): Promise<
  | {
      readonly appRoot: string
      readonly ok: true
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
    }
  } catch (error) {
    return {
      message: formatErrorMessage(error),
      ok: false,
    }
  }
}

function toRouteFilePath(
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

function toRouteMode(routeFile: string): RuntimeExecutionMode | null {
  const routeName = basename(routeFile)

  if (routeName === "graph.ts") {
    return "graph"
  }

  if (routeName === "workflow.ts") {
    return "workflow"
  }

  return null
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}
