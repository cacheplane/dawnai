import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnAgent, WorkspaceFs } from "@dawn-ai/sdk"
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import type { ResolvedStateField, RouteManifest } from "../types.js"

export interface MemoryRecordLike {
  readonly id: string
  readonly kind: string
  readonly namespace: string
  readonly content: string
  readonly data: Record<string, unknown>
  readonly source: { readonly type: string; readonly id: string }
  readonly confidence: number
  readonly tags: readonly string[]
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly supersedes?: readonly string[]
}

export interface MemoryStoreLike {
  put(rec: MemoryRecordLike): Promise<void>
  get(id: string): Promise<MemoryRecordLike | null>
  search(q: {
    namespace: string
    query?: string
    kind?: string
    tags?: readonly string[]
    status?: string
    limit?: number
  }): Promise<readonly MemoryRecordLike[]>
  update(id: string, patch: Partial<MemoryRecordLike>): Promise<void>
  supersede(id: string, bySupersedingId: string): Promise<void>
}

export interface MemoryContext {
  readonly store: MemoryStoreLike
  readonly namespace: string
  readonly writes: "off" | "candidate" | "auto"
  readonly defined: {
    readonly kind: string
    readonly scope: readonly string[]
    readonly identity?: readonly string[]
  }
  readonly validate: (
    data: unknown,
  ) =>
    | { readonly ok: true; readonly value: Record<string, unknown> }
    | { readonly ok: false; readonly errors: string }
  readonly now: string
  readonly indexMaxEntries?: number
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
