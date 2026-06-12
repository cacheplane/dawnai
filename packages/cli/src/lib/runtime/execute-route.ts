import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  applyCapabilities,
  type CapabilityContribution,
  createAgentsMdMarker,
  createCapabilityRegistry,
  createPlanningMarker,
  createSkillsMarker,
  createSubagentsMarker,
  createWorkspaceFs,
  createWorkspaceMarker,
  type DawnConfig,
  discoverRoutes,
  findDawnApp,
  loadDawnConfig,
  type ResolvedStateField,
  type RouteDefinition,
  type RouteManifest,
  resolveStateFields,
} from "@dawn-ai/core"
import {
  Command,
  defaultSummarize,
  defaultTokenCounter,
  executeAgent,
  type OffloadFn,
  OffloadStore,
  offloadToolOutput,
  type ResolvedSummarizationConfig,
  type SubagentResolver,
  streamAgent,
} from "@dawn-ai/langchain"
import {
  createPermissionsStore,
  type PermissionMode,
  type PermissionsStore,
} from "@dawn-ai/permissions"
import { type DawnAgent, isDawnAgent, type WorkspaceFs } from "@dawn-ai/sdk"
import { createThreadsStore, sqliteCheckpointer, type ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import { localFilesystem } from "@dawn-ai/workspace"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { checkToolNameUniqueness } from "./check-tool-name-uniqueness.js"
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

/**
 * Resolves the ThreadsStore for the given appRoot.
 *
 * Uses `config.threadsStore` if the user's `dawn.config.ts` provides one;
 * otherwise falls back to the default SQLite-backed store at
 * `<appRoot>/.dawn/threads.sqlite`. Exported so the HTTP server layer (T11+)
 * can obtain the same store instance independently of route execution.
 */
export async function resolveThreadsStore(appRoot: string): Promise<ThreadsStore> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.threadsStore) {
      return loaded.config.threadsStore
    }
  } catch {
    // No dawn.config.ts or unreadable — fall through to default.
  }
  return createThreadsStore({ path: join(appRoot, ".dawn/threads.sqlite") })
}

/**
 * Resolves the checkpointer for the given appRoot.
 *
 * Uses `config.checkpointer` if the user's `dawn.config.ts` provides one;
 * otherwise falls back to the default SQLite-backed saver at
 * `<appRoot>/.dawn/checkpoints.sqlite`. Exported so the HTTP server layer
 * (T11+) can obtain a checkpointer independently of route execution (e.g.
 * for the GET /threads/:id/state endpoint).
 */
export async function resolveCheckpointer(appRoot: string): Promise<BaseCheckpointSaver> {
  try {
    const loaded = await loadDawnConfig({ appRoot })
    if (loaded.config.checkpointer) {
      return loaded.config.checkpointer
    }
  } catch {
    // No dawn.config.ts or unreadable — fall through to default.
  }
  return sqliteCheckpointer({ path: join(appRoot, ".dawn/checkpoints.sqlite") })
}

/**
 * Invoke a resolved route with a stable thread ID, returning the final
 * execution result. Used by the AP `POST /threads/:id/runs/wait` endpoint.
 * Behaves identically to `executeResolvedRoute` but forwards `threadId` to
 * the agent-adapter so LangGraph parks state in the checkpointer.
 */
