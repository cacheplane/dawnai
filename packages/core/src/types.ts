import type { PermissionMode, PermissionsStore } from "@dawn-ai/permissions"
import type { ModelProviderId, RouteKind } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { ExecBackend, FilesystemBackend, SandboxConfig } from "@dawn-ai/workspace"
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
    /**
     * Custom permissions store. Defaults to the file-backed store at
     * `<appRoot>/.dawn/permissions.json`. A custom store receives `mode` and
     * the `allow`/`deny` lists above through its own options — the runtime
     * only calls `load()` on it, then reads it.
     */
    readonly store?: PermissionsStore
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
  /**
   * Deployment build configuration for `dawn build`.
   */
  readonly build?: {
    /**
     * Which deployment artifacts `dawn build` emits. Known targets:
     * - `"node"` — a runnable Node server entry (`.dawn/build/server.mjs`,
     *   which boots {@link serveRuntime}) plus a hardened `Dockerfile`.
     * - `"langsmith"` — the LangSmith deploy config (`.dawn/build/langgraph.json`
     *   and the per-route materialized graph entry files).
     * - `"hono"` — an edge entry point: `.dawn/build/app.mjs` (a Hono app over
     *   the web-standard fetch handler), the node-builtin-free static manifest
     *   `modules.edge.mjs`, a per-request `stores.mjs` factory, and a
     *   `wrangler.toml` scaffold. Opt-in only, and never emitted by default:
     *   the edge serves a subset of Dawn (no sandbox, no workspace tooling) and
     *   requires durable stores to be configured.
     * - `"vercel"` — Vercel Build Output API artifacts under `.vercel/output/`.
     *   Opt-in only, and never emitted by default: it serves the same edge
     *   subset of Dawn as `"hono"` (no sandbox, no workspace tooling) and
     *   requires durable stores to be configured.
     *
     * Defaults to `["node", "langsmith"]` when omitted.
     */
    readonly targets?: readonly string[]
  }
  readonly sandbox?: SandboxConfig
  /**
   * How the Dawn HTTP runtime itself behaves — as opposed to what the agent
   * does. Everything here is off unless configured.
   */
  readonly server?: {
    /**
     * Cross-origin access to the Dawn endpoints (`/agui/*`, `/threads/*`,
     * `/memory/*`). Omit and the runtime sends no `Access-Control-*` header at
     * all, which means a browser on another origin cannot call it — the
     * default, because opening a server to other origins is a deployment
     * decision.
     *
     * Set it when a browser client talks to Dawn directly rather than through
     * a same-origin proxy:
     *
     * ```ts
     * server: { cors: { origins: ["http://localhost:3010"] } }
     * ```
     */
    readonly cors?: CorsConfig
  }
  readonly memory?: {
    readonly enabled?: boolean
    /** Custom memory store. Defaults to an SQLite-backed store at <appRoot>/.dawn/memory.sqlite. */
    readonly store?: import("./capabilities/types.js").MemoryStoreLike
    /** Write-governance mode. "off" — never write; "candidate" — write as candidate (default); "auto" — write and auto-promote; "ask" — auto, but supersedes require HITL approval when interactive. */
    readonly writes?: "off" | "candidate" | "auto" | "ask"
    /** Maximum number of entries returned by the index. */
    readonly indexMaxEntries?: number
    /** Recall ranking tuning for the default SQLite store. All fields
     *  defaulted; omit for standard behavior. Ignored when a custom `store`
     *  is supplied (custom stores own their own ranking). */
    readonly recall?: {
      readonly weights?: {
        readonly relevance?: number
        readonly recency?: number
        readonly confidence?: number
      }
      readonly recencyHalfLifeMs?: number
      readonly candidatePool?: number
    }
    /** Opt-in vector/semantic recall. Presence of `embedder` enables it; absent
     *  → keyword-only (unchanged). Ignored when a custom `store` is supplied. */
    readonly vector?: {
      readonly embedder: import("./capabilities/types.js").Embedder
      readonly weights?: { readonly keyword?: number; readonly vector?: number }
      readonly rrfK?: number
      readonly vectorK?: number
      readonly recencyWeight?: number
      readonly confidenceWeight?: number
    }
    /** Opt-in runtime episode recorder: when enabled, the runtime writes one
     *  episodic memory per agent run (input, outcome, tools used, duration).
     *  Defaults: enabled false, ttlMs 30 days, cap 500 episodes per namespace,
     *  includeFailedRuns true, embed false (embed: true is not yet supported —
     *  episodes are recalled by keyword + time window). */
    readonly episodes?: {
      readonly enabled?: boolean
      readonly ttlMs?: number
      readonly cap?: number
      readonly includeFailedRuns?: boolean
      readonly embed?: boolean
    }
    /** Knobs for the explicitly-invoked distillation commands
     *  (`dawn memory consolidate` / `dawn memory reflect`). Nothing here runs
     *  automatically — distillation only happens when a command is invoked.
     *  Defaults: model "gpt-5-mini"; provider inferred from `model`, falling
     *  back to "openai"; maxBatches 5 per invocation; consolidate.olderThanMs
     *  7 days, consolidate.minBatchSize 5, consolidate.maxBatchSize 50,
     *  consolidate.ttlMs unset (summaries never expire),
     *  consolidate.sourceTtlMs 7 days; reflect.minNewRecords
     *  10, reflect.maxRecords 100, reflect.writes "candidate". */
    readonly distill?: {
      /** Model id for the distillation pass. Default "gpt-5-mini". */
      readonly model?: string
      /** Model provider. Default: inferred from `model`, else "openai". */
      readonly provider?: ModelProviderId
      /** Maximum batches processed per invocation. Default 5. */
      readonly maxBatches?: number
      readonly consolidate?: {
        /** Only consolidate records older than this many ms. Default 604800000 (7d). */
        readonly olderThanMs?: number
        /** Batches smaller than this are skipped. Default 5. */
        readonly minBatchSize?: number
        /** Batches are truncated to this many records. Default 50. */
        readonly maxBatchSize?: number
        /** Expiry for written summaries. Default: unset (summaries don't expire). */
        readonly ttlMs?: number
        /**
         * How long a superseded SOURCE record stays inspectable before the
         * normal prune pass reaps it. Default 604800000 (7d).
         *
         * Consolidation replaces its sources with one dense summary, but a
         * superseded row still occupies the per-namespace episodic cap while
         * being invisible to recall — so the cap would keep evicting live rows
         * to make room for records that have already been compacted. Stamping
         * an expiry hands that budget back on the next prune. Sources remain
         * visible in the Inspector (and their `supersedes` audit trail intact)
         * for this window.
         */
        readonly sourceTtlMs?: number
      }
      readonly reflect?: {
        /** Minimum new records since the watermark before reflecting. Default 10. */
        readonly minNewRecords?: number
        /** Maximum records fed to one reflection pass. Default 100. */
        readonly maxRecords?: number
        /** Write governance for derived insights. Default "candidate". */
        readonly writes?: "candidate" | "auto"
      }
    }
    /** Derive the memory namespace scope for a given route. */
    readonly resolveScope?: (ctx: {
      readonly routePath: string
      readonly appRoot: string
    }) => Record<string, string>
  }
}

