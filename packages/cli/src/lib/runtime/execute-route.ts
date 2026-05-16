import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import {
  applyCapabilities,
  type CapabilityContribution,
  createAgentsMdMarker,
  createCapabilityRegistry,
  createPlanningMarker,
  findDawnApp,
  type ResolvedStateField,
  resolveStateFields,
} from "@dawn-ai/core"
import { executeAgent, streamAgent } from "@dawn-ai/langchain"
import { createDawnContext } from "./dawn-context.js"
import { normalizeRouteModule } from "./load-route-kind.js"
import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  formatErrorMessage,
  type RuntimeExecutionMode,
  type RuntimeExecutionResult,
} from "./result.js"
import { deriveRouteIdentity } from "./route-identity.js"
import { discoverStateDefinition } from "./state-discovery.js"
import type { StreamChunk } from "./stream-types.js"
import {
  type DiscoveredToolDefinition,
  discoverToolDefinitions,
  injectGeneratedSchemas,
} from "./tool-discovery.js"
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

  const identity = deriveRouteIdentity({
    appRoot,
    routeFile,
    routesDir: discoveredApp.routesDir,
  })

  if (!identity.ok) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file is outside the configured appDir: ${routeFile}`,
      routePath: identity.routePath,
      startedAt,
    })
  }

  if (!(await fileExists(routeFile))) {
    return createRuntimeFailureResult({
      appRoot,
      executionSource: "in-process",
      kind: "route_resolution_error",
      message: `Route file does not exist: ${routeFile}`,
      routeId: identity.routeId,
      routePath: identity.routePath,
      startedAt,
    })
  }

  return await executeRouteAtResolvedPath({
    appRoot,
    input: options.input,
    routeFile,
    routeId: identity.routeId,
    routePath: identity.routePath,
    ...(options.signal ? { signal: options.signal } : {}),
    startedAt,
  })
}

export async function executeResolvedRoute(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
}): Promise<RuntimeExecutionResult> {
  return await executeRouteAtResolvedPath({
    ...options,
    startedAt: Date.now(),
  })
}

export async function* streamResolvedRoute(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
}): AsyncGenerator<StreamChunk> {
  const prepared = await prepareRouteExecution(options)

  if (!prepared.ok) {
    yield { type: "done", output: { error: prepared.message } }
    return
  }

  const { normalized, tools, stateFields, promptFragments, streamTransformers } = prepared

  if (normalized.kind !== "agent") {
    // Non-agent routes don't support incremental streaming — execute and emit done
    const context = createDawnContext({
      ...(options.middlewareContext ? { middleware: options.middlewareContext } : {}),
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const output = await invokeEntry(normalized.kind, normalized.entry, options.input, context)
    yield { type: "done", output }
    return
  }

  const routeParamNames = extractRouteParamNames(options.routeId)

  for await (const chunk of streamAgent({
    entry: normalized.entry,
    input: options.input,
    ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
    routeParamNames,
    signal: options.signal ?? new AbortController().signal,
    ...(stateFields ? { stateFields } : {}),
    tools,
    ...(promptFragments && promptFragments.length > 0 ? { promptFragments } : {}),
    ...(streamTransformers && streamTransformers.length > 0 ? { streamTransformers } : {}),
  })) {
    switch (chunk.type) {
      case "token":
        yield { type: "chunk", data: chunk.data }
        break
      case "tool_call": {
        const tc = chunk.data as { name: string; input: unknown }
        yield { type: "tool_call", name: tc.name, input: tc.input }
        break
      }
      case "tool_result": {
        const tr = chunk.data as { name: string; output: unknown }
        yield { type: "tool_result", name: tr.name, output: tr.output }
        break
      }
      case "done":
        yield { type: "done", output: chunk.data }
        break
      default: {
        // Capability-contributed event types (e.g. plan_update from the planning capability).
        // The langchain layer widened AgentStreamChunk["type"] to allow arbitrary strings;
        // pass them through verbatim with their literal type as the SSE event name.
        yield { type: chunk.type, data: chunk.data }
        break
      }
    }
  }
}

interface PreparedRoute {
  readonly normalized: {
    readonly kind: "agent" | "chain" | "graph" | "workflow"
    readonly entry: unknown
  }
  readonly ok: true
  readonly stateFields: readonly ResolvedStateField[] | undefined
  readonly tools: readonly DiscoveredToolDefinition[]
  readonly promptFragments?: ReadonlyArray<NonNullable<CapabilityContribution["promptFragment"]>>
  readonly streamTransformers?: ReadonlyArray<
    NonNullable<CapabilityContribution["streamTransformers"]>[number]
  >
}

interface PreparedRouteError {
  readonly message: string
  readonly ok: false
}

async function prepareRouteExecution(options: {
  readonly appRoot: string
  readonly routeFile: string
  readonly routeId: string
}): Promise<PreparedRoute | PreparedRouteError> {
  const routeDir = resolve(options.routeFile, "..")

  const normalized = await normalizeRouteModule(options.routeFile)

  const discoveredTools = await discoverToolDefinitions({
    appRoot: options.appRoot,
    routeDir,
  })

  // Inject codegen-generated schemas for tools without explicit schema exports
  const routeId =
    options.routeId.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") ||
    "index"
  const schemaManifestPath = join(options.appRoot, ".dawn", "routes", routeId, "tools.json")
  let tools = discoveredTools
  if (existsSync(schemaManifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(schemaManifestPath, "utf-8")) as Record<
        string,
        unknown
      >
      tools = injectGeneratedSchemas(discoveredTools, manifest)
    } catch {
      // Generated schema is best-effort — fall through on parse errors
    }
  }

  let stateFields: readonly ResolvedStateField[] | undefined
  if (normalized.kind === "agent") {
    const stateDefinition = await discoverStateDefinition({ routeDir })
    if (stateDefinition) {
      stateFields = resolveStateFields({
        defaults: stateDefinition.defaults,
        reducerOverrides: stateDefinition.reducerOverrides,
      })
    }
  }

  // Apply capability markers (planning, etc.). Only for agent routes.
  let promptFragments: ReadonlyArray<NonNullable<CapabilityContribution["promptFragment"]>> = []
  let streamTransformers: ReadonlyArray<
    NonNullable<CapabilityContribution["streamTransformers"]>[number]
  > = []

  if (normalized.kind === "agent") {
    const registry = createCapabilityRegistry([createPlanningMarker(), createAgentsMdMarker()])
    const applied = await applyCapabilities(registry, routeDir)

    if (applied.errors.length > 0) {
      const messages = applied.errors
        .map((e) => `[${e.markerName}#${e.phase}] ${e.message}`)
        .join("\n  ")
      return { message: `Capability error during route prep:\n  ${messages}`, ok: false }
    }

    const capTools: DiscoveredToolDefinition[] = []
    const capStateFields: ResolvedStateField[] = []
    const capPromptFragments: NonNullable<CapabilityContribution["promptFragment"]>[] = []
    const capStreamTransformers: NonNullable<
      CapabilityContribution["streamTransformers"]
    >[number][] = []

    for (const { contribution } of applied.contributions) {
      if (contribution.tools) {
        for (const t of contribution.tools) {
          // Adapt capability-contributed tools (which lack filePath/scope)
          // into the DiscoveredToolDefinition shape used by the runtime.
          capTools.push({
            ...(t.description !== undefined ? { description: t.description } : {}),
            filePath: `<capability:${t.name}>`,
            name: t.name,
            run: t.run,
            ...(t.schema !== undefined ? { schema: t.schema } : {}),
            scope: "route-local",
          })
        }
      }
      if (contribution.stateFields) capStateFields.push(...contribution.stateFields)
      if (contribution.promptFragment) capPromptFragments.push(contribution.promptFragment)
      if (contribution.streamTransformers)
        capStreamTransformers.push(...contribution.streamTransformers)
    }

    // Conflict detection
    const userToolNames = new Set(tools.map((t) => t.name))
    const userStateNames = new Set((stateFields ?? []).map((f) => f.name))
    for (const t of capTools) {
      if (userToolNames.has(t.name)) {
        return {
          message: `Capability conflict: tool "${t.name}" is contributed by a capability and also defined in tools/. Remove the file in tools/ or remove the capability marker file.`,
          ok: false,
        }
      }
    }
    for (const f of capStateFields) {
      if (userStateNames.has(f.name)) {
        return {
          message: `Capability conflict: state field "${f.name}" is contributed by a capability and also declared in state.ts. Remove the field from state.ts or remove the capability marker file.`,
          ok: false,
        }
      }
    }

    tools = [...tools, ...capTools]
    stateFields = stateFields ? [...stateFields, ...capStateFields] : capStateFields
    promptFragments = capPromptFragments
    streamTransformers = capStreamTransformers
  }

  return {
    normalized,
    ok: true,
    ...(promptFragments.length > 0 ? { promptFragments } : {}),
    stateFields,
    ...(streamTransformers.length > 0 ? { streamTransformers } : {}),
    tools,
  }
}

