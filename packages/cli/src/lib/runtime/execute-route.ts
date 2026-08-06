import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  applyCapabilities,
  type CapabilityContribution,
  createAgentsMdMarker,
  createCapabilityRegistry,
  createMemoryMarker,
  createMemoryMdMarker,
  createPlanningMarker,
  createSkillsMarker,
  createSubagentsMarker,
  createWorkspaceFs,
  createWorkspaceMarker,
  type DawnConfig,
  discoverRoutes,
  findDawnApp,
  loadDawnConfig,
  type MemoryStoreLike,
  type ResolvedStateField,
  type RouteDefinition,
  type RouteManifest,
  resolveStateFields,
  resolveToolScope,
  toolOrigin,
  wrapToolWithApproval,
  wrapToolWithConstraint,
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
import { routeNamespaceKey } from "@dawn-ai/memory"
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
import { type LoadedRouteMemory, loadRouteMemory } from "./load-memory.js"
import { type NormalizedRouteModule, normalizeRouteModule } from "./load-route-kind.js"
import { nodeMarkerFs } from "./node-marker-fs.js"
import { buildMemoryContext, resolveMemoryStore, resolveMemoryWrites } from "./resolve-memory.js"
import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  formatErrorMessage,
  type RuntimeExecutionMode,
  type RuntimeExecutionResult,
} from "./result.js"
import { deriveRouteIdentity } from "./route-identity.js"
import type { SandboxManager } from "./sandbox-manager.js"
import { discoverStateDefinition } from "./state-discovery.js"
import type { DawnStaticModules } from "./static-modules.js"
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

export type RouteResumePayload =
  | "once"
  | "always"
  | "deny"
  | Readonly<Record<string, "once" | "always" | "deny">>