export async function invokeResolvedRoute(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
  readonly threadId?: string
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
  /**
   * When set, the agent-adapter receives `Command({resume: resumeDecision})`
   * as its input instead of the normal `input` field. Used by the resume
   * endpoint to replay a parked graph state after a permission interrupt.
   */
  readonly resumeDecision?: "once" | "always" | "deny"
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly signal?: AbortSignal
  /**
   * Stable per-conversation identifier forwarded to the agent-adapter as
   * LangGraph's `thread_id`. When set, `interrupt()` calls park graph
   * state in the checkpointer and the `/threads/:thread_id/resume`
   * endpoint can replay them.
   */
  readonly threadId?: string
}): AsyncGenerator<StreamChunk> {
  const prepared = await prepareRouteExecution(options)

  if (!prepared.ok) {
    yield { type: "done", output: { error: prepared.message } }
    return
  }

  const {
    normalized,
    tools,
    stateFields,
    promptFragments,
    streamTransformers,
    subagentResolver,
    checkpointer,
    offload,
    summarization,
    workspaceFs,
  } = prepared

  if (normalized.kind !== "agent") {
    // Non-agent routes don't support incremental streaming — execute and emit done
    const context = createDawnContext({
      ...(options.middlewareContext ? { middleware: options.middlewareContext } : {}),
      fs: workspaceFs,
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const output = await invokeEntry(normalized.kind, normalized.entry, options.input, context)
    yield { type: "done", output }
    return
  }

  const routeParamNames = extractRouteParamNames(options.routeId)

  // For resume runs, pass Command({resume}) directly to the agent-adapter so
  // LangGraph replays from the parked checkpoint state.
  const agentInput = options.resumeDecision
    ? new Command({ resume: options.resumeDecision })
    : options.input

  for await (const chunk of streamAgent({
    checkpointer,
    entry: normalized.entry,
    input: agentInput,
    ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
    routeParamNames,
    signal: options.signal ?? new AbortController().signal,
    ...(stateFields ? { stateFields } : {}),
    tools,
    ...(offload ? { offload } : {}),
    ...(summarization ? { summarization } : {}),
    ...(promptFragments && promptFragments.length > 0 ? { promptFragments } : {}),
    ...(streamTransformers && streamTransformers.length > 0 ? { streamTransformers } : {}),
    ...(subagentResolver ? { subagentResolver } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
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
      case "interrupt": {
        // The agent-adapter registers the pending entry in
        // pending-interrupts so the /threads/:thread_id/resume endpoint
        // can correlate the POST. We just forward the chunk to the SSE
        // consumer.
        yield { type: "interrupt", data: chunk.data }
        break
      }
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
  readonly checkpointer: BaseCheckpointSaver
  readonly threadsStore: ThreadsStore
  readonly offload?: OffloadFn
  readonly summarization?: ResolvedSummarizationConfig
  readonly stateFields: readonly ResolvedStateField[] | undefined
  readonly tools: readonly DiscoveredToolDefinition[]
  readonly promptFragments?: ReadonlyArray<NonNullable<CapabilityContribution["promptFragment"]>>
  readonly streamTransformers?: ReadonlyArray<
    NonNullable<CapabilityContribution["streamTransformers"]>[number]
  >
  readonly subagentResolver?: SubagentResolver
  readonly workspaceFs: WorkspaceFs
}

interface PreparedRouteError {
  readonly message: string
  readonly ok: false
}

async function prepareRouteExecution(options: {
  readonly appRoot: string
  readonly routeFile: string
  readonly routeId: string
  readonly signal?: AbortSignal
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

  let subagentResolver: SubagentResolver | undefined

  // Load dawn.config.ts once — used for checkpointer, threadsStore, backends,
  // and permissions. Falls back to defaults when the config is absent/unreadable.
  let configBackends:
    | { readonly filesystem?: FilesystemBackend; readonly exec?: ExecBackend }
    | undefined
  let permissionsConfig:
    | {
        readonly mode?: PermissionMode
        readonly allow?: Readonly<Record<string, readonly string[]>>
        readonly deny?: Readonly<Record<string, readonly string[]>>
      }
    | undefined
  let configCheckpointer: BaseCheckpointSaver | undefined
  let configThreadsStore: ThreadsStore | undefined
  let loadedDawnConfig: DawnConfig | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot: options.appRoot })
    loadedDawnConfig = loaded.config
    configBackends = loaded.config.backends
    permissionsConfig = loaded.config.permissions
    configCheckpointer = loaded.config.checkpointer
    configThreadsStore = loaded.config.threadsStore
  } catch {
    // No dawn.config.ts (or unreadable). Fall back to defaults for all fields.
  }

  const offload = buildOffload(
    loadedDawnConfig,
    configBackends?.filesystem,
    options.signal ?? new AbortController().signal,
    options.appRoot,
  )

  let summarization: ResolvedSummarizationConfig | undefined

  const checkpointer: BaseCheckpointSaver =
    configCheckpointer ??
    sqliteCheckpointer({ path: join(options.appRoot, ".dawn/checkpoints.sqlite") })

  const threadsStore: ThreadsStore =
    configThreadsStore ??
    createThreadsStore({ path: join(options.appRoot, ".dawn/threads.sqlite") })

  // Deliberately outside the agent-only branch below: every route kind needs
  // the loaded store for ctx.fs permission gating, and createWorkspaceFs
  // requires it loaded. The agent branch reuses this store in applyCapabilities.
  const envMode = process.env.DAWN_PERMISSIONS_MODE
  const mode: PermissionMode =
    envMode === "interactive" || envMode === "non-interactive" || envMode === "bypass"
      ? envMode
      : (permissionsConfig?.mode ?? "interactive")

  const permissionsStore: PermissionsStore = createPermissionsStore({
    appRoot: options.appRoot,
    config: permissionsConfig
      ? {
          version: 1,
          allow: permissionsConfig.allow ?? {},
          deny: permissionsConfig.deny ?? {},
        }
      : undefined,
    mode,
  })
  await permissionsStore.load()

  const workspaceFs = createWorkspaceFs({
    workspaceRoot: join(options.appRoot, "workspace"),
    backend: configBackends?.filesystem ?? localFilesystem(),
    permissions: permissionsStore,
    signal: options.signal ?? new AbortController().signal,
    interruptCapable: normalized.kind === "agent",
  })

  if (normalized.kind === "agent") {
    const registry = createCapabilityRegistry([
      createPlanningMarker(),
      createAgentsMdMarker(),
      createSkillsMarker(),
      createSubagentsMarker(),
      createWorkspaceMarker(),
    ])
    const routeManifest = await discoverRoutes({ appRoot: options.appRoot })
    const descriptor =
      normalized.kind === "agent" && isDawnAgent(normalized.entry) ? normalized.entry : undefined

    summarization = buildSummarization(loadedDawnConfig, descriptor?.model)

    // Build (or reuse) the descriptor->routeId identity map used by the
    // subagents marker to resolve `agent({ subagents: [imported] })` overrides.
    // The cache is keyed on the manifest object identity: stable across
    // requests in production (one manifest per CLI invocation), naturally
    // invalidated in dev when the runtime rebuilds the manifest.
    const descriptorRouteMap = await getCachedDescriptorRouteMap(routeManifest)

    const applied = await applyCapabilities(registry, routeDir, {
      routeManifest,
      descriptor,
      descriptorRouteMap,
      ...(configBackends ? { backends: configBackends } : {}),
      permissions: permissionsStore,
      appRoot: options.appRoot,
    })

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
          const overridable = (t as unknown as { overridable?: boolean }).overridable
          capTools.push({
            ...(t.description !== undefined ? { description: t.description } : {}),
            filePath: `<capability:${t.name}>`,
            name: t.name,
            ...(overridable ? { overridable: true } : {}),
            run: t.run,
            ...(t.schema !== undefined ? { schema: t.schema } : {}),
            scope: "route-local",
          } as DiscoveredToolDefinition)
        }
      }
      if (contribution.stateFields) capStateFields.push(...contribution.stateFields)
      if (contribution.promptFragment) capPromptFragments.push(contribution.promptFragment)
      if (contribution.streamTransformers)
        capStreamTransformers.push(...contribution.streamTransformers)
    }

    // Conflict detection (user tool shadowing capability tool or reserved name)
    const RESERVED_TOOL_NAMES = new Set(["task"]) // names auto-generated by capabilities
    const check = checkToolNameUniqueness({
      userTools: tools.map((t) => ({ name: t.name })),
      capabilityTools: capTools.map((t) => ({
        name: t.name,
        ...((t as unknown as { overridable?: boolean }).overridable ? { overridable: true } : {}),
      })),
      reservedNames: RESERVED_TOOL_NAMES,
    })
    if (!check.ok) {
      return { message: check.message, ok: false }
    }

    // Use the effective set so overridden tools are dropped before merging.
    const effectiveCapNames = new Set(check.effectiveCapabilityTools.map((t) => t.name))
    const filteredCapTools = capTools.filter((t) => effectiveCapNames.has(t.name))

    const userStateNames = new Set((stateFields ?? []).map((f) => f.name))
    for (const f of capStateFields) {
      if (userStateNames.has(f.name)) {
        return {
          message: `Capability conflict: state field "${f.name}" is contributed by a capability and also declared in state.ts. Remove the field from state.ts or remove the capability marker file.`,
          ok: false,
        }
      }
    }

    tools = [...tools, ...filteredCapTools]
    stateFields = stateFields ? [...stateFields, ...capStateFields] : capStateFields
    promptFragments = capPromptFragments
    streamTransformers = capStreamTransformers

    // Build a resolver only when this route actually has subagents — either
    // by convention (<routeDir>/subagents/*) or by descriptor.subagents override.
    const hasTaskTool = capTools.some((t) => t.name === "task")
    if (hasTaskTool) {
      subagentResolver = buildSubagentResolver({
        appRoot: options.appRoot,
        routeDir,
        routeManifest,
        descriptor,
        descriptorRouteMap,
      })
    }
  }

  // Inject ctx.fs once here so every downstream invoker (createDawnContext,
  // the langchain tool converter/loop) hands tools the sandboxed handle.
  tools = tools.map((t) => ({
    ...t,
    run: (
      input: unknown,
      ctx: {
        readonly middleware?: Readonly<Record<string, unknown>>
        readonly signal: AbortSignal
      },
    ) => t.run(input, { ...ctx, fs: workspaceFs }),
  }))

  return {
    normalized,
    ok: true,
    checkpointer,
    threadsStore,
    ...(offload ? { offload } : {}),
    ...(summarization ? { summarization } : {}),
    ...(promptFragments.length > 0 ? { promptFragments } : {}),
    stateFields,
    ...(streamTransformers.length > 0 ? { streamTransformers } : {}),
    ...(subagentResolver ? { subagentResolver } : {}),
    tools,
    workspaceFs,
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
  readonly threadId?: string
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

    const {
      normalized,
      tools,
      stateFields,
      promptFragments,
      streamTransformers,
      subagentResolver,
      checkpointer,
      offload,
      summarization,
      workspaceFs,
    } = prepared
    mode = normalized.kind

    const context = createDawnContext({
      ...(options.middlewareContext ? { middleware: options.middlewareContext } : {}),
      fs: workspaceFs,
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const output = await invokeEntry(normalized.kind, normalized.entry, options.input, context, {
      checkpointer,
      ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
      routeId: options.routeId,
      ...(stateFields ? { stateFields } : {}),
      tools,
      ...(offload ? { offload } : {}),
      ...(summarization ? { summarization } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(promptFragments && promptFragments.length > 0 ? { promptFragments } : {}),
      ...(streamTransformers && streamTransformers.length > 0 ? { streamTransformers } : {}),
      ...(subagentResolver ? { subagentResolver } : {}),
      ...(options.threadId ? { threadId: options.threadId } : {}),
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
    readonly checkpointer?: BaseCheckpointSaver
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly offload?: OffloadFn
    readonly summarization?: ResolvedSummarizationConfig
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
    readonly subagentResolver?: SubagentResolver
    readonly threadId?: string
  },
): Promise<unknown> {
  if (kind === "agent") {
    if (!agentContext?.checkpointer) {
      throw new Error(
        "[dawn] invokeEntry called for an agent route without a checkpointer. This is an internal bug — please report it.",
      )
    }
    const routeParamNames = extractRouteParamNames(agentContext?.routeId ?? "")
    return await executeAgent({
      checkpointer: agentContext.checkpointer,
      entry,
      input,
      ...(agentContext?.middlewareContext
        ? { middlewareContext: agentContext.middlewareContext }
        : {}),
      routeParamNames,
      signal: agentContext?.signal ?? new AbortController().signal,
      ...(agentContext?.stateFields ? { stateFields: agentContext.stateFields } : {}),
      tools: agentContext?.tools ?? [],
      ...(agentContext?.offload ? { offload: agentContext.offload } : {}),
      ...(agentContext?.summarization ? { summarization: agentContext.summarization } : {}),
      ...(agentContext?.promptFragments && agentContext.promptFragments.length > 0
        ? { promptFragments: agentContext.promptFragments }
        : {}),
      ...(agentContext?.streamTransformers && agentContext.streamTransformers.length > 0
        ? { streamTransformers: agentContext.streamTransformers }
        : {}),
      ...(agentContext?.subagentResolver
        ? { subagentResolver: agentContext.subagentResolver }
        : {}),
      ...(agentContext?.threadId ? { threadId: agentContext.threadId } : {}),
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

/**
 * Dynamically imports each route's entry file and records descriptor->routeId
 * for any default export that satisfies `isDawnAgent`. Used so the subagents
 * capability marker can resolve `descriptor.subagents: [...]` override entries
 * back to a routeId.
 *
 * Cost: this opens every agent route module in the manifest. Acceptable for
 * the current scale; if it becomes hot, cache by (appRoot, manifest-hash).
 */
let descriptorRouteMapCache = new WeakMap<RouteManifest, Promise<ReadonlyMap<DawnAgent, string>>>()

async function getCachedDescriptorRouteMap(
  manifest: RouteManifest,
): Promise<ReadonlyMap<DawnAgent, string>> {
  let promise = descriptorRouteMapCache.get(manifest)
  if (!promise) {
    promise = buildDescriptorRouteMap(manifest)
    descriptorRouteMapCache.set(manifest, promise)
  }
  return promise
}

export { getCachedDescriptorRouteMap }

/**
 * Test-only: reset the WeakMap-backed cache. Not exported via the package
 * barrel — internal to this module's test suite.
 */
export function __resetDescriptorRouteMapCacheForTests(): void {
  descriptorRouteMapCache = new WeakMap()
}

async function buildDescriptorRouteMap(
  manifest: RouteManifest,
): Promise<ReadonlyMap<DawnAgent, string>> {
  const map = new Map<DawnAgent, string>()
  await Promise.all(
    manifest.routes.map(async (route) => {
      try {
        const mod = (await import(pathToFileURL(route.entryFile).href)) as { default?: unknown }
        if (isDawnAgent(mod.default)) {
          map.set(mod.default, route.id)
        }
      } catch {
        // Best-effort: skip routes whose module fails to import.
      }
    }),
  )
  return map
}

/**
 * Builds the subagentResolver passed into streamAgent/executeAgent. Given a
 * leaf name (e.g. "researcher"), the resolver returns:
 *   - the child route's id
 *   - a graph object whose .invoke(input, config) re-enters executeResolvedRoute
 *
 * Resolution order:
 *   1. Convention: route at `<routeDir>/subagents/<leaf>`
 *   2. Override: descriptor.subagents[i] whose routeId's last segment === leaf
 *
 * The returned graph exposes both `invoke` (one-shot) and `dawnStream`
 * (yields Dawn StreamChunks). The dispatcher prefers `dawnStream` so
 * intermediate child events (tool calls, tokens, capability events) bubble
 * up to the parent stream as `subagent.<type>` envelopes.
 */
function buildSubagentResolver(args: {
  readonly appRoot: string
  readonly routeDir: string
  readonly routeManifest: RouteManifest
  readonly descriptor: DawnAgent | undefined
  readonly descriptorRouteMap: ReadonlyMap<DawnAgent, string>
}): SubagentResolver {
  const { appRoot, routeDir, routeManifest, descriptor, descriptorRouteMap } = args

  const findConventionRoute = (leaf: string): RouteDefinition | undefined => {
    const conventionDir = `${routeDir}/subagents/${leaf}`
    return routeManifest.routes.find((r) => r.routeDir === conventionDir)
  }

  const findOverrideRoute = (leaf: string): RouteDefinition | undefined => {
    for (const desc of descriptor?.subagents ?? []) {
      const routeId = descriptorRouteMap.get(desc)
      if (!routeId) continue
      const route = routeManifest.routes.find((r) => r.id === routeId)
      if (!route) continue
      const lastSegment = route.segments.at(-1)
      const lastName =
        typeof lastSegment === "string"
          ? lastSegment
          : (lastSegment?.raw ?? route.id.replace(/^\//, ""))
      if (lastName === leaf) return route
    }
    return undefined
  }

  return (leafName: string) => {
    const route = findConventionRoute(leafName) ?? findOverrideRoute(leafName)
    if (!route) return undefined

    const graph = {
      invoke: async (input: unknown, _config: unknown): Promise<unknown> => {
        // Re-enter the same runtime; capabilities are re-applied for the
        // child route. The dispatcher passes `{messages: [HumanMessage]}` —
        // forward verbatim as the child's input so the agent-route path
        // sees the protocol shape it expects.
        const result = await executeResolvedRoute({
          appRoot,
          input,
          routeFile: route.entryFile,
          routeId: route.id,
          routePath: route.pathname,
        })
        if (result.status === "failed") {
          // Surface the failure to the dispatcher in a shape that
          // extractFinalText can survive; the dispatcher wraps it.
          throw new Error(result.error.message)
        }
        // executeAgent's output for an agent-kind route is the raw
        // LangGraph state ({messages, ...}). Forward as-is.
        return result.output
      },
      // Stream child events so the parent stream can bubble subagent.*
      // envelopes for intermediate tool calls, tokens, and capability events.
      dawnStream: async function* (input: unknown, _config: unknown) {
        for await (const chunk of streamResolvedRoute({
          appRoot,
          input,
          routeFile: route.entryFile,
          routeId: route.id,
          routePath: route.pathname,
        })) {
          yield chunk
        }
      },
    }

    return { routeId: route.id, graph }
  }
}

function buildOffload(
  config: DawnConfig | undefined,
  filesystem: FilesystemBackend | undefined,
  signal: AbortSignal,
  appRoot?: string,
): OffloadFn | undefined {
  const workspaceRoot = join(appRoot ?? process.cwd(), "workspace")
  if (!existsSync(workspaceRoot)) return undefined
  const t = config?.toolOutput ?? {}
  const store = new OffloadStore({
    backend: filesystem ?? localFilesystem(),
    workspaceRoot,
    signal,
    maxBytes: t.maxBytes ?? 268_435_456,
    ttlMs: t.ttlMs ?? 10_800_000,
    gcThrottleMs: t.gcThrottleMs ?? 10_000,
  })
  const thresholdChars = t.offloadThresholdChars ?? 40_000
  const previewLines = t.previewLines ?? 10
  const exempt = exemptToolSet(t.noOffloadTools)
  return (content, toolName, toolCallId) => {
    // Retrieval/inspection tools (readFile, listDir, …) must never be
    // offloaded: their output IS the content the agent asked to read, so
    // re-offloading it would replace it with another pointer and make the
    // offloaded data permanently unreadable.
    if (exempt.has(toolName)) return Promise.resolve(content)
    return offloadToolOutput(content, {
      toolName,
      thresholdChars,
      previewLines,
      store,
      ...(toolCallId ? { toolCallId } : {}),
    })
  }
}

function buildSummarization(
  config: DawnConfig | undefined,
  routeModel: string | undefined,
): ResolvedSummarizationConfig | undefined {
  const s = config?.summarization
  if (!s?.enabled) return undefined
  const model = s.model ?? routeModel
  if (!model) return undefined // no model to summarize with — cannot enable
  return {
    maxTokens: s.maxTokens ?? 12_000,
    keepRecentTurns: s.keepRecentTurns ?? 6,
    model,
    tokenCounter: s.tokenCounter ?? defaultTokenCounter,
    // The core config types `messages` as `readonly unknown[]` because
    // @dawn-ai/core cannot depend on @langchain/core. At runtime these are
    // BaseMessage instances, so the cast to SummarizeFn is sound.
    summarize:
      (s.summarize as unknown as ResolvedSummarizationConfig["summarize"] | undefined) ??
      defaultSummarize,
  }
}

/**
 * Tool names whose output is never offloaded: the built-in retrieval/inspection
 * tools (always exempt) unioned with any caller-provided names. Exported for
 * unit testing.
 */
export function exemptToolSet(noOffloadTools?: readonly string[]): ReadonlySet<string> {
  return new Set<string>(["readFile", "listDir", ...(noOffloadTools ?? [])])
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
