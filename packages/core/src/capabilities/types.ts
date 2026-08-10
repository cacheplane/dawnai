import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnAgent, WorkspaceFs } from "@dawn-ai/sdk"
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import type { ResolvedSubagent } from "../subagents/types.js"
import type { ResolvedStateField, RouteManifest } from "../types.js"

// Literal unions mirroring @dawn-ai/memory's MemoryKind/MemoryStatus/
// MemorySource["type"]. Declared locally (NOT imported) because core must not
// depend on @dawn-ai/memory — its barrel pulls node:sqlite (see the inline
// comment in built-in/memory.ts). Keep in lockstep with packages/memory/src/types.ts.
export type MemoryKindLike = "semantic" | "episodic" | "procedural" | "reflection"
export type MemoryStatusLike = "candidate" | "active" | "superseded"
export type MemorySourceTypeLike = "run" | "user" | "tool" | "eval" | "human"

export interface MemoryRecordLike {
  readonly id: string
  readonly kind: MemoryKindLike
  readonly namespace: string
  readonly content: string
  readonly data: Record<string, unknown>
  readonly source: { readonly type: MemorySourceTypeLike; readonly id: string }
  readonly confidence: number
  readonly tags: readonly string[]
  readonly status: MemoryStatusLike
  readonly createdAt: string
  readonly updatedAt: string
  readonly supersedes?: readonly string[]
  /** When the remembered event actually happened (episodic); defaults to createdAt. */
  readonly effectiveAt?: string
  /** When the row stops being recallable (with `now` supplied) and becomes prunable. */
  readonly expiresAt?: string
}

/**
 * Pluggable text embedder for opt-in vector/semantic recall. Structural — the
 * concrete implementations (`openaiEmbedder`, `fakeEmbedder`) live outside core.
 */
export interface Embedder {
  readonly id: string
  readonly dims: number
  embed(texts: readonly string[]): Promise<Float32Array[]>
}

/**
 * Structural mirror of @dawn-ai/memory's `BrowseQuery`. Named (not inlined on
 * `MemoryStoreLike.browse`) so drift is a one-line diff instead of an invisible
 * parameter tweak: method parameters are checked BIVARIANTLY, so a narrower inline
 * shape stays assignable and silently rots. `memory-contract-parity.test.ts`
 * compares this type directly, which is invariant. Keep in lockstep with
 * packages/memory/src/types.ts.
 */
export interface BrowseQueryLike {
  readonly namespacePrefix?: string
  readonly status?: MemoryStatusLike | readonly MemoryStatusLike[]
  readonly kind?: MemoryKindLike | readonly MemoryKindLike[]
  readonly sourceType?: MemorySourceTypeLike
  readonly limit?: number
  readonly offset?: number
  readonly since?: string
  readonly until?: string
  readonly now?: string
}

/** Structural mirror of @dawn-ai/memory's `BrowsePage`. See `BrowseQueryLike`. */
export interface BrowsePageLike {
  readonly records: readonly MemoryRecordLike[]
  readonly total: number
}

export interface MemoryStoreLike {
  put(
    rec: MemoryRecordLike,
    opts?: { embedding?: Float32Array; embeddingModel?: string },
  ): Promise<void>
  get(id: string): Promise<MemoryRecordLike | null>
  search(q: {
    namespace: string
    query?: string
    kind?: MemoryKindLike
    tags?: readonly string[]
    status?: MemoryStatusLike
    limit?: number
    /** ISO recency reference for ranked searches; stores may ignore it for
     *  ranking. Also excludes rows with expiresAt <= now. */
    now?: string
    /** ISO lower bound (inclusive) on COALESCE(effectiveAt, createdAt). */
    since?: string
    /** ISO upper bound (exclusive) on COALESCE(effectiveAt, createdAt). */
    until?: string
    /** When present, the store runs the hybrid keyword+vector path. */
    queryEmbedding?: Float32Array
    /** Only rows whose stored embedding model equals this are vector-compared. */
    embedderId?: string
    /** Hybrid ranking tuning; structural — the store validates. */
    vector?: unknown
  }): Promise<readonly MemoryRecordLike[]>
  update(id: string, patch: Partial<MemoryRecordLike>): Promise<void>
  supersede(id: string, bySupersedingId: string): Promise<void>
  delete(id: string): Promise<void>
  listCandidates(namespacePrefix: string): Promise<readonly MemoryRecordLike[]>
  /** Cross-namespace/status listing for inspection UIs. Ordered updated_at DESC, id ASC. */
  browse(q?: BrowseQueryLike): Promise<BrowsePageLike>
  /** Aggregate counts for facet UIs. */
  stats(opts?: { readonly namespacePrefix?: string }): Promise<{
    readonly total: number
    readonly byStatus: Readonly<Record<string, number>>
    readonly byKind: Readonly<Record<string, number>>
    readonly byNamespace: Readonly<Record<string, number>>
    readonly bySourceType: Readonly<Record<string, number>>
  }>
  /** Delete (a) rows of any kind with expiresAt <= now, and (b) when cap is
   *  set, the oldest episodic rows beyond `cap` per namespace (ordered by
   *  COALESCE(effectiveAt, createdAt), id tiebreak). */
  prune(opts: {
    readonly now: string
    readonly namespacePrefix?: string
    readonly cap?: number
  }): Promise<{
    readonly deletedExpired: number
    readonly deletedOverCap: number
  }>
}

