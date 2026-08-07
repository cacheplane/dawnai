/**
 * The REQUEST-PATH core of route execution, with no `node:` imports of its
 * own — this is the module the `@dawn-ai/cli/fetch` entry reaches (graph
 * purity is enforced by test/fetch-entry-purity.test.ts).
 *
 * Everything here runs off inputs the caller supplies: seeded route modules,
 * injected stores, a DawnConfig object, a boot route manifest. The
 * filesystem-backed resolutions those inputs replace (sqlite stores,
 * `.dawn/permissions.json`, disk route/tool/state loads, `dawn.config.ts`,
 * `AGENTS.md`-style markers) live in `execute-route.ts` and reach this module
 * only as an optional `bootFallbacks` bag. Absent a needed input AND absent
 * `bootFallbacks`, a resolution either fails loudly or degrades to a
 * documented default — which is which is enumerated per input on
 * `requireFallbacks` below, and is never a blanket rule.
 *
 * `execute-route.ts` re-exports this module's surface with
 * `bootFallbacks: nodeBootFallbacks` pre-applied, so every existing node
 * caller (CLI commands, the node HTTP server, the testing harness) keeps its
 * current behavior byte for byte.
 */

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
  type DescriptorRouteIndex,
  dispatchableSubagents,
  type MarkerFs,
  type MemoryStoreLike,
  type MemoryWritesMode,
  type ResolvedStateField,
  type ResolvedSubagent,
  type RouteDefinition,
  type RouteManifest,
  resolveGuardedSubagent,
  resolveSubagentRegistry,
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
  materializeAgentGraph,
  type OffloadFn,
  OffloadStore,
  offloadToolOutput,
  type ResolvedSubagentGraph,
  type ResolvedSummarizationConfig,
  type SubagentResolver,
  streamAgent,
} from "@dawn-ai/langchain"
import { routeNamespaceKey } from "@dawn-ai/memory/namespace"
import type { PermissionMode, PermissionsStore } from "@dawn-ai/permissions"
import type { DawnMiddleware } from "@dawn-ai/sdk"
import { type DawnAgent, isDawnAgent, type WorkspaceFs } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import type { RunnableConfig } from "@langchain/core/runnables"
import { isGraphInterrupt } from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { checkToolNameUniqueness } from "./check-tool-name-uniqueness.js"
import { createDawnContext } from "./dawn-context.js"
import { buildMemoryContext } from "./memory-context.js"
import { pureDirname, pureJoin } from "./pure-path.js"
import {
  extractToolNames,
  extractUserInputText,
  hasPendingInterrupt,
  type ResolvedEpisodesConfig,
  recordEpisode,
  resolveEpisodesFromConfig,
} from "./record-episode.js"
import {
  createRuntimeFailureResult,
  createRuntimeSuccessResult,
  formatErrorMessage,
  type RuntimeExecutionMode,
  type RuntimeExecutionResult,
} from "./result.js"
import type { LoadedRouteMemory } from "./route-memory-shape.js"
import type { NormalizedRouteModule } from "./route-module-shape.js"
import type { SandboxManager } from "./sandbox-manager.js"
import type { DawnStaticModules } from "./static-modules-core.js"
import type { StreamChunk } from "./stream-types.js"
import type { DiscoveredToolDefinition } from "./tool-shape.js"

/**
 * The filesystem-backed resolutions the request path falls back to when an
 * instance was not supplied. Implemented once, in `execute-route.ts`, as
 * `nodeBootFallbacks`; never imported from here (that would put `node:sqlite`,
 * `tsx` and `node:fs` back in the fetch graph). An edge runtime passes none
 * and supplies instances instead.
 */
export interface RuntimeBootFallbacks {
  /** `loadDawnConfig` — reads (or returns the memo for) `dawn.config.ts`. */
  readonly loadConfig: (appRoot: string) => Promise<DawnConfig | undefined>
  /** The `src/middleware.ts` probe. */
  readonly loadMiddleware: (appRoot: string) => Promise<DawnMiddleware | undefined>
  /** Per-route disk load: route module, tools, state fields, memory.ts. */
  readonly loadRouteModules: (options: {
    readonly appRoot: string
    readonly routeFile: string
    readonly routeId: string
  }) => Promise<PreparedRouteModules>
  /** `discoverRoutes` walk, memoized per appRoot. */
  readonly discoverRouteManifest: (appRoot: string) => Promise<RouteManifest>
  /** Canonical descriptor→routeIds multimap built from every route entry file. */
  readonly descriptorRouteIndex: (manifest: RouteManifest) => Promise<DescriptorRouteIndex>
  /** Loads a child route's model-facing description from its entry module. */
  readonly loadSubagentDescription: (route: RouteDefinition) => Promise<string>
  /** Default sqlite checkpointer at `<appRoot>/.dawn/checkpoints.sqlite`. */
  readonly defaultCheckpointer: (appRoot: string) => BaseCheckpointSaver
  /** Default sqlite threads store at `<appRoot>/.dawn/threads.sqlite`. */
  readonly defaultThreadsStore: (appRoot: string) => ThreadsStore
  /** Config checkpointer, else the default sqlite saver (boot-level resolution). */
  readonly resolveCheckpointer: (appRoot: string) => Promise<BaseCheckpointSaver>
  /** Config threads store, else the default sqlite store (boot-level resolution). */
  readonly resolveThreadsStore: (appRoot: string) => Promise<ThreadsStore>
  /** Config permissions + `.dawn/permissions.json` (boot-level resolution). */
  readonly resolvePermissionsStore: (appRoot: string) => Promise<PermissionsStore>
  /** Config + env mode + one `.dawn/permissions.json` `load()`. */
  readonly buildPermissionsStore: (
    appRoot: string,
    permissions: DawnConfig["permissions"] | undefined,
  ) => Promise<PermissionsStore>
  /** Config store, else the default sqlite store at `<appRoot>/.dawn/memory.sqlite`. */
  readonly resolveMemoryStore: (appRoot: string) => Promise<MemoryStoreLike>
  /** Memory write-governance mode from `dawn.config.ts`. */
  readonly resolveMemoryWrites: (appRoot: string) => Promise<MemoryWritesMode>
  /** The per-server SandboxManager built from `config.sandbox`. */
  readonly resolveSandboxManager: (appRoot: string) => Promise<SandboxManager | undefined>
  /** Identity keys for a memory namespace, from the route's `memory.ts`. */
  readonly resolveIdentityKeys: (
    appRoot: string,
    namespace: string,
  ) => Promise<{
    readonly keys: readonly string[]
    readonly fallback: boolean
  }>
  /** Process-shared `localFilesystem()`. */
  readonly defaultFilesystem: () => FilesystemBackend
  /** Process-shared `localExec()` — the workspace capability's `runBash`. */
  readonly defaultExec: () => ExecBackend
  /** `<appRoot>/workspace` existence probe (gates tool-output offloading). */
  readonly hasWorkspaceDir: (appRoot: string) => boolean
  /** Node `MarkerFs` for the capability markers (AGENTS.md, skills, …). */
  readonly markerFs: MarkerFs
}