async function executeRouteAtResolvedPath(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
  readonly startedAt: number
}): Promise<RuntimeExecutionResult> {
  let mode: RuntimeExecutionMode | null = null

  try {
    const prepared = await prepareRouteExecution(options)

    if (!prepared.ok) {
      return createRuntimeFailureResult({
        appRoot: options.appRoot,
        executionSource: "in-process",
        kind: "execution_error",
        message: prepared.message,
        mode,
        routeId: options.routeId,
        routePath: options.routePath,
        startedAt: options.startedAt,
      })
    }

    const { normalized, tools, stateFields, promptFragments, streamTransformers } = prepared
    mode = normalized.kind

    const context = createDawnContext({
      ...(options.middlewareContext ? { middleware: options.middlewareContext } : {}),
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const output = await invokeEntry(normalized.kind, normalized.entry, options.input, context, {
      ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
      routeId: options.routeId,
      ...(stateFields ? { stateFields } : {}),
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(promptFragments && promptFragments.length > 0 ? { promptFragments } : {}),
      ...(streamTransformers && streamTransformers.length > 0 ? { streamTransformers } : {}),
    })

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
    const kind = isBoundaryError(error) ? "unsupported_route_boundary" : "execution_error"
    const message = formatErrorMessage(error)

    return createRuntimeFailureResult({
      appRoot: options.appRoot,
      executionSource: "in-process",
      kind,
      message,
      mode,
      routeId: options.routeId,
      routePath: options.routePath,
      startedAt: options.startedAt,
    })
  }
}

async function invokeEntry(
  kind: "agent" | "chain" | "graph" | "workflow",
  entry: unknown,
  input: unknown,
  context: unknown,
  agentContext?: {
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly routeId: string
    readonly signal?: AbortSignal
    readonly stateFields?: readonly ResolvedStateField[]
    readonly tools: ReadonlyArray<{
      readonly description?: string
      readonly name: string
      readonly run: (
        input: unknown,
        context: {
          readonly middleware?: Readonly<Record<string, unknown>>
          readonly signal: AbortSignal
        },
      ) => Promise<unknown> | unknown
      readonly schema?: unknown
    }>
    readonly promptFragments?: ReadonlyArray<NonNullable<CapabilityContribution["promptFragment"]>>
    readonly streamTransformers?: ReadonlyArray<
      NonNullable<CapabilityContribution["streamTransformers"]>[number]
    >
  },
): Promise<unknown> {
  if (kind === "agent") {
    const routeParamNames = extractRouteParamNames(agentContext?.routeId ?? "")
    return await executeAgent({
      entry,
      input,
      ...(agentContext?.middlewareContext
        ? { middlewareContext: agentContext.middlewareContext }
        : {}),
      routeParamNames,
      signal: agentContext?.signal ?? new AbortController().signal,
      ...(agentContext?.stateFields ? { stateFields: agentContext.stateFields } : {}),
      tools: agentContext?.tools ?? [],
      ...(agentContext?.promptFragments && agentContext.promptFragments.length > 0
        ? { promptFragments: agentContext.promptFragments }
        : {}),
      ...(agentContext?.streamTransformers && agentContext.streamTransformers.length > 0
        ? { streamTransformers: agentContext.streamTransformers }
        : {}),
    })
  }

  if (kind === "workflow") {
    if (typeof entry !== "function") {
      throw new Error("Workflow entry must be a function")
    }
    return await entry(input, context)
  }

  if (kind === "chain") {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "invoke" in entry &&
      typeof (entry as { invoke?: unknown }).invoke === "function"
    ) {
      return await (entry as { invoke: (input: unknown) => unknown }).invoke(input)
    }
    throw new Error("Chain entry must expose invoke(input)")
  }

  if (typeof entry === "function") {
    return await entry(input, context)
  }

  if (
    typeof entry === "object" &&
    entry !== null &&
    "invoke" in entry &&
    typeof (entry as { invoke?: unknown }).invoke === "function"
  ) {
    return await (entry as { invoke: (input: unknown, context: unknown) => unknown }).invoke(
      input,
      context,
    )
  }

  throw new Error("Graph entry must be a function or expose invoke(input)")
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

function extractRouteParamNames(routeId: string): string[] {
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  return [...matches].map((match) => match[1]).filter((s): s is string => s !== undefined)
}

function isBoundaryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    /must export exactly one of/.test(error.message) ||
    /exports neither/.test(error.message) ||
    error.message === "Workflow entry must be a function" ||
    error.message === "Graph entry must be a function or expose invoke(input)" ||
    error.message === "Chain entry must expose invoke(input)"
  )
}