/**
 * Memory write-governance mode. "ask" = auto's exact write semantics, except
 * SUPERSEDEs (same identity, different value) pass a HITL gate first — a
 * supervision affordance, not a security boundary (headless ≡ auto).
 */
export type MemoryWritesMode = "off" | "candidate" | "auto" | "ask"

export interface MemoryContext {
  readonly store: MemoryStoreLike
  readonly namespace: string
  readonly writes: MemoryWritesMode
  readonly defined: {
    readonly kind: MemoryKindLike
    readonly scope: readonly string[]
    readonly identity?: readonly string[]
  }
  /** The route's defineMemory() zod schema — exposed as the `remember` tool's `data` shape so the model knows what to pass. */
  readonly schema?: unknown
  readonly validate: (
    data: unknown,
  ) =>
    | { readonly ok: true; readonly value: Record<string, unknown> }
    | { readonly ok: false; readonly errors: string }
  readonly now: () => string
  readonly indexMaxEntries?: number
  /** The resolved embedder when vector recall is enabled; the capability embeds
   *  writes + queries through it. Absent → keyword-only. */
  readonly embedder?: Embedder
  /** Hybrid recall tuning threaded through to the store's search. All fields
   *  optional/defaulted; absent → store defaults. */
  readonly vector?: {
    readonly weights?: { readonly keyword?: number; readonly vector?: number }
    readonly rrfK?: number
    readonly vectorK?: number
    readonly recencyWeight?: number
    readonly confidenceWeight?: number
  }
}

/**
 * Minimal SYNC filesystem facade for capability markers. Sync because
 * `promptFragment.render()` is synchronous (called per model turn) — the
 * async `FilesystemBackend` cannot serve it. The node implementation lives in
 * the cli layer so that markers can drop their own `node:fs` imports (keeping
 * `node:fs` OUT of @dawn-ai/core's capability graph so edge bundles stay
 * clean); edge entries simply omit it, and markers must detect-false /
 * render-empty when it is absent.
 */
export interface MarkerFs {
  /** false on any error — never throws. */
  existsSync(path: string): boolean
  /**
   * true only when the path exists and is a directory; false on any error —
   * never throws. Needed by the skills marker's directory probe (a size-based
   * probe can't distinguish dirs from files).
   */
  isDirectorySync(path: string): boolean
  /** Byte size, or undefined on any error — never throws. */
  statSizeSync(path: string): number | undefined
  /**
   * UTF-8 content, or undefined on any error — never throws.
   * `promptFragment.render()` runs uncaught inside the model-turn path, so a
   * throwing read would abort the turn; the whole facade is uniformly
   * fail-closed.
   */
  readFileSync(path: string): string | undefined
  /** Entry names (files+dirs), [] on any error — never throws. */
  readdirSync(path: string): readonly string[]
}