export function toAgentInput(input: unknown, resume?: RouteResumePayload): unknown {
  return resume === undefined ? input : new Command({ resume })
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

/**
 * Boot-resolved instances (optional, additive). When the HTTP layer passes
 * them, `prepareRouteExecution` skips its per-request fallback constructions
 * (sqlite opens) and its per-request permissions `load()`. When absent,
 * behavior is exactly as before — the testing harness drives
 * `streamResolvedRoute` directly with no stores and must stay unchanged.
 *
 * `permissionsStore` accepts either a loaded store (production: one boot-time
 * read) or an async factory (dev: re-load `.dawn/permissions.json` on every
 * request so HITL "Always" grants written mid-process still apply — the one
 * deliberate per-request read kept).
 *
 * `memoryStore` is a lazy, memoized thunk (not an instance): the fetch
 * handler builds one `getMemoryStore()` at boot, shared by the
 * `/memory/candidates*` HTTP routes and, when threaded down here, by the
 * memory capability — so the store opens at most once per process, on first
 * use, instead of once at boot (unconditionally) plus once per request.
 *
 * `routeManifest` is the boot-time manifest (the runtime registry's). When
 * threaded, no request re-walks the route tree, and the manifest's stable
 * object identity keeps the descriptor-route-map WeakMap warm. When absent
 * (harness direct-call path), a per-appRoot process-lifetime memo performs
 * the walk once instead of once per request.
 *
 * `staticModules` is the build-time module manifest, when the server booted
 * from one. When threaded, the subagents descriptor maps are derived from it
 * with zero entry-file imports (`getCachedStaticDescriptorMaps`) — the
 * static path's replacement for `buildDescriptorRouteMap`'s per-route
 * dynamic imports.
 *
 * Subagent turns inherit these instances from the dispatching turn (see
 * `buildSubagentResolver`'s `bootInstances`): whatever the HTTP layer
 * resolved at boot is what every child re-entry uses too. In particular,
 * under `permissionsMode: "boot"` the parent and its subagents share ONE
 * mutable PermissionsStore — a child's `addAllow` ("Always" grant) is
 * immediately visible to the parent and its later turns. That sharing is
 * deliberate: it matches the process-wide `.dawn/permissions.json` semantics
 * the per-request path has always had, without the per-child re-read.
 */
interface BootResolvedInstances {
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly memoryStore?: () => Promise<MemoryStoreLike>
  readonly routeManifest?: RouteManifest
  readonly staticModules?: DawnStaticModules
}

export async function executeResolvedRoute(
  options: BootResolvedInstances & {
    readonly appRoot: string
    readonly input: unknown
    readonly isSubagent?: boolean
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
    readonly sandboxManager?: SandboxManager
    /**
     * Sandbox scoping key, decoupled from the checkpoint `threadId`. Subagent
     * dispatch sets this to the PARENT thread id so the child resolves the same
     * SandboxHandle without inheriting the parent's LangGraph checkpoint thread.
     */
    readonly sandboxThreadId?: string
    readonly signal?: AbortSignal
    readonly threadId?: string
  },
): Promise<RuntimeExecutionResult> {
  return await executeRouteAtResolvedPath({
    ...options,
    isSubagent: options.isSubagent ?? false,
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
 * Resolves a loaded PermissionsStore for the given appRoot: config-seeded
 * allow/deny + mode (env override wins), with `.dawn/permissions.json` read
 * once via `load()`. Exported so the HTTP server layer can build the store at
 * boot (production) or per request via a factory (dev — keeps HITL "Always"
 * grants written mid-process fresh). Construction is identical to what
 * `prepareRouteExecution` does when no store is provided.
 */
export async function resolvePermissionsStore(appRoot: string): Promise<PermissionsStore> {
  let permissionsConfig: DawnConfig["permissions"] | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    permissionsConfig = loaded.config.permissions
  } catch {
    // No dawn.config.ts or unreadable — fall through to defaults.
  }
  return await buildPermissionsStore(appRoot, permissionsConfig)
}

/** Shared permissions-store construction: config + env-mode resolution + one `load()`. */
async function buildPermissionsStore(
  appRoot: string,
  permissionsConfig: DawnConfig["permissions"] | undefined,
): Promise<PermissionsStore> {
  const envMode = process.env.DAWN_PERMISSIONS_MODE
  const mode: PermissionMode =
    envMode === "interactive" || envMode === "non-interactive" || envMode === "bypass"
      ? envMode
      : (permissionsConfig?.mode ?? "interactive")

  const store = createPermissionsStore({
    appRoot,
    config: permissionsConfig
      ? {
          version: 1,
          allow: permissionsConfig.allow ?? {},
          deny: permissionsConfig.deny ?? {},
        }
      : undefined,
    mode,
  })
  await store.load()
  return store
}

/**
 * Invoke a resolved route with a stable thread ID, returning the final
 * execution result. Used by the AP `POST /threads/:id/runs/wait` endpoint.
 * Behaves identically to `executeResolvedRoute` but forwards `threadId` to
 * the agent-adapter so LangGraph parks state in the checkpointer.
 */
export async function invokeResolvedRoute(
  options: BootResolvedInstances & {
    readonly appRoot: string
    readonly input: unknown
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
    readonly sandboxManager?: SandboxManager
    /** Sandbox scoping key override — see `executeResolvedRoute`. */
    readonly sandboxThreadId?: string
    readonly signal?: AbortSignal
    readonly threadId?: string
  },
): Promise<RuntimeExecutionResult> {
  return await executeRouteAtResolvedPath({
    ...options,
    startedAt: Date.now(),
  })
}

export async function* streamResolvedRoute(
  options: BootResolvedInstances & {
    readonly appRoot: string
    readonly input: unknown
    readonly isSubagent?: boolean
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    /**
     * When set, the agent-adapter receives `Command({resume})`
     * as its input instead of the normal `input` field. Used by the resume
     * endpoint to replay a parked graph state after a permission interrupt.
     */
    readonly resume?: RouteResumePayload
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
    readonly sandboxManager?: SandboxManager
    /** Sandbox scoping key override — see `executeResolvedRoute`. */
    readonly sandboxThreadId?: string
    readonly signal?: AbortSignal
    /**
     * Stable per-conversation identifier forwarded to the agent-adapter as
     * LangGraph's `thread_id`. When set, `interrupt()` calls park graph
     * state in the checkpointer and the `/threads/:thread_id/resume`
     * endpoint can replay them.
     */
    readonly threadId?: string
  },
): AsyncGenerator<StreamChunk> {
  const prepared = await prepareRouteExecution({
    ...options,
    isSubagent: options.isSubagent ?? false,
  })

  if (!prepared.ok) {
    throw new Error(prepared.message)
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
    sandboxed,
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

  const agentInput = toAgentInput(options.input, options.resume)

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
    ...(sandboxed ? { sandboxed: true } : {}),
  })) {
    switch (chunk.type) {
      case "token":
        yield { type: "chunk", data: chunk.data }
        break
      case "tool_call": {
        const tc = chunk.data as { id?: string; name: string; input: unknown }
        yield {
          type: "tool_call",
          ...(tc.id ? { id: tc.id } : {}),
          name: tc.name,
          input: tc.input,
        }
        break
      }
      case "tool_result": {
        const tr = chunk.data as { id?: string; name: string; output: unknown }
        yield {
          type: "tool_result",
          ...(tr.id ? { id: tr.id } : {}),
          name: tr.name,
          output: tr.output,
        }
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
  /** The store the route's permission gates consult this request (provided, factory-produced, or freshly constructed). */
  readonly permissionsStore: PermissionsStore
  /**
   * True when a per-thread sandbox is active for this turn (sandboxManager +
   * threadId resolved a handle). The agent-adapter uses this to bypass its
   * materialized-agent cache so tools bound to this thread's sandbox backends
   * are never reused for another thread.
   */
  readonly sandboxed?: boolean
}

interface PreparedRouteError {
  readonly message: string
  readonly ok: false
}

/**
 * The per-route module payload: everything `prepareRouteExecution` loads from
 * disk that is stable for the process lifetime. Loaded lazily on a route's
 * first request and cached per process; the dev child restart (tool/state/
 * reducer/route edits) is the invalidation. PR 2 (static wiring) pre-seeds
 * this cache from a generated manifest via `seedPreparedRouteModules` — a
 * fully-populated entry short-circuits every dynamic load below.
 */
export interface PreparedRouteModules {
  /** Normalized route module (kind + entry), from `normalizeRouteModule`. */
  readonly module: NormalizedRouteModule
  /**
   * Discovered tool definitions with generated `tools.json` schemas already
   * injected — the exact pre-capability, pre-wrap set `prepareRouteExecution`
   * derives per request today. Never mutated downstream (all later stages
   * produce new arrays).
   */
  readonly tools: readonly DiscoveredToolDefinition[]
  /** Resolved state.ts fields (agent routes only; undefined otherwise). */
  readonly stateFields: readonly ResolvedStateField[] | undefined
  /** The route's memory.ts descriptor, or null when none exists. */
  readonly memory: LoadedRouteMemory | null
}

/**
 * Per-process caches, keyed by absolute route entry file (module payloads)
 * and appRoot (route manifest). Promises are cached so concurrent first
 * requests share one load; rejections are evicted so a transient load error
 * (e.g. a syntax error mid-edit in dev) does not poison the process.
 */
const preparedRouteModulesCache = new Map<string, Promise<PreparedRouteModules>>()
const routeManifestCache = new Map<string, Promise<RouteManifest>>()
const workspaceDirProbeCache = new Map<string, boolean>()

/**
 * Default filesystem backend, constructed at most once per process and only
 * when a request actually needs it (no sandbox/config backend provided).
 * Always constructed options-free, so the instance carries no per-app or
 * per-request state — one shared instance is safe, and it is deliberately
 * NOT cleared by `__resetRouteLoadCachesForTests` (nothing about it can go
 * stale).
 */
let defaultLocalFilesystem: FilesystemBackend | undefined
function getDefaultLocalFilesystem(): FilesystemBackend {
  defaultLocalFilesystem ??= localFilesystem()
  return defaultLocalFilesystem
}

/**
 * `workspace/` existence probe for the offload store, memoizing only
 * POSITIVE results per appRoot: the runtime never un-creates a workspace
 * dir, so `true` is stable for the process lifetime. Negative results are
 * re-probed on every request (one `existsSync` until the dir appears, zero
 * after) because agent tools can create `workspace/` mid-process
 * (`localFilesystem.writeFile` mkdirs recursively) and the dev watcher
 * deliberately ignores workspace/ changes — no restart would refresh a
 * cached `false`. Internal; exported for tests only. Reset via
 * `__resetRouteLoadCachesForTests`.
 */
export function hasWorkspaceDir(appRoot: string): boolean {
  if (workspaceDirProbeCache.get(appRoot)) return true
  const present = existsSync(join(appRoot, "workspace"))
  if (present) workspaceDirProbeCache.set(appRoot, present)
  return present
}

function getPreparedRouteModules(options: {
  readonly appRoot: string
  readonly routeFile: string
  readonly routeId: string
}): Promise<PreparedRouteModules> {
  const cached = preparedRouteModulesCache.get(options.routeFile)
  if (cached) return cached
  const loading = loadPreparedRouteModules(options)
  preparedRouteModulesCache.set(options.routeFile, loading)
  loading.catch(() => preparedRouteModulesCache.delete(options.routeFile))
  return loading
}

async function loadPreparedRouteModules(options: {
  readonly appRoot: string
  readonly routeFile: string
  readonly routeId: string
}): Promise<PreparedRouteModules> {
  const routeDir = resolve(options.routeFile, "..")

  const normalized = await normalizeRouteModule(options.routeFile, options.appRoot)

  const discoveredTools = await discoverToolDefinitions({
    appRoot: options.appRoot,
    routeDir,
  })

  // Inject codegen-generated schemas for tools without explicit schema exports
  const routeSlug =
    options.routeId.replace(/^\//, "").replace(/\//g, "-").replace(/\[/g, "").replace(/\]/g, "") ||
    "index"
  const schemaManifestPath = join(options.appRoot, ".dawn", "routes", routeSlug, "tools.json")
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

  const memoryFile = join(routeDir, "memory.ts")
  const memory =
    normalized.kind === "agent" && existsSync(memoryFile) ? await loadRouteMemory(memoryFile) : null

  return { memory, module: normalized, stateFields, tools }
}

/** Route-tree walk, once per appRoot per process — the no-boot-manifest fallback. */
function discoverRoutesOncePerAppRoot(appRoot: string): Promise<RouteManifest> {
  const cached = routeManifestCache.get(appRoot)
  if (cached) return cached
  const loading = discoverRoutes({ appRoot })
  routeManifestCache.set(appRoot, loading)
  loading.catch(() => routeManifestCache.delete(appRoot))
  return loading
}

/**
 * Pre-populate the per-route module cache — the PR 2 static-wiring seam. A
 * build-time generator hands the runtime fully-loaded entries (keyed by
 * absolute route entry file) before any request; every dynamic load in
 * `prepareRouteExecution` is then skipped for the seeded routes.
 */
export function seedPreparedRouteModules(entries: ReadonlyMap<string, PreparedRouteModules>): void {
  for (const [routeFile, prepared] of entries) {
    preparedRouteModulesCache.set(routeFile, Promise.resolve(prepared))
  }
}

/**
 * Test-only: clear the per-route module and per-appRoot manifest caches so
 * suites that mutate a fixture app mid-process (new tools, changed routes)
 * observe the change on the next load. Mirrors `__clearDawnConfigCacheForTests`.
 */
export function __resetRouteLoadCachesForTests(): void {
  preparedRouteModulesCache.clear()
  routeManifestCache.clear()
  workspaceDirProbeCache.clear()
}

export async function prepareRouteExecution(
  options: BootResolvedInstances & {
    readonly appRoot: string
    readonly isSubagent?: boolean
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
    readonly signal?: AbortSignal
    readonly threadId?: string
    readonly sandboxManager?: SandboxManager
    /**
     * Sandbox scoping key, decoupled from `threadId` (the checkpoint identity).
     * When absent, the sandbox handle falls back to `threadId` — the top-route
     * case, where the two identities coincide.
     */
    readonly sandboxThreadId?: string
  },
): Promise<PreparedRoute | PreparedRouteError> {
  const { isSubagent = false } = options
  const routeDir = resolve(options.routeFile, "..")

  // Route module, tools (with generated schemas), state fields, and memory.ts
  // load once per route per process (lazily, on the route's first request) —
  // see PreparedRouteModules. Everything below this block stays per-request:
  // it depends on live state (permissions, sandbox handles, capability
  // markers like AGENTS.md/memory.md whose per-turn re-reads are deliberate).
  const prepared = await getPreparedRouteModules({
    appRoot: options.appRoot,
    routeFile: options.routeFile,
    routeId: options.routeId,
  })
  const normalized = prepared.module
  let tools = prepared.tools
  let stateFields = prepared.stateFields

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

  // When a SandboxManager is configured and we have a stable thread id, resolve
  // the thread's sandbox handle and route the workspace filesystem/exec (and the
  // workspace root) into it. All of readFile/writeFile/listDir/runBash redirect
  // into the isolated env with no capability-logic change.
  let sandboxBackends: { filesystem: FilesystemBackend; exec: ExecBackend } | undefined
  let sandboxWorkspaceRoot: string | undefined
  const sandboxKey = options.sandboxThreadId ?? options.threadId
  if (options.sandboxManager && sandboxKey) {
    const handle = await options.sandboxManager.getForThread(
      sandboxKey,
      options.signal ?? new AbortController().signal,
    )
    sandboxBackends = { filesystem: handle.filesystem, exec: handle.exec }
    sandboxWorkspaceRoot = handle.workspaceRoot
  }

  const offload = buildOffload(
    loadedDawnConfig,
    sandboxBackends?.filesystem ?? configBackends?.filesystem,
    options.signal ?? new AbortController().signal,
    options.appRoot,
  )

  let summarization: ResolvedSummarizationConfig | undefined

  // Boot-resolved instances win when provided (no per-request sqlite open);
  // otherwise fall back to config, then to the default sqlite stores.
  const checkpointer: BaseCheckpointSaver =
    options.checkpointer ??
    configCheckpointer ??
    sqliteCheckpointer({ path: join(options.appRoot, ".dawn/checkpoints.sqlite") })

  const threadsStore: ThreadsStore =
    options.threadsStore ??
    configThreadsStore ??
    createThreadsStore({ path: join(options.appRoot, ".dawn/threads.sqlite") })

  // Deliberately outside the agent-only branch below: every route kind needs
  // the loaded store for ctx.fs permission gating, and createWorkspaceFs
  // requires it loaded. The agent branch reuses this store in applyCapabilities.
  // A provided instance (production boot) is used as-is; a provided factory
  // (dev) re-loads `.dawn/permissions.json` each request so HITL "Always"
  // grants written mid-process still apply; absent both, construct+load fresh
  // (the pre-existing per-request behavior).
  const providedPermissions = options.permissionsStore
  const permissionsStore: PermissionsStore =
    typeof providedPermissions === "function"
      ? await providedPermissions()
      : (providedPermissions ?? (await buildPermissionsStore(options.appRoot, permissionsConfig)))

  const workspaceFs = createWorkspaceFs({
    workspaceRoot: sandboxWorkspaceRoot ?? join(options.appRoot, "workspace"),
    backend:
      sandboxBackends?.filesystem ?? configBackends?.filesystem ?? getDefaultLocalFilesystem(),
    permissions: permissionsStore,
    signal: options.signal ?? new AbortController().signal,
    interruptCapable: normalized.kind === "agent",
  })

  if (normalized.kind === "agent") {
    const registry = createCapabilityRegistry([
      createPlanningMarker(),
      createAgentsMdMarker(),
      createMemoryMdMarker(),
      createMemoryMarker(),
      createSkillsMarker(),
      createSubagentsMarker(),
      createWorkspaceMarker(),
    ])
    // Boot manifest when threaded (HTTP layer / subagent re-entry); otherwise
    // one walk per appRoot per process — never one per request.
    const routeManifest =
      options.routeManifest ?? (await discoverRoutesOncePerAppRoot(options.appRoot))
    const descriptor =
      normalized.kind === "agent" && isDawnAgent(normalized.entry) ? normalized.entry : undefined

    summarization = buildSummarization(loadedDawnConfig, descriptor?.model)

    // Build (or reuse) the descriptor->routeId identity map used by the
    // subagents marker to resolve `agent({ subagents: [imported] })` overrides.
    // Static manifest present → derive from it with zero entry-file imports;
    // otherwise the dynamic best-effort import path. Both caches are keyed on
    // their source object's identity, which is stable for the process
    // lifetime: the boot registry's manifest is threaded down via
    // `routeManifest` (or memoized per appRoot on the fallback path), and the
    // dev child restarts on any edit that could change it.
    const staticMaps = options.staticModules
      ? getCachedStaticDescriptorMaps(options.staticModules)
      : undefined
    const descriptorRouteMap =
      staticMaps?.descriptorRouteMap ?? (await getCachedDescriptorRouteMap(routeManifest))

    // Build the memory context if this route has a memory.ts (probed and
    // loaded once per route — part of PreparedRouteModules).
    let memoryContext: import("@dawn-ai/core").MemoryContext | undefined
    if (prepared.memory) {
      const defined = prepared.memory
      // Boot-resolved thunk wins when provided (shared, lazily-opened store —
      // no per-request sqlite open); otherwise fall back to the pre-existing
      // per-request resolution (the testing harness path, unchanged).
      const store = options.memoryStore
        ? await options.memoryStore()
        : await resolveMemoryStore(options.appRoot)
      const writes = await resolveMemoryWrites(options.appRoot)
      const cleanRoutePath = routeNamespaceKey(options.routePath)
      const extraScope = loadedDawnConfig?.memory?.resolveScope?.({
        routePath: cleanRoutePath,
        appRoot: options.appRoot,
      })
      memoryContext = buildMemoryContext({
        defined,
        store,
        writes,
        appRoot: options.appRoot,
        routePath: cleanRoutePath,
        now: new Date().toISOString(),
        ...(loadedDawnConfig?.memory?.indexMaxEntries !== undefined
          ? { indexMaxEntries: loadedDawnConfig.memory.indexMaxEntries }
          : {}),
        ...(extraScope ? { extraScope } : {}),
        // Vector recall: hand the capability the embedder (it embeds writes +
        // queries) plus the hybrid tuning it threads into the store's search.
        ...(loadedDawnConfig?.memory?.vector?.embedder
          ? { embedder: loadedDawnConfig.memory.vector.embedder }
          : {}),
        ...(loadedDawnConfig?.memory?.vector
          ? {
              vector: {
                ...(loadedDawnConfig.memory.vector.weights
                  ? { weights: loadedDawnConfig.memory.vector.weights }
                  : {}),
                ...(loadedDawnConfig.memory.vector.rrfK !== undefined
                  ? { rrfK: loadedDawnConfig.memory.vector.rrfK }
                  : {}),
                ...(loadedDawnConfig.memory.vector.vectorK !== undefined
                  ? { vectorK: loadedDawnConfig.memory.vector.vectorK }
                  : {}),
                ...(loadedDawnConfig.memory.vector.recencyWeight !== undefined
                  ? { recencyWeight: loadedDawnConfig.memory.vector.recencyWeight }
                  : {}),
                ...(loadedDawnConfig.memory.vector.confidenceWeight !== undefined
                  ? { confidenceWeight: loadedDawnConfig.memory.vector.confidenceWeight }
                  : {}),
              },
            }
          : {}),
      })
    }

    const capabilityBackends = sandboxBackends ?? configBackends
    const applied = await applyCapabilities(registry, routeDir, {
      routeManifest,
      descriptor,
      descriptorRouteMap,
      ...(staticMaps ? { routeDescriptors: staticMaps.routeDescriptors } : {}),
      ...(capabilityBackends ? { backends: capabilityBackends } : {}),
      markerFs: nodeMarkerFs,
      permissions: permissionsStore,
      appRoot: options.appRoot,
      ...(sandboxWorkspaceRoot ? { workspaceRoot: sandboxWorkspaceRoot } : {}),
      ...(memoryContext ? { memory: memoryContext } : {}),
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

    // Scope the merged tool set at the composition seam. Base set: top route
    // keeps all; a subagent keeps only authored tools (capability tools, e.g.
    // workspace runBash/writeFile and the dispatch `task`, are withheld unless
    // explicitly allowed). descriptor.tools.allow grants, .deny revokes, deny
    // wins. Unknown names throw and surface as a route-prep failure.
    const scopeInputs = tools.map((t) => ({ name: t.name, origin: toolOrigin(t) }))
    let keptToolNames: ReadonlySet<string>
    try {
      keptToolNames = resolveToolScope(scopeInputs, descriptor?.tools, {
        isSubagent: isSubagent ?? false,
        routeId: options.routeId,
      })
    } catch (error) {
      return { message: formatErrorMessage(error), ok: false }
    }
    tools = tools.filter((t) => keptToolNames.has(t.name))

    // Per-tool approval gating (tools.approve): wrap surviving tools so each
    // call consults the permissions store; on "unknown" in interactive mode
    // the wrapper interrupts for a human decision (kind: "tool"). Bash/path
    // gates inside the workspace tools are separate (pattern-aware) and
    // unaffected; `dawn check` warns on redundant overlap. A tool that ALSO has
    // a constraint predicate is excluded here — `constrain` is authoritative and
    // can itself escalate via `{ approve }`, so wrapping both would double-gate.
    const constrain = descriptor?.tools?.constrain
    const approveSet = new Set((descriptor?.tools?.approve ?? []).filter((n) => !constrain?.[n]))
    if (approveSet.size > 0) {
      tools = tools.map((t) =>
        approveSet.has(t.name)
          ? wrapToolWithApproval<
              Parameters<DiscoveredToolDefinition["run"]>[1],
              DiscoveredToolDefinition
            >(t, permissionsStore)
          : t,
      )
    }

    // Per-tool argument constraints (tools.constrain): wrap surviving tools so
    // each call is evaluated by the author's predicate against the model's args
    // before the tool runs. Runs at call time; reads live identity (signal/
    // threadId/params) from the run context. `{ approve }` verdicts reuse the
    // same HITL gate as tools.approve.
    if (constrain) {
      tools = tools.map((t) => {
        // Local const: TS does not narrow a repeated indexed access across the
        // ternary, so bind once.
        const predicate = constrain[t.name]
        return predicate
          ? wrapToolWithConstraint<
              Parameters<DiscoveredToolDefinition["run"]>[1],
              DiscoveredToolDefinition
            >(t, predicate, permissionsStore, options.routeId)
          : t
      })
    }
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
        // Boot-resolved instances flow into every subagent re-entry. What is
        // forwarded is whatever THIS turn received in its options — on the
        // HTTP path (dawn dev/start) the fetch handler always populates
        // them, so child turns inherit the parent's stores instead of
        // re-constructing sqlite per child (and under permissionsMode
        // "boot", parent and children share the one mutable
        // PermissionsStore — see the BootResolvedInstances doc). Only the
        // harness direct-call path, which passes no stores, still lets each
        // child fall back exactly as before. The config/sqlite fallbacks
        // resolved above are deliberately NOT forwarded. `routeManifest` is
        // NOT included here: the resolver appends its own (required) manifest
        // at both re-entry sites, so the child's manifest identity can never
        // diverge from the resolver's lookup manifest.
        bootInstances: {
          ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
          ...(options.threadsStore ? { threadsStore: options.threadsStore } : {}),
          ...(options.permissionsStore ? { permissionsStore: options.permissionsStore } : {}),
          ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
          ...(options.staticModules ? { staticModules: options.staticModules } : {}),
        },
        ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
        ...(sandboxKey ? { sandboxThreadId: sandboxKey } : {}),
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
    permissionsStore,
    threadsStore,
    ...(offload ? { offload } : {}),
    ...(summarization ? { summarization } : {}),
    ...(promptFragments.length > 0 ? { promptFragments } : {}),
    stateFields,
    ...(streamTransformers.length > 0 ? { streamTransformers } : {}),
    ...(subagentResolver ? { subagentResolver } : {}),
    tools,
    workspaceFs,
    ...(sandboxBackends !== undefined ? { sandboxed: true } : {}),
  }
}

async function executeRouteAtResolvedPath(
  options: BootResolvedInstances & {
    readonly appRoot: string
    readonly input: unknown
    readonly isSubagent?: boolean
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
    readonly sandboxManager?: SandboxManager
    /** Sandbox scoping key override — see `executeResolvedRoute`. */
    readonly sandboxThreadId?: string
    readonly signal?: AbortSignal
    readonly startedAt: number
    readonly threadId?: string
  },
): Promise<RuntimeExecutionResult> {
  let mode: RuntimeExecutionMode | null = null

  try {
    const prepared = await prepareRouteExecution({
      ...options,
      isSubagent: options.isSubagent ?? false,
    })

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
      sandboxed,
    } = prepared
    mode = normalized.kind
    const threadId =
      options.threadId ??
      (normalized.kind === "agent" ? `t-run-${randomUUID().slice(0, 8)}` : undefined)

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
      ...(threadId ? { threadId } : {}),
      ...(sandboxed ? { sandboxed: true } : {}),
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
    readonly sandboxed?: boolean
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
      ...(agentContext?.sandboxed ? { sandboxed: true } : {}),
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

export interface StaticDescriptorMaps {
  readonly descriptorRouteMap: ReadonlyMap<DawnAgent, string>
  readonly routeDescriptors: ReadonlyMap<string, DawnAgent>
}

let staticDescriptorMapsCache = new WeakMap<DawnStaticModules, StaticDescriptorMaps>()

/**
 * Test-only: reset the WeakMap-backed caches (dynamic descriptor-route map
 * and static descriptor maps). Not exported via the package barrel — internal
 * to this module's test suite.
 */
export function __resetDescriptorRouteMapCacheForTests(): void {
  descriptorRouteMapCache = new WeakMap()
  staticDescriptorMapsCache = new WeakMap()
}

/**
 * Static-modules fast path: derive both descriptor maps from the manifest.
 * Only agent routes whose normalized `module.entry` passes `isDawnAgent`
 * appear (workflow/graph/chain routes are excluded; the entry may come from
 * the default export or a named `agent` export). No entry file is ever
 * imported from disk (closes the last B2 dynamic-import hole; edge runtimes
 * have no disk to import from).
 */
export function buildDescriptorMapsFromStaticModules(
  modules: DawnStaticModules,
): StaticDescriptorMaps {
  const descriptorRouteMap = new Map<DawnAgent, string>()
  const routeDescriptors = new Map<string, DawnAgent>()
  for (const route of modules.routes) {
    if (route.kind === "agent" && isDawnAgent(route.module.entry)) {
      descriptorRouteMap.set(route.module.entry, route.routeId)
      routeDescriptors.set(route.routeId, route.module.entry)
    }
  }
  return { descriptorRouteMap, routeDescriptors }
}

/** Memoized per manifest object identity — stable for the process lifetime. */
export function getCachedStaticDescriptorMaps(modules: DawnStaticModules): StaticDescriptorMaps {
  let maps = staticDescriptorMapsCache.get(modules)
  if (!maps) {
    maps = buildDescriptorMapsFromStaticModules(modules)
    staticDescriptorMapsCache.set(modules, maps)
  }
  return maps
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
  readonly sandboxManager?: SandboxManager
  /**
   * The dispatching thread's sandbox key (top routes: its checkpoint
   * threadId; nested subagents: the inherited key). Forwarded to children as
   * `sandboxThreadId` ONLY — children never receive a checkpoint `threadId`,
   * so each child turn runs as an independent uncheckpointed invocation while
   * still resolving the same per-thread SandboxHandle as its parent.
   */
  readonly sandboxThreadId?: string
  /**
   * The dispatching turn's boot-resolved instances (stores + static module
   * manifest), spread verbatim into each child re-entry so subagent turns
   * construct nothing the parent didn't — no sqlite opens, no
   * permissions-file reads, no entry-file imports. `routeManifest` must NOT
   * be supplied here: both re-entry sites append the required `routeManifest`
   * arg after this spread, so the manifest the child executes with is by
   * construction the same object the resolver uses for route lookups.
   */
  readonly bootInstances?: BootResolvedInstances
}): SubagentResolver {
  const { appRoot, routeDir, routeManifest, descriptor, descriptorRouteMap } = args
  const { bootInstances, sandboxManager, sandboxThreadId } = args

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
          isSubagent: true,
          routeFile: route.entryFile,
          routeId: route.id,
          routePath: route.pathname,
          // The parent's boot instances (stores + static modules) flow into
          // the child: no store construction, no entry-file imports. The
          // resolver's own manifest is appended AFTER the spread so the
          // child's manifest identity IS the lookup manifest (no walk, and
          // the descriptor-route-map cache stays warm — same object).
          ...bootInstances,
          routeManifest,
          ...(sandboxManager ? { sandboxManager } : {}),
          // Deliberately NOT `threadId`: the child must run as an independent
          // uncheckpointed invocation (forwarding the parent's threadId would
          // share its in-flight LangGraph checkpoint and short-circuit the
          // child turn). `sandboxThreadId` scopes only the sandbox handle, so
          // the child still shares the parent thread's sandbox.
          ...(sandboxThreadId ? { sandboxThreadId } : {}),
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
          isSubagent: true,
          routeFile: route.entryFile,
          routeId: route.id,
          routePath: route.pathname,
          // Same boot-instance threading (and manifest-after-spread rule)
          // as invoke() above.
          ...bootInstances,
          routeManifest,
          ...(sandboxManager ? { sandboxManager } : {}),
          // Same as invoke() above: sandbox key only, never the checkpoint id.
          ...(sandboxThreadId ? { sandboxThreadId } : {}),
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
  const root = appRoot ?? process.cwd()
  if (!hasWorkspaceDir(root)) return undefined
  const workspaceRoot = join(root, "workspace")
  const t = config?.toolOutput ?? {}
  const store = new OffloadStore({
    backend: filesystem ?? getDefaultLocalFilesystem(),
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