/**
 * Absent `bootFallbacks`, a resolution either THROWS or DEGRADES. Which is
 * which is a deliberate, per-input decision, not a blanket rule — this is the
 * complete list for both this module and `runtime-fetch-core.ts`.
 *
 * THROWS (via `requireFallbacks` here / `requireBoot` there) — the run cannot
 * be correct without it, so an edge deployment must inject it:
 *   - route modules for <routeId>   (this module; only on a cache miss, i.e.
 *                                    a route absent from the seeded manifest)
 *   - checkpointer                  (both modules)
 *   - threadsStore                  (both modules)
 *   - permissionsStore              (both modules)
 *   - memoryStore                   (both modules; only for a route with a
 *                                    memory.ts and no config `memory.store`)
 *   - workspace filesystem backend  (this module; no sandbox/config backend —
 *                                    thrown at the first `ctx.fs` operation,
 *                                    not at route preparation, so a route that
 *                                    never touches the workspace runs)
 *   - routeManifest                 (this module; no boot manifest threaded)
 *   - subagent descriptor map       (this module; no static modules threaded)
 *
 * DEGRADES to a documented default — each is optional by contract, so failing
 * the boot would be wrong:
 *   - `loadConfig`            → no DawnConfig; every config-derived setting
 *                               takes its documented default
 *   - `resolveMemoryWrites`   → "candidate" (the same default an app with no
 *                               `memory.writes` gets)
 *   - `markerFs`              → omitted from `applyCapabilities`; an absent
 *                               MarkerFs means "no filesystem" by contract, so
 *                               the disk-backed markers contribute nothing
 *   - `hasWorkspaceDir`       → false ⇒ tool-output offloading stays off; it
 *                               is an optimization, not a capability the route
 *                               asked for (this also makes the offload store's
 *                               `defaultFilesystem` unreachable)
 *   - `defaultFilesystem`/`defaultExec` AS `backendFactories` → omitted from
 *                               `applyCapabilities`; the workspace capability
 *                               then throws at TOOL-INVOCATION time unless a
 *                               sandbox/config backend was supplied. (The
 *                               `ctx.fs` handle above now behaves the same way
 *                               — see `resolveWorkspaceFsBackend`; it is
 *                               constructed unconditionally but resolves its
 *                               backend, or throws, at first USE.)
 *   - `loadMiddleware`        → no middleware (fetch-core)
 *   - `resolveSandboxManager` → no sandbox provider (fetch-core)
 *   - `resolveIdentityKeys`   → the default semantic identity for memory
 *                               approve (memory-handler)
 */
function requireFallbacks(
  fallbacks: RuntimeBootFallbacks | undefined,
  what: string,
): RuntimeBootFallbacks {
  if (fallbacks) return fallbacks
  throw new Error(
    `${what}: no instance provided and this runtime has no filesystem fallback — pass one via options (see the edge deployment docs).`,
  )
}

/**
 * The backend behind `ctx.fs`, resolved as late as it can be WITHOUT changing
 * what the node lane does.
 *
 * `ctx.fs` is built for every route execution, but the overwhelming majority of
 * routes never touch it. On node that costs nothing: `defaultFilesystem()` is a
 * process-wide memo that cannot fail, so it stays eager there and every
 * observable — including the one-construction-per-process guarantee
 * `lazy-node-backends.test.ts` pins — is unchanged.
 *
 * On a runtime with NO filesystem fallback the eager call was fatal. It threw
 * during route PREPARATION, i.e. a 500 on every agent turn of every deployed
 * worker, over a handle the turn never used — and `assertEdgeCapabilities`
 * rejects `backends.filesystem` (a live object cannot cross a build boundary),
 * so the emitted entry had no way to satisfy it either. Returning a thunk moves
 * the SAME throw with the SAME message from preparation to the first `ctx.fs`
 * operation: a route that genuinely reads the workspace still fails loudly and
 * by name, a route that does not now serves its turn. Nothing becomes a silent
 * no-op. (The agent-facing workspace TOOLS already defer exactly this way — see
 * `backendResolver` in core's workspace marker.)
 */
function resolveWorkspaceFsBackend(
  instance: FilesystemBackend | undefined,
  fallbacks: RuntimeBootFallbacks | undefined,
): FilesystemBackend | (() => FilesystemBackend) {
  if (instance) return instance
  if (fallbacks) return fallbacks.defaultFilesystem()
  // `fallbacks` is undefined here, so this thunk always throws — deliberately,
  // and through `requireFallbacks` so the message stays single-sourced.
  return () => requireFallbacks(fallbacks, "workspace filesystem backend").defaultFilesystem()
}

export type RouteResumePayload = Readonly<Record<string, "once" | "always" | "deny">>

