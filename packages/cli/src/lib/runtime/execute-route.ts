import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { findDawnApp } from "@dawn/core"
import { normalizeRouteModule } from "@dawn/langgraph"
import { registerTsxLoader } from "./register-tsx-loader.js"
import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  formatErrorMessage,
  type RuntimeExecutionMode,
  type RuntimeExecutionResult,
} from "./result.js"

export interface ExecuteRouteOptions {
  readonly appRoot?: string
  readonly cwd?: string
  readonly input: unknown
  readonly routeFile: string
}

export async function executeRoute(options: ExecuteRouteOptions): Promise<RuntimeExecutionResult> {
  const discoveredApp = await discoverApp(options)

  if (!discoveredApp.ok) {
    return createRuntimeFailureResult({
      appRoot: null,
      kind: "app_discovery_error",
      message: discoveredApp.message,
      routeFile: resolve(options.routeFile),
    })
  }

  const appRoot = discoveredApp.appRoot
  const routeFile = resolve(options.routeFile)
  const routeMode = toRouteMode(routeFile)

  if (!routeMode) {
    return createRuntimeFailureResult({
      appRoot,
      kind: "route_resolution_error",
      message: `Route file must end with graph.ts or workflow.ts: ${routeFile}`,
      routeFile,
    })
  }

  if (!(await fileExists(routeFile))) {
    return createRuntimeFailureResult({
      appRoot,
      kind: "route_resolution_error",
      message: `Route file does not exist: ${routeFile}`,
      mode: routeMode,
      routeFile,
    })
  }

  await registerTsxLoader()

  try {
    const routeModule = await import(pathToFileURL(routeFile).href)
    const normalized = normalizeRouteModule(routeModule)

    if (normalized.kind !== routeMode) {
      return createRuntimeFailureResult({
        appRoot,
        kind: "unsupported_route_boundary",
        message: `Expected ${routeMode} route at ${routeFile}, received ${normalized.kind}`,
        mode: routeMode,
        routeFile,
      })
    }

    const output = await executeNormalizedEntry(normalized.kind, normalized.entry, options.input)

    return createRuntimeSuccessResult({
      appRoot,
      mode: normalized.kind,
      output,
      routeFile,
    })
  } catch (error) {
    const kind = isUnsupportedBoundaryError(error)
      ? "unsupported_route_boundary"
      : "execution_error"

    return createRuntimeFailureResult({
      appRoot,
      kind,
      message: formatErrorMessage(error),
      mode: routeMode,
      routeFile,
    })
  }
}

async function discoverApp(options: ExecuteRouteOptions): Promise<
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
    const app = await findDawnApp({
      ...(options.appRoot ? { appRoot: options.appRoot } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })

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

async function executeNormalizedEntry(
  mode: RuntimeExecutionMode,
  entry: unknown,
  input: unknown,
): Promise<unknown> {
  if (mode === "workflow") {
    if (typeof entry !== "function") {
      throw new Error("Workflow entry must be a function")
    }

    return await entry(input)
  }

  if (typeof entry === "function") {
    return await entry(input)
  }

  if (
    typeof entry === "object" &&
    entry !== null &&
    "invoke" in entry &&
    typeof entry.invoke === "function"
  ) {
    return await entry.invoke(input)
  }

  throw new Error("Graph entry must be a function or expose invoke(input)")
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

function isUnsupportedBoundaryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message ===
      "Route modules must define exactly one primary executable entry: graph or workflow" ||
      error.message === "Workflow entry must be a function" ||
      error.message === "Graph entry must be a function or expose invoke(input)")
  )
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}