export interface CapabilityMarkerContext {
  readonly routeManifest: RouteManifest
  readonly descriptor: DawnAgent | undefined
  readonly subagentRegistry?: readonly ResolvedSubagent[]
  /**
   * Already-constructed backends for this run (a sandbox's, or the app's
   * `config.backends`). Takes precedence over `backendFactories`.
   */
  readonly backends?: {
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
  /**
   * How to construct a backend when no instance was supplied above. Core owns
   * no node backend of its own — `localExec`/`localFilesystem` live in
   * `@dawn-ai/workspace/node` and would drag `node:child_process`, `node:fs`
   * and friends into every graph that imports a capability marker. The node
   * runtime (`@dawn-ai/cli`'s boot fallbacks) supplies them here; an edge
   * runtime supplies `backends` instead, or neither — in which case a
   * workspace tool invocation fails loudly rather than silently reaching for
   * a filesystem that is not there. Called at most once per contribution, and
   * only when a tool that needs that backend actually runs.
   */
  readonly backendFactories?: {
    readonly filesystem?: () => FilesystemBackend
    readonly exec?: () => ExecBackend
  }
  /**
   * Sync fs facade for marker detect/load/render file access. Absent on
   * runtimes with no filesystem (edge) — markers MUST treat absence as
   * "no marker files exist". Always the HOST filesystem, even when the route
   * runs with sandbox backends — markers that must respect a sandbox should
   * consult `workspaceRoot` (this preserves current behavior: markers have
   * always read host files). Paths are caller-trusted and never
   * model-controlled — no path-jail is applied (contrast with
   * `FilesystemBackend`'s jailed contract).
   */
  readonly markerFs?: MarkerFs
  readonly permissions?: PermissionsStore
  /** Absolute path to the Dawn app root. Capabilities should resolve app-relative paths (e.g. workspace/) against this, NOT process.cwd(). */
  readonly appRoot: string
  /**
   * When set, the workspace root path INSIDE a sandbox (e.g. "/workspace").
   * Capabilities use this in place of `<appRoot>/workspace` and skip the host
   * `existsSync` gate, since the directory lives in the sandbox, not on the host.
   */
  readonly workspaceRoot?: string
  readonly memory?: MemoryContext
}

export interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
      // Optional here because pre-wrap invokers (langchain tool-converter/loop)
      // omit it; the cli's prepareRouteExecution wrapper guarantees it at
      // runtime, which is why the author-facing DawnToolContext requires it.
      readonly fs?: WorkspaceFs
      // Live per-call runtime identity, forwarded by the langchain tool-converter
      // from config.configurable. Optional because pre-wrap/legacy invokers omit
      // it. Read by the argument-constraint wrapper to build ConstraintContext.
      readonly threadId?: string
      readonly params?: Readonly<Record<string, string>>
    },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
}

export interface PromptFragment {
  readonly placement: "after_user_prompt"
  /**
   * Render this fragment given the current state of the agent's channels.
   * Called every model turn so the rendered text can reflect live state
   * (e.g., the current todos list is re-injected each turn).
   */
  readonly render: (state: Readonly<Record<string, unknown>>) => string
  /** Fingerprint of load-time data captured by the render closure. */
  readonly cacheKey?: string
  /** Optional live renderer used by async agent prompt composition. */
  readonly renderAsync?: (state: Readonly<Record<string, unknown>>) => Promise<string>
}

export interface StreamTransformerInput {
  readonly toolName: string
  readonly toolOutput: unknown
}

export interface StreamTransformerOutput {
  readonly event: string
  readonly data: unknown
}

export interface StreamTransformer {
  readonly observes: "tool_result"
  readonly transform: (
    input: StreamTransformerInput,
  ) => Iterable<StreamTransformerOutput> | AsyncIterable<StreamTransformerOutput>
}

export interface CapabilityContribution {
  readonly tools?: ReadonlyArray<DawnToolDefinition>
  readonly stateFields?: ReadonlyArray<ResolvedStateField>
  readonly promptFragment?: PromptFragment
  readonly streamTransformers?: ReadonlyArray<StreamTransformer>
  readonly subagentRegistry?: readonly ResolvedSubagent[]
}

export interface CapabilityMarker {
  readonly name: string
  readonly detect: (routeDir: string, context: CapabilityMarkerContext) => Promise<boolean>
  readonly load: (
    routeDir: string,
    context: CapabilityMarkerContext,
  ) => Promise<CapabilityContribution>
}