export function toAgentInput(input: unknown, resume?: RouteResumePayload): unknown {
  return resume === undefined ? input : new Command({ resume })
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
 * Subagent turns inherit these instances from the dispatching turn: whatever
 * the HTTP layer resolved at boot is what every child preparation uses too. In particular,
 * under `permissionsMode: "boot"` the parent and its subagents share ONE
 * mutable PermissionsStore — a child's `addAllow` ("Always" grant) is
 * immediately visible to the parent and its later turns. That sharing is
 * deliberate: it matches the process-wide `.dawn/permissions.json` semantics
 * the per-request path has always had, without the per-child re-read.
 *
 * `config` is an already-constructed DawnConfig. When present it IS the
 * config — `dawn.config.ts` is never read (and no memo consulted).
 *
 * `bootFallbacks` is the node filesystem fallback bag. `execute-route.ts`
 * supplies it on every node call path; an edge runtime supplies none and gets
 * a clear error instead of a silent disk/sqlite access. It rides in this
 * interface so subagent re-entries inherit it with the rest of the boot state.
 */
export interface BootResolvedInstances {
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly memoryStore?: () => Promise<MemoryStoreLike>
  readonly routeManifest?: RouteManifest
  readonly staticModules?: DawnStaticModules
  readonly config?: DawnConfig
  readonly bootFallbacks?: RuntimeBootFallbacks
}

export type PrepareRouteExecutionOptions = Omit<BootResolvedInstances, "checkpointer"> & {
  readonly appRoot: string
  readonly checkpointer?: BaseCheckpointSaver | false
  readonly isSubagent?: boolean
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly routeFile: string
  readonly routeId: string
  readonly routeParams?: Readonly<Record<string, string>>
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
  readonly subagentDepth?: number
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

export type MaterializeResolvedRouteGraphOptions = Omit<BootResolvedInstances, "checkpointer"> & {
  readonly appRoot: string
  readonly checkpointer?: BaseCheckpointSaver
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly routeFile: string
  readonly routeId: string
  readonly routePath: string
  readonly sandboxManager?: SandboxManager
  readonly sandboxThreadId?: string
  readonly signal?: AbortSignal
}

/**
 * Materializes an agent route through the same policy-aware preparation path
 * used by local execution. An omitted checkpointer leaves the root graph
 * unbound so the deployment runtime can provide it at invocation time.
 */
export async function materializeResolvedRouteGraph(
  options: MaterializeResolvedRouteGraphOptions,
): Promise<unknown> {
  const prepared = await prepareRouteExecution({
    ...options,
    checkpointer: options.checkpointer ?? false,
  })
  if (!prepared.ok) throw new Error(prepared.message)
  return await materializePreparedAgentGraph(prepared, options.middlewareContext)
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
  const startedAt = Date.now()
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

  if (!checkpointer) {
    throw new Error(
      "[dawn] streamResolvedRoute called for an agent route without a checkpointer. This is an internal bug — please report it.",
    )
  }

  const routeParamNames = extractRouteParamNames(options.routeId)

  const agentInput = toAgentInput(options.input, options.resume)

  // Episode recorder (streaming path): a COMPLETED turn records an "ok"
  // episode; a thrown execution error records an "error" episode before
  // propagating. Parked (HITL-interrupted) turns record NOTHING: the
  // agent-adapter yields {type:"done"} unconditionally after its event stream
  // — including parked turns — so "done" alone is not completion. On this
  // path pending interrupts surface only as "interrupt" chunks (the adapter's
  // streamEvents output does not carry `__interrupt__`), so we track them
  // here; once an interrupt is seen the turn is parked and no further model
  // work happens in it. The resuming turn records when it completes, with the
  // RESUME turn's own startedAt (honest: the completing invocation's start —
  // the original turn's start is not reconstructed).
  let sawDone = false
  let sawInterrupt = false
  let recordedError = false
  let finalOutput: unknown

  try {
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
          const tc = chunk.data as {
            id?: string
            name: string
            input: unknown
          }
          yield {
            type: "tool_call",
            ...(tc.id ? { id: tc.id } : {}),
            name: tc.name,
            input: tc.input,
          }
          break
        }
        case "tool_result": {
          const tr = chunk.data as {
            id?: string
            name: string
            output: unknown
          }
          yield {
            type: "tool_result",
            ...(tr.id ? { id: tr.id } : {}),
            name: tr.name,
            output: tr.output,
          }
          break
        }
        case "done":
          sawDone = true
          finalOutput = chunk.data
          yield { type: "done", output: chunk.data }
          break
        case "interrupt": {
          // The agent-adapter registers the pending entry in
          // pending-interrupts so the /threads/:thread_id/resume endpoint
          // can correlate the POST. We just forward the chunk to the SSE
          // consumer.
          sawInterrupt = true
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
  } catch (error) {
    recordedError = true
    await recordRunEpisode({
      memoryContext: prepared.memoryContext,
      episodes: prepared.episodes,
      outcome: "error",
      input: options.input,
      startedAt,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    })
    throw error
  } finally {
    // The "ok" record lives in the finally, NOT after the loop: stream
    // consumers may close the generator early — the AG-UI outbound translator
    // early-returns on RUN_FINISHED without draining, which cascades a
    // .return() into this generator while it is suspended at the done yield.
    // A finally still runs on that close path (sawDone/finalOutput were
    // assigned BEFORE yielding the done chunk, so they are already set when
    // the close lands on the yield). `recordedError` prevents a double record
    // when the catch above already recorded the failure; abandoned (closed
    // before done) and parked (interrupt seen) turns record nothing.
    // recordRunEpisode never throws, so this is finally-safe.
    if (!recordedError && sawDone && !sawInterrupt) {
      await recordRunEpisode({
        memoryContext: prepared.memoryContext,
        episodes: prepared.episodes,
        outcome: "ok",
        output: finalOutput,
        input: options.input,
        startedAt,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      })
    }
  }
}

export interface PreparedRoute {
  readonly normalized: {
    readonly kind: "agent" | "chain" | "graph" | "workflow"
    readonly entry: unknown
  }
  readonly ok: true
  readonly routeId: string
  readonly checkpointer: BaseCheckpointSaver | undefined
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
  /** The memory context built for this route (agent routes with a memory.ts).
   *  Threaded out so the episode recorder can reuse the exact namespace/store/
   *  writes the capability used. */
  readonly memoryContext?: import("@dawn-ai/core").MemoryContext
  /** Resolved `memory.episodes` config — present only when a memory context
   *  was built (recorder is a no-op otherwise). */
  readonly episodes?: ResolvedEpisodesConfig
  /**
   * True when a per-thread sandbox is active for this turn (sandboxManager +
   * threadId resolved a handle). The agent-adapter uses this to bypass its
   * materialized-agent cache so tools bound to this thread's sandbox backends
   * are never reused for another thread.
   */
  readonly sandboxed?: boolean
}

export interface PreparedRouteError {
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
function getPreparedRouteModules(
  options: {
    readonly appRoot: string
    readonly routeFile: string
    readonly routeId: string
  },
  fallbacks: RuntimeBootFallbacks | undefined,
): Promise<PreparedRouteModules> {
  const cached = preparedRouteModulesCache.get(options.routeFile)
  if (cached) return cached
  const loading = requireFallbacks(
    fallbacks,
    `route modules for ${options.routeId}`,
  ).loadRouteModules(options)
  preparedRouteModulesCache.set(options.routeFile, loading)
  loading.catch(() => preparedRouteModulesCache.delete(options.routeFile))
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
 * Test-only: clear the per-route module cache so suites that mutate a fixture
 * app mid-process (new tools, changed routes) observe the change on the next
 * load. The node-side caches (route manifest, workspace probe) are cleared
 * alongside this by `execute-route.ts`'s `__resetRouteLoadCachesForTests`,
 * which is the one callers use.
 */
export function __resetPreparedRouteModulesForTests(): void {
  preparedRouteModulesCache.clear()
}

export async function prepareRouteExecution(
  options: PrepareRouteExecutionOptions,
): Promise<PreparedRoute | PreparedRouteError> {
  const { isSubagent = false } = options
  const fallbacks = options.bootFallbacks
  const routeDir = pureDirname(options.routeFile)

  // Route module, tools (with generated schemas), state fields, and memory.ts
  // load once per route per process (lazily, on the route's first request) —
  // see PreparedRouteModules. Everything below this block stays per-request:
  // it depends on live state (permissions, sandbox handles, capability
  // markers like AGENTS.md/memory.md whose per-turn re-reads are deliberate).
  const prepared = await getPreparedRouteModules(
    {
      appRoot: options.appRoot,
      routeFile: options.routeFile,
      routeId: options.routeId,
    },
    fallbacks,
  )
  const normalized = prepared.module
  let tools = prepared.tools
  let stateFields = prepared.stateFields

  // Apply capability markers (planning, etc.). Only for agent routes.
  let promptFragments: ReadonlyArray<NonNullable<CapabilityContribution["promptFragment"]>> = []
  let streamTransformers: ReadonlyArray<
    NonNullable<CapabilityContribution["streamTransformers"]>[number]
  > = []

  let subagentResolver: SubagentResolver | undefined

  // Memory context + episode-recorder config, populated in the agent branch
  // below when the route has a memory.ts; threaded out for the recorder.
  let memoryContext: import("@dawn-ai/core").MemoryContext | undefined
  let episodes: ResolvedEpisodesConfig | undefined

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
        readonly store?: PermissionsStore
      }
    | undefined
  let configCheckpointer: BaseCheckpointSaver | undefined
  let configThreadsStore: ThreadsStore | undefined
  let loadedDawnConfig: DawnConfig | undefined
  try {
    // A supplied `config` IS the config — no disk read, no memo lookup.
    loadedDawnConfig = options.config ?? (await fallbacks?.loadConfig(options.appRoot))
    configBackends = loadedDawnConfig?.backends
    permissionsConfig = loadedDawnConfig?.permissions
    configCheckpointer = loadedDawnConfig?.checkpointer
    configThreadsStore = loadedDawnConfig?.threadsStore
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
    fallbacks,
  )

  let summarization: ResolvedSummarizationConfig | undefined

  // Boot-resolved instances win when provided (no per-request sqlite open);
  // otherwise fall back to config, then to the default sqlite stores.
  const checkpointer: BaseCheckpointSaver | undefined =
    options.checkpointer === false
      ? undefined
      : (options.checkpointer ??
        configCheckpointer ??
        requireFallbacks(fallbacks, "checkpointer").defaultCheckpointer(options.appRoot))

  const threadsStore: ThreadsStore =
    options.threadsStore ??
    configThreadsStore ??
    requireFallbacks(fallbacks, "threadsStore").defaultThreadsStore(options.appRoot)

  // Deliberately outside the agent-only branch below: every route kind needs
  // the loaded store for ctx.fs permission gating, and createWorkspaceFs
  // requires it loaded. The agent branch reuses this store in applyCapabilities.
  // A provided instance (production boot) is used as-is; a provided factory
  // (dev) re-loads `.dawn/permissions.json` each request so HITL "Always"
  // grants written mid-process still apply; absent both, construct+load fresh
  // (the pre-existing per-request behavior).
  //
  // A config-supplied `permissions.store` is honored here for the same reason
  // `checkpointer` and `threadsStore` are above: otherwise the store an app
  // configures would apply on the HTTP path (via resolvePermissionsStore) but
  // silently NOT on this one, which is the sort of divergence that only shows
  // up in production. The store owns its own mode/allow/deny, so the sibling
  // config fields are deliberately not re-applied to it.
  const providedPermissions = options.permissionsStore
  const configPermissionsStore = permissionsConfig?.store
  let permissionsStore: PermissionsStore
  if (typeof providedPermissions === "function") {
    permissionsStore = await providedPermissions()
  } else if (providedPermissions) {
    permissionsStore = providedPermissions
  } else if (configPermissionsStore) {
    await configPermissionsStore.load()
    permissionsStore = configPermissionsStore
  } else {
    permissionsStore = await requireFallbacks(fallbacks, "permissionsStore").buildPermissionsStore(
      options.appRoot,
      permissionsConfig,
    )
  }

  const workspaceFsOptions = {
    workspaceRoot: sandboxWorkspaceRoot ?? pureJoin(options.appRoot, "workspace"),
    backend: resolveWorkspaceFsBackend(
      sandboxBackends?.filesystem ?? configBackends?.filesystem,
      fallbacks,
    ),
    permissions: permissionsStore,
    interruptCapable: normalized.kind === "agent",
  }
  const workspaceFs = createWorkspaceFs({
    ...workspaceFsOptions,
    signal: options.signal ?? new AbortController().signal,
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
      options.routeManifest ??
      (await requireFallbacks(fallbacks, "routeManifest").discoverRouteManifest(options.appRoot))
    const descriptor =
      normalized.kind === "agent" && isDawnAgent(normalized.entry) ? normalized.entry : undefined

    summarization = buildSummarization(loadedDawnConfig, descriptor?.model)

    // Build the canonical descriptor -> routeIds multimap. Static deployments
    // derive it entirely from their seeded module manifest; the Node fallback
    // imports route entries only on the dynamic path.
    const staticMaps = options.staticModules
      ? getCachedStaticDescriptorMaps(options.staticModules)
      : undefined
    const descriptorRouteIndex =
      staticMaps?.descriptorRouteIndex ??
      (await requireFallbacks(fallbacks, "subagent descriptor index").descriptorRouteIndex(
        routeManifest,
      ))
    let subagentRegistry: readonly ResolvedSubagent[]
    try {
      subagentRegistry = await resolveSubagentRegistry({
        descriptor,
        descriptorRouteIndex,
        parentRouteDir: routeDir,
        parentRouteId: options.routeId,
        routeManifest,
        loadDescription: async (route) => {
          if (staticMaps) {
            const staticDescriptor = staticMaps.routeDescriptors.get(route.id)
            return typeof staticDescriptor?.description === "string"
              ? staticDescriptor.description
              : "No description provided."
          }
          return await requireFallbacks(fallbacks, "subagent description").loadSubagentDescription(
            route,
          )
        },
      })
    } catch (error) {
      return { message: formatErrorMessage(error), ok: false }
    }

    const reservedTaskError = findReservedTaskPolicyError(descriptor, options.routeId)
    if (reservedTaskError) return { message: reservedTaskError, ok: false }

    // Build the memory context if this route has a memory.ts (probed and
    // loaded once per route — part of PreparedRouteModules).
    if (prepared.memory) {
      const defined = prepared.memory
      // Boot-resolved thunk wins when provided (shared, lazily-opened store —
      // no per-request sqlite open); otherwise fall back to the pre-existing
      // per-request resolution (the testing harness path, unchanged).
      const store = options.memoryStore
        ? await options.memoryStore()
        : (loadedDawnConfig?.memory?.store ??
          (await requireFallbacks(fallbacks, "memoryStore").resolveMemoryStore(options.appRoot)))
      // Same config source as the store read above (`loadedDawnConfig`, which
      // is the supplied config when there is one). The fallback's own
      // resolution — which re-reads dawn.config.ts — is the node default.
      const writes =
        loadedDawnConfig?.memory?.writes ??
        (fallbacks ? await fallbacks.resolveMemoryWrites(options.appRoot) : "candidate")
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
        now: () => new Date().toISOString(),
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
                  ? {
                      recencyWeight: loadedDawnConfig.memory.vector.recencyWeight,
                    }
                  : {}),
                ...(loadedDawnConfig.memory.vector.confidenceWeight !== undefined
                  ? {
                      confidenceWeight: loadedDawnConfig.memory.vector.confidenceWeight,
                    }
                  : {}),
              },
            }
          : {}),
      })
    }

    // Episode-recorder knobs, resolved only when this route built a memory
    // context (routes without a memory.ts and disabled apps pay nothing).
    //
    // Derived from the config this function ALREADY holds rather than from a
    // second `dawn.config.ts` read: `loadedDawnConfig` is the caller-supplied
    // config when there is one and the node fallback's `loadDawnConfig` memo
    // otherwise, so the node path resolves exactly what the disk-reading
    // `resolveEpisodesConfig` would (the server seeds that same memo from a
    // supplied config), and an edge runtime that injects a config gets a
    // working recorder instead of a silent no-op. `resolveEpisodesFromConfig`
    // IS the defaulting rule both entry points share.
    if (memoryContext) {
      episodes = resolveEpisodesFromConfig(loadedDawnConfig?.memory?.episodes)
    }

    const capabilityBackends = sandboxBackends ?? configBackends
    const applied = await applyCapabilities(registry, routeDir, {
      routeManifest,
      descriptor,
      subagentRegistry,
      ...(capabilityBackends ? { backends: capabilityBackends } : {}),
      // Core owns no node backend: the workspace capability constructs one
      // through these ONLY when nothing above supplied an instance. Absent
      // fallbacks (edge), a workspace tool call fails loudly instead of
      // reaching for a filesystem the runtime does not have.
      ...(fallbacks
        ? {
            backendFactories: {
              exec: fallbacks.defaultExec,
              filesystem: fallbacks.defaultFilesystem,
            },
          }
        : {}),
      ...(fallbacks ? { markerFs: fallbacks.markerFs } : {}),
      permissions: permissionsStore,
      appRoot: options.appRoot,
      ...(sandboxWorkspaceRoot ? { workspaceRoot: sandboxWorkspaceRoot } : {}),
      ...(memoryContext ? { memory: memoryContext } : {}),
    })

    if (applied.errors.length > 0) {
      const messages = applied.errors
        .map((e) => `[${e.markerName}#${e.phase}] ${e.message}`)
        .join("\n  ")
      return {
        message: `Capability error during route prep:\n  ${messages}`,
        ok: false,
      }
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
    const scopeInputs = tools.map((t) => ({
      name: t.name,
      origin: toolOrigin(t),
    }))
    let keptToolNames: ReadonlySet<string>
    try {
      keptToolNames = resolveToolScope(scopeInputs, descriptor?.tools, {
        isSubagent: isSubagent ?? false,
        routeId: options.routeId,
      })
    } catch (error) {
      return { message: formatErrorMessage(error), ok: false }
    }
    if (dispatchableSubagents(subagentRegistry).length > 0) {
      const mutableKeptToolNames = new Set(keptToolNames)
      mutableKeptToolNames.add("task")
      keptToolNames = mutableKeptToolNames
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

    // Resolve and prepare children only after the guarded policy boundary has
    // allowed the current invocation. Child graphs are materialized natively
    // with no child checkpointer, while live invocation metadata propagates.
    const hasTaskTool = capTools.some((t) => t.name === "task")
    if (hasTaskTool) {
      const routeById = new Map(routeManifest.routes.map((route) => [route.id, route] as const))
      subagentResolver = buildGuardedSubagentResolver({
        cacheChildGraphs:
          options.sandboxManager === undefined && options.sandboxThreadId === undefined,
        fallbackDepth: options.subagentDepth ?? 0,
        fallbackParams: options.routeParams ?? {},
        ...(sandboxKey ? { fallbackRootSandboxKey: sandboxKey } : {}),
        fallbackSignal: options.signal ?? new AbortController().signal,
        interruptCapable: true,
        parentRouteId: options.routeId,
        permissions: permissionsStore,
        prepareChild: async (entry, context) => {
          const route = routeById.get(entry.routeId)
          if (!route) throw new Error(`Validated subagent route "${entry.routeId}" is unavailable.`)
          const childPrepared = await prepareRouteExecution({
            appRoot: options.appRoot,
            checkpointer: false,
            permissionsStore,
            routeManifest,
            ...(options.threadsStore ? { threadsStore: options.threadsStore } : {}),
            ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
            ...(options.staticModules ? { staticModules: options.staticModules } : {}),
            ...(options.config ? { config: options.config } : {}),
            ...(options.bootFallbacks ? { bootFallbacks: options.bootFallbacks } : {}),
            isSubagent: true,
            ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
            routeFile: route.entryFile,
            routeId: route.id,
            routeParams: context.params,
            routePath: route.pathname,
            ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
            ...(context.rootSandboxKey ? { sandboxThreadId: context.rootSandboxKey } : {}),
            signal: context.signal,
            subagentDepth: context.depth,
          })
          if (!childPrepared.ok) throw new Error(childPrepared.message)
          const graph = await materializePreparedAgentGraph(
            childPrepared,
            options.middlewareContext,
          )
          assertResolvedSubagentGraph(graph)
          return {
            graph: withEpisodeRecording(graph, childPrepared),
            routeId: route.id,
          }
        },
        registry: subagentRegistry,
        routeParamNames: extractRouteParamNames(options.routeId),
      })
    }
  }

  // Authored tools receive a handle built from stable route preparation inputs
  // and the live tool-call signal.
  tools = tools.map((t) => ({
    ...t,
    run: (
      input: unknown,
      ctx: {
        readonly middleware?: Readonly<Record<string, unknown>>
        readonly signal: AbortSignal
      },
    ) =>
      t.run(input, {
        ...ctx,
        fs: createWorkspaceFs({ ...workspaceFsOptions, signal: ctx.signal }),
      }),
  }))

  return {
    normalized,
    ok: true,
    routeId: options.routeId,
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
    ...(memoryContext ? { memoryContext } : {}),
    ...(episodes ? { episodes } : {}),
  }
}

