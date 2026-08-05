import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnAgent, WorkspaceFs } from "@dawn-ai/sdk"
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
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
  browse(q?: {
    readonly namespacePrefix?: string
    readonly status?: MemoryStatusLike
    readonly kind?: MemoryKindLike
    readonly sourceType?: MemorySourceTypeLike
    readonly limit?: number
    readonly offset?: number
    /** ISO lower bound (inclusive) on COALESCE(effectiveAt, createdAt). */
    readonly since?: string
    /** ISO upper bound (exclusive) on COALESCE(effectiveAt, createdAt). */
    readonly until?: string
    /** When supplied, rows with expiresAt <= now are excluded (matches search's `now`). */
    readonly now?: string
  }): Promise<{ readonly records: readonly MemoryRecordLike[]; readonly total: number }>
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
  }): Promise<{ readonly deletedExpired: number; readonly deletedOverCap: number }>
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
  readonly now: string
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

export interface CapabilityMarkerContext {
  readonly routeManifest: RouteManifest
  readonly descriptor: DawnAgent | undefined
  readonly descriptorRouteMap?: ReadonlyMap<DawnAgent, string>
  readonly backends?: {
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
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
  /**
   * Optional fingerprint of any load-time data this fragment closed over (i.e.
   * data NOT derived from the per-turn `state` passed to `render`). The agent
   * adapter folds it into the materialized-agent cache key, so a fragment whose
   * frozen snapshot has changed forces a re-materialize instead of serving a
   * stale prompt. Omit when the fragment is stable per descriptor or reads all
   * its data live at render time. Example: the memory-index fragment sets this
   * from the active store rows so a memory written mid-process still appears in
   * the index hint on the next run without a restart.
   */
  readonly cacheKey?: string
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
}

export interface CapabilityMarker {
  readonly name: string
  readonly detect: (routeDir: string, context: CapabilityMarkerContext) => Promise<boolean>
  readonly load: (
    routeDir: string,
    context: CapabilityMarkerContext,
  ) => Promise<CapabilityContribution>
}