/**
 * Cross-origin policy for the Dawn runtime (`server.cors`).
 *
 * Presence of this object is what turns CORS on; there is no `enabled` flag.
 */
export interface CorsConfig {
  /**
   * Origins allowed to read responses — an explicit list (compared exactly,
   * after normalizing case and a trailing slash) or `"*"` for any origin.
   *
   * `"*"` with `credentials: true` is rejected at boot: browsers refuse a
   * wildcard allow-origin on a credentialed request, so accepting it would
   * produce a server that looks configured and fails only in the console.
   */
  readonly origins: readonly string[] | "*"
  /** Allow cookies and `Authorization` cross-origin. Default false. */
  readonly credentials?: boolean
  /** Methods advertised in a preflight. Default: GET, POST, DELETE, OPTIONS. */
  readonly methods?: readonly string[]
  /**
   * Request headers advertised in a preflight. Default: echo whatever the
   * browser asked for, so an app can add an auth header without touching
   * server config.
   */
  readonly headers?: readonly string[]
  /** Response headers a browser script may read. Default none. */
  readonly exposeHeaders?: readonly string[]
  /** How long a browser may cache a preflight, in seconds. Default 600. */
  readonly maxAgeSeconds?: number
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
  /**
   * Absolute path of the loaded `dawn.config.ts` — or the `"<seeded>"`
   * sentinel when the memo was primed via `seedDawnConfig` (no disk read).
   */
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