/**
 * Record one episodic memory for a settled run (the auto-recorder seam).
 *
 * No-ops unless `memory.episodes.enabled`, a memory context was built for the
 * route, and writes are not "off"; failed runs are skipped when
 * `includeFailedRuns` is false. NEVER throws — the recorder must not fail (or
 * alter the result of) a user's run; it is awaited so the write is durable
 * before the result is returned.
 *
 * Lives on the request path (and so stays node-free): everything it needs —
 * the store, the namespace, the knobs — arrives on `PreparedRoute`.
 */
async function recordRunEpisode(args: {
  readonly memoryContext: import("@dawn-ai/core").MemoryContext | undefined
  readonly episodes: ResolvedEpisodesConfig | undefined
  readonly outcome: "ok" | "error"
  readonly output?: unknown
  readonly input: unknown
  readonly startedAt: number
  readonly threadId?: string
}): Promise<void> {
  const { memoryContext, episodes } = args
  if (!episodes?.enabled || !memoryContext) return
  if (memoryContext.writes === "off") return
  if (args.outcome === "error" && !episodes.includeFailedRuns) return
  // A parked (HITL-interrupted) turn is not a completed run: the invoke()
  // path surfaces pending interrupts as `__interrupt__` on the final state.
  // Record nothing — the completing resume turn records instead. (The stream
  // path tracks interrupt chunks separately; see streamResolvedRoute.)
  if (args.outcome === "ok" && hasPendingInterrupt(args.output)) return
  try {
    await recordEpisode(
      memoryContext.store,
      {
        namespace: memoryContext.namespace,
        // Prefer the final state's message history: on a resume turn the run
        // input is a Command({resume}) with no human message, while the last
        // human message in the full state IS the original question. Fall back
        // to the run input (error path — no final state).
        input: extractUserInputText(args.output) || extractUserInputText(args.input),
        outcome: args.outcome,
        // On the failure path the final state is unavailable — record no tools.
        toolsUsed: args.outcome === "ok" ? extractToolNames(args.output) : [],
        startedAt: args.startedAt,
        finishedAt: Date.now(),
        ttlMs: episodes.ttlMs,
        // No distinct run id exists in the runtime today; the checkpoint
        // threadId is the per-run identifier (a fresh `t-run-*` id is minted
        // per invocation when the caller does not thread one).
        ...(args.threadId ? { runId: args.threadId, threadId: args.threadId } : {}),
      },
      { cap: episodes.cap },
    )
  } catch {
    // recordEpisode already never throws; this guards the extraction helpers
    // too so the recorder can never fail a user's run.
  }
}

