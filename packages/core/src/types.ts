import type { PermissionMode } from "@dawn-ai/permissions"
import type { RouteKind } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

export type { RouteKind }

export interface DawnConfig {
  readonly appDir?: string
  readonly backends?: {
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
  readonly permissions?: {
    readonly mode?: PermissionMode
    readonly allow?: Readonly<Record<string, readonly string[]>>
    readonly deny?: Readonly<Record<string, readonly string[]>>
  }
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  /**
   * Path to the env file loaded for local `dawn dev` / `dawn verify`,
   * relative to the app root. Defaults to "./.env". Does NOT affect the
   * deploy artifact (langgraph.json env is detected separately).
   */
  readonly env?: string
  readonly toolOutput?: {
    /** Offload tool outputs whose serialized length exceeds this many characters. Default 40000. */
    readonly offloadThresholdChars?: number
    /** Number of leading lines kept in the in-context preview. Default 10. */
    readonly previewLines?: number
    /** Max total bytes retained under workspace/tool-outputs/. Default 268435456 (256MB). */
    readonly maxBytes?: number
    /** Delete offloaded files older than this many ms. Default 10800000 (3h). */
    readonly ttlMs?: number
    /** Minimum ms between GC scans. Default 10000 (10s). */
    readonly gcThrottleMs?: number
    /**
     * Tool names whose output is never offloaded. Merged with the built-in
     * defaults (`readFile`, `listDir`), which are always exempt — exempting
     * the retrieval tools is required so the agent can read back offloaded
     * content without it being re-offloaded.
     */
    readonly noOffloadTools?: readonly string[]
  }
  readonly summarization?: {
    /** Enable conversation summarization. Default false. */
    readonly enabled?: boolean
    /** Token threshold over which older history is summarized. Default 12000. */
    readonly maxTokens?: number
    /** Most-recent turns kept verbatim (a turn starts at a HumanMessage). Default 6. */
    readonly keepRecentTurns?: number
    /** Model id for the summary LLM call. Defaults to the route's model. */
    readonly model?: string
    /** Token counter. Default: a lazy gpt-tokenizer (o200k_base) counter. */
    readonly tokenCounter?: (text: string) => number | Promise<number>
    /** Summary generator. Default: a built-in single-LLM-call summarizer. */
    readonly summarize?: (args: {
      readonly messages: readonly unknown[]
      readonly model: string
      readonly previousSummary?: string
      readonly signal: AbortSignal
    }) => Promise<string>
  }
  readonly memory?: {
    readonly enabled?: boolean
    /** Custom memory store. Defaults to an SQLite-backed store at <appRoot>/.dawn/memory.sqlite. */
    readonly store?: import("./capabilities/types.js").MemoryStoreLike
    /** Write-governance mode. "off" — never write; "candidate" — write as candidate (default); "auto" — write and auto-promote. */
    readonly writes?: "off" | "candidate" | "auto"
    /** Maximum number of entries returned by the index. */
    readonly indexMaxEntries?: number
    /** Derive the memory namespace scope for a given route. */
    readonly resolveScope?: (ctx: {
      readonly routePath: string
      readonly appRoot: string
    }) => Record<string, string>
  }
}

export type RouteSegment =
  | {
      readonly kind: "static"
      readonly raw: string
    }
  | {
      readonly kind: "dynamic" | "catchall" | "optional-catchall"
      readonly name: string
      readonly raw: string
    }

export interface RouteDefinition {
  readonly id: string
  readonly pathname: string
  readonly kind: RouteKind
  readonly entryFile: string
  readonly routeDir: string
  readonly segments: RouteSegment[]
}

export interface RouteManifest {
  readonly appRoot: string
  readonly routes: RouteDefinition[]
}

export interface NormalizedRouteModule {
  readonly kind: RouteKind
  readonly entry: unknown
  readonly config: Record<string, unknown>
}

export interface LoadDawnConfigOptions {
  readonly appRoot: string
}

export interface LoadedDawnConfig {
  readonly appRoot: string
  readonly config: DawnConfig
  readonly configPath: string
}

export interface FindDawnAppOptions {
  readonly appRoot?: string
  readonly cwd?: string
}

export interface DiscoveredDawnApp {
  readonly appRoot: string
  readonly configPath: string
  readonly dawnDir: string
  readonly routesDir: string
}

export interface DiscoverRoutesOptions {
  readonly appRoot?: string
  readonly cwd?: string
}

export interface ExtractedToolType {
  readonly description: string
  readonly name: string
  readonly inputType: string
  readonly outputType: string
}

export interface RouteToolTypes {
  readonly pathname: string
  readonly tools: readonly ExtractedToolType[]
}

export interface JsonSchemaProperty {
  readonly type?: string
  readonly description?: string
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchemaProperty
  readonly anyOf?: readonly JsonSchemaProperty[]
  readonly enum?: readonly string[]
}

export interface ExtractedToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: "object"
    readonly properties: Record<string, JsonSchemaProperty>
    readonly required: readonly string[]
    readonly additionalProperties: false
  }
}

export interface RouteToolSchemas {
  readonly pathname: string
  readonly tools: readonly ExtractedToolSchema[]
}

export type StateFieldReducer = "append" | "replace"

export interface ResolvedStateField {
  readonly name: string
  readonly reducer: StateFieldReducer | ((current: unknown, incoming: unknown) => unknown)
  readonly default: unknown
}
