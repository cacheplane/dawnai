import { basename, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { findDawnApp } from "@dawn/core"
import { normalizeRouteModule } from "@dawn/langgraph"
import { createDawnContext } from "./dawn-context.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  formatErrorMessage,
  type RuntimeExecutionMode,
  type RuntimeExecutionResult,
} from "./result.js"
import {
  loadAuthoringRouteHandler,
  resolveAuthoringRouteDefinitionForTarget,
} from "./route-definition.js"
import { deriveRouteIdentity } from "./route-identity.js"
import { discoverToolDefinitions } from "./tool-discovery.js"
import { fileExists } from "./utils.js"

export interface ExecuteRouteOptions {
  readonly appRoot?: string
  readonly cwd?: string
  readonly input: unknown
  readonly routeFile: string
  readonly signal?: AbortSignal
}

export async function executeRoute(options: ExecuteRouteOptions): Promise<RuntimeExecutionResult> {
  const startedAt = Date.now()
  const discoveredApp = await discoverApp(options)

  if (!discoveredApp.ok) {
    return createRuntimeFailureResult({
      appRoot: null,
      executionSource: "in-process",
      kind: "app_discovery_error",
      message: discoveredApp.message,
      routePath: options.routeFile,
      startedAt,
    })
  }

  const appRoot = discoveredApp.appRoot
  const routeFile = resolveRouteFile({
    appRoot,
    routeFile: options.routeFile,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  })
  const routeMode = toRouteMode(routeFile)

  if (!routeMode) {
    const routeIdentity = deriveRouteIdentity({
      appRoot,
      routeFile,
      routesDir: discoveredApp.routesDir,
    })

    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file must end with graph.ts or workflow.ts: ${routeFile}`,
      routeId: routeIdentity.ok ? routeIdentity.routeId : null,
      routePath: routeIdentity.routePath,
      startedAt,
    })
  }

  const routeIdentity = deriveRouteIdentity({
    appRoot,
    routeFile,
    routesDir: discoveredApp.routesDir,
  })

  if (!routeIdentity.ok) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file is outside the configured appDir: ${routeFile}`,
      mode: routeMode,
      routePath: routeIdentity.routePath,
      startedAt,
    })
  }

  if (!(await fileExists(routeFile))) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file does not exist: ${routeFile}`,
      mode: routeMode,
      routeId: routeIdentity.routeId,
      routePath: routeIdentity.routePath,
      startedAt,
    })
  }

  return await executeRouteAtResolvedPath({
    appRoot,
    input: options.input,
    mode: routeMode,
    routeFile,
    routeId: routeIdentity.routeId,
    routePath: routeIdentity.routePath,
    ...(options.signal ? { signal: options.signal } : {}),
    startedAt,
  })
}

export async function executeResolvedRoute(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly mode: RuntimeExecutionMode
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
}): Promise<RuntimeExecutionResult> {
  const startedAt = Date.now()

  return await executeRouteAtResolvedPath({
    appRoot: options.appRoot,
    input: options.input,
    mode: options.mode,
    routeFile: options.routeFile,
    routeId: options.routeId,
    routePath: options.routePath,
    ...(options.signal ? { signal: options.signal } : {}),
    startedAt,
  })
}

function resolveRouteFile(options: {
  readonly appRoot: string
  readonly cwd?: string
  readonly routeFile: string
}): string {
  if (isAbsolute(options.routeFile)) {
    return resolve(options.routeFile)
  }

  if (options.routeFile.startsWith(".") || options.routeFile.startsWith("..")) {
    return resolve(options.cwd ?? process.cwd(), options.routeFile)
  }

  return resolve(options.appRoot, options.routeFile)
}

async function discoverApp(options: ExecuteRouteOptions): Promise<
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
    const app = await findDawnApp({
      ...(options.appRoot ? { appRoot: options.appRoot } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })

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

async function executeNormalizedEntry(
  mode: RuntimeExecutionMode,
  entry: unknown,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (mode === "workflow") {
    if (typeof entry !== "function") {
      throw new Error("Workflow entry must be a function")
    }

    return await entry(input, signal ? { signal } : undefined)
  }

  if (typeof entry === "function") {
    return await entry(input, signal ? { signal } : undefined)
  }

  if (
    typeof entry === "object" &&
    entry !== null &&
    "invoke" in entry &&
    typeof entry.invoke === "function"
  ) {
    return await entry.invoke(input, signal ? { signal } : undefined)
  }

  throw new Error("Graph entry must be a function or expose invoke(input)")
}

async function executeRouteAtResolvedPath(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly mode: RuntimeExecutionMode
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
  readonly startedAt: number
}): Promise<RuntimeExecutionResult> {
  let authoringDefinition: Awaited<ReturnType<typeof resolveAuthoringRouteDefinitionForTarget>>

  try {
    authoringDefinition = await resolveAuthoringRouteDefinitionForTarget(options.routeFile)
  } catch (error) {
    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: formatErrorMessage(error),
      mode: options.mode,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }

  if (authoringDefinition) {
    return await executeAuthoringRoute({
      ...options,
      route: authoringDefinition,
    })
  }

  try {
    await registerTsxLoader()
    const routeModule = await import(pathToFileURL(options.routeFile).href)
    const normalized = normalizeRouteModule(routeModule)

    if (normalized.kind !== options.mode) {
      return createRuntimeFailureResult({
        appRoot: options.appRoot,
        executionSource: "in-process",
        kind: "unsupported_route_boundary",
        message: `Expected ${options.mode} route at ${options.routeFile}, received ${normalized.kind}`,
        mode: options.mode,
        routeId: options.routeId,
        routePath: options.routePath,
        startedAt: options.startedAt,
      })
    }

    const output = await executeNormalizedEntry(
      normalized.kind,
      normalized.entry,
      options.input,
      options.signal,
    )

    return createRuntimeSuccessResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      mode: normalized.kind,
      output,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  } catch (error) {
    const kind = isUnsupportedBoundaryError(error)
      ? "unsupported_route_boundary"
      : "execution_error"

    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind,
      message: formatErrorMessage(error),
      mode: options.mode,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }
}

async function executeAuthoringRoute(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly mode: RuntimeExecutionMode
  readonly route: NonNullable<Awaited<ReturnType<typeof resolveAuthoringRouteDefinitionForTarget>>>
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
  readonly startedAt: number
}): Promise<RuntimeExecutionResult> {
  let tools: Awaited<ReturnType<typeof discoverToolDefinitions>>

  try {
    tools = await discoverToolDefinitions({
      appRoot: options.appRoot,
      routeDir: options.route.routeDir,
    })
  } catch (error) {
    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: formatErrorMessage(error),
      mode: options.mode,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }

  try {
    const handler = await loadAuthoringRouteHandler(options.route)

    const context = createDawnContext({
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const output =
      typeof handler === "function"
        ? await handler(options.input, context)
        : await handler.invoke(options.input, context)

    return createRuntimeSuccessResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      mode: options.route.kind,
      output,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  } catch (error) {
    const kind =
      error instanceof Error &&
      (error.message ===
        `Authoring ${options.route.kind} route at ${options.route.executableFile} must export a callable "${options.route.kind}" handler` ||
        error.message ===
          `Authoring graph route at ${options.route.executableFile} must export a callable "graph" handler or an object exposing invoke(input)`)
        ? "unsupported_route_boundary"
        : "execution_error"

    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind,
      message: formatErrorMessage(error),
      mode: options.route.kind,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }
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