export async function executeRouteAtResolvedPath(
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
  // Episode-recorder context, captured once prepare succeeds so the catch
  // path can record failed runs too. Absent (recorder no-op) until then.
  let epMemoryContext: import("@dawn-ai/core").MemoryContext | undefined
  let epConfig: ResolvedEpisodesConfig | undefined
  let epThreadId: string | undefined

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
      (normalized.kind === "agent"
        ? `t-run-${globalThis.crypto.randomUUID().slice(0, 8)}`
        : undefined)
    epMemoryContext = prepared.memoryContext
    epConfig = prepared.episodes
    epThreadId = threadId

    const context = createDawnContext({
      ...(options.middlewareContext ? { middleware: options.middlewareContext } : {}),
      fs: workspaceFs,
      tools,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const output = await invokeEntry(normalized.kind, normalized.entry, options.input, context, {
      ...(checkpointer ? { checkpointer } : {}),
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

    // Record the episode BEFORE returning so the write is durable when the
    // caller observes the result; the result object itself is unchanged.
    await recordRunEpisode({
      memoryContext: epMemoryContext,
      episodes: epConfig,
      outcome: "ok",
      output,
      input: options.input,
      startedAt: options.startedAt,
      ...(threadId ? { threadId } : {}),
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

    await recordRunEpisode({
      memoryContext: epMemoryContext,
      episodes: epConfig,
      outcome: "error",
      input: options.input,
      startedAt: options.startedAt,
      ...(epThreadId ? { threadId: epThreadId } : {}),
    })

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

function extractRouteParamNames(routeId: string): string[] {
  const matches = routeId.matchAll(/\[(\w+)\]/g)
  return [...matches].map((match) => match[1]).filter((s): s is string => s !== undefined)
}

export interface StaticDescriptorMaps {
  readonly descriptorRouteIndex: DescriptorRouteIndex
  readonly routeDescriptors: ReadonlyMap<string, DawnAgent>
}

let staticDescriptorMapsCache = new WeakMap<DawnStaticModules, StaticDescriptorMaps>()

/**
 * Test-only: reset the static descriptor-map WeakMap. The dynamic
 * descriptor-route map lives in `execute-route.ts` (it imports entry files);
 * that module's `__resetDescriptorRouteMapCacheForTests` clears both.
 */
export function __resetStaticDescriptorMapsForTests(): void {
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
  const mutableDescriptorRouteIndex = new Map<DawnAgent, string[]>()
  const routeDescriptors = new Map<string, DawnAgent>()
  for (const route of modules.routes) {
    if (route.kind === "agent" && isDawnAgent(route.module.entry)) {
      mutableDescriptorRouteIndex.set(route.module.entry, [
        ...(mutableDescriptorRouteIndex.get(route.module.entry) ?? []),
        route.routeId,
      ])
      routeDescriptors.set(route.routeId, route.module.entry)
    }
  }
  const descriptorRouteIndex: DescriptorRouteIndex = new Map(
    [...mutableDescriptorRouteIndex].map(([descriptor, routeIds]) => [descriptor, routeIds.sort()]),
  )
  return { descriptorRouteIndex, routeDescriptors }
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

export interface ChildPreparationContext {
  readonly callId: string
  readonly depth: number
  readonly params: Readonly<Record<string, string>>
  readonly rootSandboxKey?: string
  readonly signal: AbortSignal
}

const MAX_CHILD_GRAPH_CACHE_ENTRIES = 32

export function buildGuardedSubagentResolver(args: {
  readonly cacheChildGraphs?: boolean
  readonly fallbackDepth?: number
  readonly fallbackParams?: Readonly<Record<string, string>>
  readonly fallbackRootSandboxKey?: string
  readonly fallbackSignal?: AbortSignal
  readonly interruptCapable: boolean
  readonly parentRouteId: string
  readonly permissions?: PermissionsStore
  readonly prepareChild: (
    entry: ResolvedSubagent,
    context: ChildPreparationContext,
  ) => Promise<ResolvedSubagentGraph>
  readonly registry: readonly ResolvedSubagent[]
  readonly routeParamNames?: readonly string[]
}): SubagentResolver {
  const childGraphCache = new Map<string, Promise<ResolvedSubagentGraph>>()
  const stableSignal = args.fallbackSignal ?? new AbortController().signal

  return async (request) => {
    const requestSignal = request.config.signal
    const signal = requestSignal ?? stableSignal
    const threadId = readStringConfigurable(request.config, "thread_id")
    const params = readRouteParams(
      request.config,
      args.routeParamNames ?? Object.keys(args.fallbackParams ?? {}),
      args.fallbackParams ?? {},
    )
    const dawn = readDawnMetadata(request.config)
    const parentDepth = readNonNegativeInteger(dawn.subagent_depth) ?? args.fallbackDepth ?? 0
    const rootSandboxKey = readNonEmptyString(dawn.root_sandbox_key) ?? args.fallbackRootSandboxKey

    const result = await resolveGuardedSubagent({
      callId: request.callId,
      input: request.input,
      interruptCapable: args.interruptCapable && threadId !== undefined,
      name: request.name,
      ...(args.permissions ? { permissions: args.permissions } : {}),
      registry: args.registry,
      resolve: async (entry) => {
        const context: ChildPreparationContext = {
          callId: request.callId,
          depth: parentDepth + 1,
          params,
          ...(rootSandboxKey ? { rootSandboxKey } : {}),
          signal,
        }
        if (
          args.cacheChildGraphs === false ||
          requestSignal === undefined ||
          requestSignal !== stableSignal
        ) {
          return args.prepareChild(entry, context)
        }

        const cacheKey = childGraphCacheKey(entry, context)
        const cached = childGraphCache.get(cacheKey)
        if (cached) {
          childGraphCache.delete(cacheKey)
          childGraphCache.set(cacheKey, cached)
          return cached
        }

        const pending = args.prepareChild(entry, context).catch((error: unknown) => {
          if (childGraphCache.get(cacheKey) === pending) childGraphCache.delete(cacheKey)
          throw error
        })
        if (childGraphCache.size >= MAX_CHILD_GRAPH_CACHE_ENTRIES) {
          const oldestKey = childGraphCache.keys().next().value
          if (oldestKey !== undefined) childGraphCache.delete(oldestKey)
        }
        childGraphCache.set(cacheKey, pending)
        return pending
      },
      runtime: {
        parentRouteId: args.parentRouteId,
        ...(Object.keys(params).length > 0 ? { params } : {}),
        signal,
        ...(threadId ? { threadId } : {}),
      },
    })

    return result.ok ? { child: result.value, ok: true } : { message: result.message, ok: false }
  }
}

function childGraphCacheKey(entry: ResolvedSubagent, context: ChildPreparationContext): string {
  return JSON.stringify([
    entry.routeId,
    context.depth,
    context.rootSandboxKey ?? null,
    Object.entries(context.params).sort(([left], [right]) => left.localeCompare(right)),
  ])
}

async function materializePreparedAgentGraph(
  prepared: PreparedRoute,
  middlewareContext?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (prepared.normalized.kind !== "agent" || !isDawnAgent(prepared.normalized.entry)) {
    throw new Error(
      `[dawn] Route "${prepared.routeId}" must export a Dawn agent descriptor to be materialized.`,
    )
  }
  return materializeAgentGraph({
    ...(prepared.checkpointer ? { checkpointer: prepared.checkpointer } : {}),
    descriptor: prepared.normalized.entry,
    ...(middlewareContext ? { middlewareContext } : {}),
    ...(prepared.offload ? { offload: prepared.offload } : {}),
    ...(prepared.promptFragments ? { promptFragments: prepared.promptFragments } : {}),
    routeParamNames: extractRouteParamNames(prepared.routeId),
    ...(prepared.sandboxed ? { sandboxed: true } : {}),
    ...(prepared.stateFields ? { stateFields: prepared.stateFields } : {}),
    ...(prepared.streamTransformers ? { streamTransformers: prepared.streamTransformers } : {}),
    ...(prepared.subagentResolver ? { subagentResolver: prepared.subagentResolver } : {}),
    ...(prepared.summarization ? { summarization: prepared.summarization } : {}),
    tools: prepared.tools,
  })
}

function assertResolvedSubagentGraph(
  value: unknown,
): asserts value is ResolvedSubagentGraph["graph"] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("invoke" in value) ||
    typeof value.invoke !== "function"
  ) {
    throw new Error("Materialized subagent graph does not expose invoke(input, config).")
  }
}

function withEpisodeRecording(
  graph: ResolvedSubagentGraph["graph"],
  prepared: PreparedRoute,
): ResolvedSubagentGraph["graph"] {
  return {
    invoke: async (input, config) => {
      const startedAt = Date.now()
      const threadId = readStringConfigurable(config, "thread_id")
      try {
        const output = await graph.invoke(input, config)
        await recordRunEpisode({
          memoryContext: prepared.memoryContext,
          episodes: prepared.episodes,
          outcome: "ok",
          output,
          input,
          startedAt,
          ...(threadId ? { threadId } : {}),
        })
        return output
      } catch (error) {
        if (!isGraphInterrupt(error) && !config.signal?.aborted && !isAbortError(error)) {
          await recordRunEpisode({
            memoryContext: prepared.memoryContext,
            episodes: prepared.episodes,
            outcome: "error",
            input,
            startedAt,
            ...(threadId ? { threadId } : {}),
          })
        }
        throw error
      }
    },
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as {
    readonly code?: unknown
    readonly name?: unknown
  }
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR"
}

function findReservedTaskPolicyError(
  descriptor: DawnAgent | undefined,
  routeId: string,
): string | undefined {
  const tools = (descriptor as unknown as { readonly tools?: Record<string, unknown> } | undefined)
    ?.tools
  if (!tools || typeof tools !== "object") return undefined
  for (const field of ["allow", "deny", "approve"] as const) {
    if (Array.isArray(tools[field]) && tools[field].includes("task")) {
      return `[DAWN_E1004] Parent route "${routeId}": tools.${field} references the reserved internal "task" tool. Remove that entry and use delegation to control subagent dispatch.`
    }
  }
  if (
    typeof tools.constrain === "object" &&
    tools.constrain !== null &&
    Object.hasOwn(tools.constrain, "task")
  ) {
    return `[DAWN_E1004] Parent route "${routeId}": tools.constrain references the reserved internal "task" tool. Remove that entry and use delegation to control subagent dispatch.`
  }
  return undefined
}

function readDawnMetadata(config: RunnableConfig): Record<string, unknown> {
  const dawn = config.metadata?.dawn
  return typeof dawn === "object" && dawn !== null && !Array.isArray(dawn)
    ? (dawn as Record<string, unknown>)
    : {}
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function readStringConfigurable(config: RunnableConfig, key: string): string | undefined {
  return readNonEmptyString(config.configurable?.[key])
}

function readRouteParams(
  config: RunnableConfig,
  names: readonly string[],
  fallback: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const params: Record<string, string> = { ...fallback }
  for (const name of names) {
    const value = config.configurable?.[name]
    if (typeof value === "string") params[name] = value
  }
  return params
}

function buildOffload(
  config: DawnConfig | undefined,
  filesystem: FilesystemBackend | undefined,
  signal: AbortSignal,
  appRoot: string,
  fallbacks: RuntimeBootFallbacks | undefined,
): OffloadFn | undefined {
  const root = appRoot
  // No filesystem fallback and no explicit backend means there is nowhere to
  // spill large tool output to — offloading stays off rather than throwing,
  // since it is an optimization, not a capability the route asked for.
  if (!fallbacks?.hasWorkspaceDir(root)) return undefined
  // `fallbacks` is non-null from here — the probe above returns otherwise.
  const workspaceRoot = pureJoin(root, "workspace")
  const t = config?.toolOutput ?? {}
  const store = new OffloadStore({
    backend: filesystem ?? fallbacks.defaultFilesystem(),
    workspaceRoot,
    signal,
    maxBytes: t.maxBytes ?? 268_435_456,
    ttlMs: t.ttlMs ?? 10_800_000,
    gcThrottleMs: t.gcThrottleMs ?? 10_000,
  })
  const thresholdChars = t.offloadThresholdChars ?? 40_000
  const previewLines = t.previewLines ?? 10
  const exempt = exemptToolSet(t.noOffloadTools)
  return (content, toolName, toolCallId, liveSignal) => {
    // Retrieval/inspection tools (readFile, listDir, …) must never be
    // offloaded: their output IS the content the agent asked to read, so
    // re-offloading it would replace it with another pointer and make the
    // offloaded data permanently unreadable.
    if (exempt.has(toolName)) return Promise.resolve(content)
    return offloadToolOutput(content, {
      toolName,
      thresholdChars,
      previewLines,
      ...(liveSignal ? { signal: liveSignal } : {}),
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
