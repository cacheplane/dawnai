import type { ApiReferencePage } from "./api-reference-pages"

export type { ApiReferencePage } from "./api-reference-pages"
export { API_REFERENCE_PAGES, API_REFERENCE_PARENT } from "./api-reference-pages"

export type ApiReferenceCoverage = "detailed" | "catalog-only" | "internal" | "deferred-to-pr2"
export type ImportSurfaceKind = "typescript-runtime" | "config-artifact" | "metadata"
export type OperatedArtifactKind = "executable" | "operated-application"
export type RuntimeCompatibility = "node-only" | "edge-safe"
export type ApiReferenceAudience =
  | "application"
  | "integration"
  | "testing"
  | "tooling"
  | "internal"
export type RuntimePurity = "dependency-free" | "not-claimed"
export type ApiReferenceStability = "supported" | "low-level" | "internal"
export type ApiContractKey = `${string}#${"." | `./${string}`}:${string}`

export const API_REFERENCE_GUARD_IDS = [
  "edge-import-bundle",
  "dependency-free-import-graph",
  "node-import-bundle",
  "browser-import-negative-control",
  "node-operated-bundle",
  "browser-operated-negative-control",
] as const
export type ApiReferenceGuardId = (typeof API_REFERENCE_GUARD_IDS)[number]

export interface SourceAstBehaviorAuthority {
  readonly kind: "source-ast"
  readonly file: string
  readonly selector: string
  readonly expected: string
}

export interface TestAssertionBehaviorAuthority {
  readonly kind: "test-assertion"
  readonly file: string
  readonly testNames: readonly [string, ...string[]]
  readonly assertionFingerprint: string
}

export type ApiBehaviorAuthority = SourceAstBehaviorAuthority | TestAssertionBehaviorAuthority

export interface ApiBehaviorContract {
  readonly id: string
  readonly ownerHref: string
  readonly claim: string
  readonly authorities: readonly [ApiBehaviorAuthority, ...ApiBehaviorAuthority[]]
}

export const API_BEHAVIOR_CONTRACTS = [
  {
    id: "sdk.agent.descriptor-shape",
    ownerHref: "/docs/api/sdk",
    claim:
      "agent() returns a branded descriptor and includes optional tool scope only when supplied.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sdk/test/agent.test.ts",
        testNames: [
          "descriptor is recognized by isDawnAgent",
          "carries a tools scope through to the descriptor",
          "omits tools when not provided",
        ],
        assertionFingerprint:
          'expect(isDawnAgent(descriptor)).toBe(true)\nexpect(a.tools).toEqual({ allow: ["readFile"], deny: ["runBash"] })\nexpect("tools" in a).toBe(false)',
      },
    ],
  },
  {
    id: "sdk.middleware.result-shapes",
    ownerHref: "/docs/api/sdk",
    claim:
      "allow() and reject() return discriminated result objects; omitted context and body properties are absent.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sdk/test/middleware.test.ts",
        testNames: [
          "returns a reject result with status and body",
          "omits body when not provided",
          "returns a continue result with context",
          "omits context when not provided",
        ],
        assertionFingerprint:
          'expect ( result ) . toEqual ( { action : "reject" , status : 401 , body : { error : "Unauthorized" } , } )\nexpect ( result ) . toStrictEqual ( { action : "reject" , status : 403 } )\nexpect ( Object . hasOwn ( result , "body" ) ) . toBe ( false )\nexpect ( result ) . toEqual ( { action : "continue" , context : { userId : "user-1" , orgId : "org-1" } , } )\nexpect ( result ) . toStrictEqual ( { action : "continue" } )\nexpect ( Object . hasOwn ( result , "context" ) ) . toBe ( false )',
      },
    ],
  },
  {
    id: "sdk.validate-model-id.advisory",
    ownerHref: "/docs/api/sdk",
    claim:
      "Model validation is advisory: curated near-misses return provider-specific suggestions, while an uncurated or unresolved provider returns ok: true.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sdk/test/validate-model-id.test.ts",
        testNames: [
          "flags a near-miss on a curated provider with distance-then-prefix-ranked suggestions",
          "stays silent for uncurated providers",
          "stays silent when no provider can be resolved",
        ],
        assertionFingerprint:
          'expect(result.ok).toBe(false)\nexpect(result.provider).toBe("openai")\nexpect(result.suggestions).toEqual(["gpt-5.4", "gpt-5.5", "gpt-4o"])\nexpect(validateModelId({ model: "llama3.1", provider: "ollama" })).toEqual({ ok: true })\nexpect(validateModelId({ model: "anything", provider: "openrouter" })).toEqual({ ok: true })\nexpect(validateModelId({ model: "mixtral-8x22b" })).toEqual({ ok: true })\nexpect(validateModelId({ model: "totally-custom" })).toEqual({ ok: true })',
      },
    ],
  },
  {
    id: "cli.serve.production-boot",
    ownerHref: "/docs/api/cli",
    claim: "serveRuntime starts without running type generation or writing .dawn artifacts.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/cli/test/serve-runtime.test.ts",
        testNames: ["boots without running typegen (never writes .dawn artifacts)"],
        assertionFingerprint:
          'expect(existsSync(join(appRoot, ".dawn"))).toBe(false)\nexpect(response.status).toBe(200)\nexpect(existsSync(join(appRoot, ".dawn/dawn.generated.d.ts"))).toBe(false)',
      },
    ],
  },
  {
    id: "cli.serve-runtime.port-precedence",
    ownerHref: "/docs/api/cli",
    claim:
      "serveRuntime uses an explicit port first, then a numeric PORT value, then 8000. Empty or non-numeric PORT values also fall back to 8000; an explicit 0 still requests a random port.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/cli/test/serve-runtime.test.ts",
        testNames: [
          "empty PORT env resolves to the 8000 default (not a random port)",
          "non-numeric PORT env resolves to the 8000 default",
          "numeric PORT env is honored",
          "explicit port always wins, including 0 for a random port",
        ],
        assertionFingerprint:
          'expect(resolveServePort(undefined, "")).toBe(8000)\nexpect(resolveServePort(undefined, "not-a-number")).toBe(8000)\nexpect(resolveServePort(undefined, "3000")).toBe(3000)\nexpect(resolveServePort(0, "8000")).toBe(0)\nexpect(resolveServePort(5555, "")).toBe(5555)',
      },
    ],
  },
  {
    id: "cli.fetch.request-store-lifecycle",
    ownerHref: "/docs/api/cli",
    claim:
      "A requestStores factory creates and disposes stores per request. Disposal waits for an SSE body to finish. close() waits for in-flight disposal while its bounded shutdown drain remains open; after the 30-second default deadline it warns and proceeds.",
    authorities: [
      {
        kind: "source-ast",
        file: "packages/cli/src/lib/dev/runtime-fetch-core.ts",
        selector: "CLOSE_DRAIN_DEADLINE_MS",
        expected: "const CLOSE_DRAIN_DEADLINE_MS = 30_000;",
      },
      {
        kind: "test-assertion",
        file: "packages/cli/test/request-stores.test.ts",
        testNames: ["builds and disposes stores once per request, never reusing them"],
        assertionFingerprint:
          'expect((await handler.fetch(new Request("http://x/healthz"))).status).toBe(200)\nexpect((await handler.fetch(new Request("http://x/healthz"))).status).toBe(200)\nexpect(built).toEqual([1, 2])\nexpect(disposed).toEqual([1, 2])',
      },
      {
        kind: "test-assertion",
        file: "packages/cli/test/request-stores.test.ts",
        testNames: ["disposes only AFTER an SSE body finishes, not when fetch resolves"],
        assertionFingerprint:
          'expect(response.status).toBe(200)\nexpect(disposed).toEqual([])\nexpect(first.done).toBe(false)\nexpect(disposed).toEqual([])\nexpect(body).toContain("RUN_STARTED")\nexpect(body).toContain("bundled reply")\nexpect(body).toContain("RUN_FINISHED")\nexpect(disposed).toEqual([1])\nexpect(threads.has("th-per-request")).toBe(true)',
      },
      {
        kind: "test-assertion",
        file: "packages/cli/test/request-stores.test.ts",
        testNames: ["close() does not return while a store disposal is still in flight"],
        assertionFingerprint:
          'expect((await handler.fetch(new Request("http://x/healthz"))).status).toBe(200)\nexpect(events).toEqual(["dispose:start"])\nexpect(closed).toBe(false)\nexpect(events).toEqual(["dispose:start", "dispose:end", "close:returned"])',
      },
      {
        kind: "test-assertion",
        file: "packages/cli/test/runtime-fetch-parity.test.ts",
        testNames: [
          "close() with an entirely unread SSE body warns after the drain deadline and proceeds",
        ],
        assertionFingerprint:
          'expect(response.status).toBe(200)\nexpect(handler.state.activeRequests).toBe(1)\nexpect(warn).toHaveBeenCalledTimes(1)\nexpect(String(warn.mock.calls[0]?.[0])).toContain("1 request(s)")\nexpect(String(warn.mock.calls[0]?.[0])).toContain("proceeding with shutdown")',
      },
    ],
  },
  {
    id: "core.load-config.failed-load-eviction",
    ownerHref: "/docs/api/core",
    claim:
      "loadDawnConfig memoizes per app root. A failed in-flight load is evicted only while that same promise remains cached, so a seed written during the load survives its later rejection.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/core/test/config-loader-seam.test.ts",
        testNames: [
          "dispatches through the registered loader and memoizes its result",
          "a seed survives an in-flight registered load rejecting after the seed lands",
        ],
        assertionFingerprint:
          'expect(first.config.appDir).toBe("src/app")\nexpect(second).toBe(first)\nexpect(calls).toBe(1)\nawait expect(inFlight).rejects.toThrow(/loader blew up/)\nexpect(loaded.configPath).toBe("<seeded>")\nexpect(loaded.config.appDir).toBe("seeded")',
      },
    ],
  },
  {
    id: "core.state.reducer-resolution",
    ownerHref: "/docs/api/core",
    claim:
      "resolveStateFields infers append for array defaults and replace for scalar defaults, honors explicit reducer overrides, and sorts fields by name.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/core/test/resolve-state-fields.test.ts",
        testNames: [
          "infers append reducer for array defaults",
          "infers replace reducer for scalar defaults",
          "reducer overrides take precedence",
          "sorts fields alphabetically by name",
        ],
        assertionFingerprint:
          'expect ( result ) . toEqual ( [ { name : "results" , reducer : "append" , default : [ ] } , { name : "tags" , reducer : "append" , default : [ "initial" ] } , ] )\nexpect ( result ) . toEqual ( [ { name : "active" , reducer : "replace" , default : true } , { name : "confidence" , reducer : "replace" , default : 0 } , { name : "context" , reducer : "replace" , default : "" } , ] )\nexpect ( result ) . toEqual ( [ { name : "results" , reducer : customReducer , default : [ ] } ] )\nexpect ( result [ 0 ] ?. name ) . toBe ( "alpha" )\nexpect ( result [ 1 ] ?. name ) . toBe ( "zeta" )',
      },
    ],
  },
  {
    id: "generated-routes.state-conditional",
    ownerHref: "/docs/api/generated-routes",
    claim:
      "DawnRouteState and RouteState are generated when route state is present and omitted when state types are not supplied.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/core/test/render-route-types.test.ts",
        testNames: [
          "adds only the state exports when generated route state is present",
          "does NOT include DawnRouteState when stateTypes is omitted",
        ],
        assertionFingerprint:
          'expect ( output ) . toContain ( renderStateTypes ( stateTypes ) . trimEnd ( ) )\nexpect ( ambientModuleExports ( output , "dawn:routes" ) ) . toEqual ( [ "DawnRouteParams" , "DawnRoutePath" , "DawnRouteState" , "DawnRouteTools" , "RouteState" , "RouteTools" , ] )\nexpect ( output ) . not . toContain ( "DawnRouteState" )',
      },
    ],
  },
  {
    id: "generated-routes.tool-signatures",
    ownerHref: "/docs/api/generated-routes",
    claim:
      "DawnRouteTools omits routes with no tools and renders void-input tools as zero-argument functions returning promises.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/core/test/render-tool-types.test.ts",
        testNames: [
          "omits zero-tool routes and renders void-input tools as zero-argument promises",
        ],
        assertionFingerprint:
          'expect(result).not.toContain(\'"/without-tools"\')\nexpect(result).toContain("readonly ping: () => Promise<string>;")',
      },
    ],
  },
  {
    id: "ag-ui.activities.plan-snapshot",
    ownerHref: "/docs/api/ag-ui",
    claim:
      "A valid plan update becomes a complete replacement snapshot with activity type dawn.plan and the stable message ID dawn:plan:<runId> without breaking an open assistant text message.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/ag-ui/test/outbound.test.ts",
        testNames: ["plan activity does not flush an open text message"],
        assertionFingerprint:
          'expect ( events . map ( ( event ) => event . type ) ) . toEqual ( [ EventType . RUN_STARTED , EventType . TEXT_MESSAGE_START , EventType . TEXT_MESSAGE_CONTENT , EventType . ACTIVITY_SNAPSHOT , EventType . TEXT_MESSAGE_CONTENT , EventType . TEXT_MESSAGE_END , EventType . RUN_FINISHED , ] )\nexpect ( ActivitySnapshotEventSchema . parse ( activity ) ) . toEqual ( { type : EventType . ACTIVITY_SNAPSHOT , messageId : "dawn:plan:rn-1" , activityType : DAWN_PLAN_ACTIVITY_TYPE , replace : true , content : { todos } , } )\nexpect ( events . filter ( ( event ) => event . type === EventType . TEXT_MESSAGE_CONTENT ) ) . toMatchObject ( [ { messageId : "msg-1" , delta : "before" } , { messageId : "msg-1" , delta : "after" } , ] )',
      },
    ],
  },
  {
    id: "ag-ui.activities.subagent-privacy",
    ownerHref: "/docs/api/ag-ui",
    claim:
      "A subagent snapshot exposes allowlisted progress only: name, depth, status, optional todos, at most five tool name/status summaries, the total tool count, and an error capped at 400 characters. It never includes child prompts, prose, tool inputs, tool outputs, final answers, route IDs, call IDs, or raw runtime IDs.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/ag-ui/test/activities.test.ts",
        testNames: [
          "retains only the five newest tool summaries while counting each id once",
          "completes once, marks running tools incomplete, and freezes terminal state",
          "caps failure errors at 400 characters",
          "consumes child messages and exposes only allowlisted public fields",
        ],
        assertionFingerprint:
          'expect ( snapshot ?. content ) . toMatchObject ( { tools : [ { name : "toolName2" , status : "running" } , { name : "toolName3" , status : "running" } , { name : "toolName4" , status : "running" } , { name : "toolName5" , status : "running" } , { name : "toolName6" , status : "running" } , ] , totalToolCount : 6 , } )\nexpect ( projector . project ( "subagent.tool_result" , { ... identity , id : "tool-1" } ) ) . toBeNull ( )\nexpect ( completed ?. content ) . toMatchObject ( { tools : [ { name : "toolName2" , status : "running" } , { name : "toolName3" , status : "running" } , { name : "toolName4" , status : "running" } , { name : "toolName5" , status : "running" } , { name : "toolName6" , status : "completed" } , ] , totalToolCount : 6 , } )\nexpect ( reinserted ?. content ) . toMatchObject ( { tools : [ { name : "toolName3" , status : "running" } , { name : "toolName4" , status : "running" } , { name : "toolName5" , status : "running" } , { name : "toolName6" , status : "completed" } , { name : "toolName1" , status : "running" } , ] , totalToolCount : 6 , } )\nexpect ( ActivitySnapshotEventSchema . parse ( reinserted ) ) . toEqual ( reinserted )\nexpect ( ended ?. content ) . toEqual ( { name : "researcher" , depth : 1 , status : "completed" , todos , tools : [ { name : "searchCorpus" , status : "incomplete" } , { name : "readDoc" , status : "completed" } , ] , totalToolCount : 2 , } )\nexpect ( JSON . stringify ( ended ) ) . not . toContain ( "private child answer" )\nexpect ( ActivitySnapshotEventSchema . parse ( ended ) ) . toEqual ( ended )\nexpect ( projector . project ( "subagent.end" , identity ) ) . toBeNull ( )\nexpect ( projector . project ( "subagent.start" , identity ) ) . toBeNull ( )\nexpect ( projector . project ( "subagent.tool_call" , { ... identity , id : "tool-late" , tool : "lateTool" , } ) , ) . toBeNull ( )\nexpect ( projector . project ( "subagent.plan_update" , { ... identity , todos : [ ] } ) ) . toBeNull ( )\nexpect ( ended ?. content ) . toMatchObject ( { status : "failed" , error : "x" . repeat ( 400 ) , } )\nexpect ( ActivitySnapshotEventSchema . parse ( ended ) ) . toEqual ( ended )\nexpect ( projector . project ( "subagent.message" , { ... identity , content : "private child prose" , reasoning : "private reasoning" , } ) , ) . toBeNull ( )\nexpect ( Object . keys ( call ?. content ?? { } ) . sort ( ) ) . toEqual ( [ "depth" , "name" , "status" , "tools" , "totalToolCount" , ] )\nexpect ( Object . keys ( ended ?. content ?? { } ) . sort ( ) ) . toEqual ( [ "depth" , "name" , "status" , "tools" , "totalToolCount" , ] )\nexpect ( serializedContent ) . not . toContain ( privateValue )',
      },
    ],
  },
  {
    id: "ag-ui.outbound.errors-as-events",
    ownerHref: "/docs/api/ag-ui",
    claim:
      "toAguiEvents turns an upstream throw into a final RUN_ERROR event and closes an open text frame instead of throwing to the consumer.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/ag-ui/test/outbound.test.ts",
        testNames: ["upstream throw is emitted as RUN_ERROR, not thrown to the consumer"],
        assertionFingerprint:
          'expect(out.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "kaboom" })\nexpect(out.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(true)',
      },
    ],
  },
  {
    id: "ag-ui.inbound.lossless-input",
    ownerHref: "/docs/api/ag-ui",
    claim:
      "fromRunAgentInput maps supported messages and resume entries into Dawn shapes, omits resume for an empty array, and preserves the untouched AG-UI input under raw for tools, state, and context.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/ag-ui/test/inbound.test.ts",
        testNames: [
          "maps user and assistant messages to Dawn messages",
          "maps a resume array to Dawn resume requests",
          "omits the resume property for an empty resume array",
          "raw preserves the original input for tools/state/context access",
        ],
        assertionFingerprint:
          'expect ( result . messages ) . toEqual ( [ { role : "user" , content : "hi" , id : "m1" } , { role : "assistant" , content : "hello" , id : "m2" } , ] )\nexpect ( result . resume ) . toBeUndefined ( )\nexpect ( result . raw ) . toBe ( input )\nexpect ( fromRunAgentInput ( input ) . resume ) . toEqual ( [ { interruptId : "perm-1" , status : "resolved" , payload : "once" } , ] )\nexpect ( Object . hasOwn ( result , "resume" ) ) . toBe ( false )\nexpect ( result . resume ) . toBeUndefined ( )\nexpect ( fromRunAgentInput ( input ) . raw ) . toBe ( input )',
      },
    ],
  },
  {
    id: "memory.namespace.stable-encoding",
    ownerHref: "/docs/api/memory",
    claim:
      "serializeNamespace emits dimensions in a stable order, escapes reserved delimiters reversibly, and rejects an empty scope.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/memory/test/namespace.test.ts",
        testNames: [
          "serializes a scope tuple with stable key order",
          "throws on an empty tuple (fail-closed)",
          "round-trips encoded values containing | = %",
        ],
        assertionFingerprint:
          'expect ( serializeNamespace ( { route : "/support" , workspace : "acme" } ) ) . toBe ( "workspace=acme|route=/support" , )\nexpect ( ( ) => serializeNamespace ( { } ) ) . toThrow ( /at least one/i )\nexpect ( parseNamespace ( serializeNamespace ( tuple ) ) ) . toEqual ( tuple )',
      },
    ],
  },
  {
    id: "memory.browse.pure-subpath",
    ownerHref: "/docs/api/memory",
    claim:
      "The /browse entry reaches only the pure browse modules and no external package, so it does not pull node:sqlite into edge or browser bundles.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/memory/test/browse-contract.test.ts",
        testNames: ["reaches nothing outside the pure browse sources"],
        assertionFingerprint:
          'expect ( [ ... graph . keys ( ) ] . sort ( ) ) . toEqual ( [ "./browse-cursor.ts" , "./browse-filter.ts" , "./browse-order.ts" , "./browse-range.ts" , "./browse-validate.ts" , "./browse.ts" , "./types.ts" , ] )\nexpect ( [ ... graph . values ( ) ] . flat ( ) . filter ( ( specifier ) => ! specifier . startsWith ( "." ) ) ) . toEqual ( [ ] )',
      },
    ],
  },
  {
    id: "memory.write-policy",
    ownerHref: "/docs/api/memory",
    claim:
      "writePolicyFor() selects reconciliation for semantic memory and append behavior for episodic and reflection memory; it throws for procedural memory because that reconciliation policy is not implemented. Low-level MemoryStore implementations can store typed procedural records, while the generated remember tool returns a not-yet-wired rejection without throwing or writing.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/memory/test/write-policy.test.ts",
        testNames: [
          "semantic reconciles",
          "episodic appends",
          "reflection appends (insights accumulate)",
          "procedural still throws a not-yet-wired error",
          "the low-level store accepts a typed procedural record",
        ],
        assertionFingerprint:
          'expect ( writePolicyFor ( "semantic" ) ) . toEqual ( { mode : "reconcile" } )\nexpect ( writePolicyFor ( "episodic" ) ) . toEqual ( { mode : "append" } )\nexpect ( writePolicyFor ( "reflection" ) ) . toEqual ( { mode : "append" } )\nexpect ( ( ) => writePolicyFor ( "procedural" ) ) . toThrow ( /not yet wired/ )\nexpect ( await store . get ( record . id ) ) . toMatchObject ( { id : record . id , kind : "procedural" } )',
      },
      {
        kind: "test-assertion",
        file: "packages/core/test/memory-capability-episodic.test.ts",
        testNames: ["procedural kind returns a not-yet-wired tool error with zero store writes"],
        assertionFingerprint:
          'expect ( out . result ) . toContain ( "not yet wired" )\nexpect ( log . puts . length ) . toBe ( 0 )\nexpect ( log . updates ) . toBe ( 0 )\nexpect ( log . supersedes ) . toBe ( 0 )\nexpect ( log . searches . length ) . toBe ( 1 )',
      },
    ],
  },
  {
    id: "memory-pgvector.schema.identifier-validation",
    ownerHref: "/docs/api/memory-pgvector",
    claim:
      "pgvector schema and table-prefix identifiers reject unsafe characters before Dawn interpolates them into DDL.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/memory-pgvector/test/schema.test.ts",
        testNames: ["rejects identifiers with unsafe characters"],
        assertionFingerprint:
          'expect(() => assertIdentifier("prefix", "bad-name")).toThrow(/prefix/)\nexpect(() => assertIdentifier("schema", "public; DROP TABLE x")).toThrow(/schema/)\nexpect(() => assertIdentifier("prefix", "1leading")).toThrow(/prefix/)\nexpect(() => assertIdentifier("schema", "")).toThrow(/schema/)',
      },
    ],
  },
  {
    id: "memory-pgvector.dimension-branches",
    ownerHref: "/docs/api/memory-pgvector",
    claim:
      "The store rejects invalid dimensions at construction: 1–2000 use vector cosine indexes, 2001–4000 use halfvec cosine indexes, and larger, nonpositive, or noninteger values throw.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/memory-pgvector/test/schema.test.ts",
        testNames: [
          "dims ≤ 2000 → plain vector + vector_cosine_ops",
          "2000 < dims ≤ 4000 → halfvec + halfvec_cosine_ops (text-embedding-3-large)",
          "dims > 4000 → throws a clear error naming the ceiling",
          "non-positive/non-integer dims throw",
          "validates dimensions at construction time",
        ],
        assertionFingerprint:
          'expect ( vectorColumnDef ( 1536 ) ) . toEqual ( { type : "vector(1536)" , ops : "vector_cosine_ops" } )\nexpect ( vectorColumnDef ( 3072 ) ) . toEqual ( { type : "halfvec(3072)" , ops : "halfvec_cosine_ops" } )\nexpect ( ( ) => vectorColumnDef ( 5000 ) ) . toThrow ( /4000/ )\nexpect ( ( ) => vectorColumnDef ( 0 ) ) . toThrow ( )\nexpect ( ( ) => vectorColumnDef ( 1.5 ) ) . toThrow ( )\nexpect ( ( ) => pgvectorMemoryStore ( { dimensions : 4001 } ) ) . toThrow ( /4000 halfvec index ceiling/ )',
      },
    ],
  },
  {
    id: "memory-pgvector.update-preserves-embedding",
    ownerHref: "/docs/api/memory-pgvector",
    claim:
      "update() preserves the row's stored embedding. Content or data updates do not recompute that embedding, so after changing semantic content, compute a replacement and call put(updatedRecord, { embedding, embeddingModel }) to avoid stale vector results.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/memory-pgvector/test/pgvector-integration.test.ts",
        testNames: [
          "halfvec update preserves the stored embedding without recomputing changed content",
        ],
        assertionFingerprint:
          'expect ( out . map ( ( r ) => r . id ) ) . toContain ( "h" )\nexpect ( await store . get ( "h" ) ) . toMatchObject ( { content : "quarterly tax filing" , data : { topic : "tax" } , confidence : 0.5 , } )',
      },
    ],
  },
  {
    id: "postgres-storage.migration.instance-scoped",
    ownerHref: "/docs/api/postgres-storage",
    claim:
      "Migration memoization belongs to each store instance; assumeMigrated skips that instance's migration pass, while an unflagged instance begins a locked transaction.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/postgres-storage/test/assume-migrated.test.ts",
        testNames: [
          "skips the threads migration pass entirely",
          "still migrates — under the advisory lock — when unset",
        ],
        assertionFingerprint:
          'expect(sql).toEqual([])\nexpect(sql[0]).toBe("BEGIN")\nexpect(sql[1]).toContain("pg_advisory_xact_lock")\nexpect(sql.at(-1)).toBe("COMMIT")',
      },
    ],
  },
  {
    id: "postgres-storage.entry-split",
    ownerHref: "/docs/api/postgres-storage",
    claim:
      "The main entry links without Node built-ins for edge pools, while /node deliberately fails an edge bundle because it imports pg for connectionString convenience.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/postgres-storage/test/edge-bundle.test.ts",
        testNames: [
          "links the main entry with no node builtins",
          "negative control: the node entry does NOT link",
        ],
        assertionFingerprint:
          'await expect ( linkForEdge ( "index.ts" ) ) . resolves . toBeUndefined ( )\nawait expect ( linkForEdge ( "node.ts" ) ) . rejects . toThrow ( /Could not resolve/ )',
      },
    ],
  },
  {
    id: "testing.fake-embedder.deterministic",
    ownerHref: "/docs/api/testing",
    claim:
      "With positive dimensions, inputs containing supported tokens are unit-length and deterministic. Empty or tokenless inputs produce a zero vector; fakeEmbedder({ dims: 0 }) produces an empty vector.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/testing/test/fake-embedder.test.ts",
        testNames: [
          "is deterministic and unit-length per text",
          "returns a zero vector when the input has no supported tokens",
          "returns an empty vector when dimensions are zero",
        ],
        assertionFingerprint:
          "expect ( [ ... a1 ! ] ) . toEqual ( [ ... a2 ! ] )\nexpect ( norm ) . toBeCloseTo ( 1 , 6 )\nexpect ( [ ... empty ! ] ) . toEqual ( Array . from ( { length : 8 } , ( ) => 0 ) )\nexpect ( [ ... punctuation ! ] ) . toEqual ( [ ... empty ! ] )\nexpect ( [ ... oneCharacterTokens ! ] ) . toEqual ( [ ... empty ! ] )\nexpect ( vector ) . toEqual ( new Float32Array ( ) )",
      },
    ],
  },
  {
    id: "testing.harness-isolation",
    ownerHref: "/docs/api/testing",
    claim:
      "AgentHarness reset starts a fresh scenario and clears prior fixtures; close is idempotent and async disposal delegates to it.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/testing/test/harness-fixtures.test.ts",
        testNames: [
          "reset() isolates fixtures across scenarios — a wildcard fixture does not leak",
        ],
        assertionFingerprint:
          'expect ( run1 . finalMessage ) . toBe ( "RUN_1_WILDCARD" )\nexpect ( run2 . finalMessage ) . toBe ( "RUN_2_OWN" )',
      },
      {
        kind: "test-assertion",
        file: "packages/testing/test/harness-construct.test.ts",
        testNames: ["disposes via `await using` (no-throw, idempotent close)"],
        assertionFingerprint:
          "expect ( disposable . baseUrl ) . toMatch ( /\\/v1$/ )\nawait expect ( harness . close ( ) ) . resolves . toBeUndefined ( )",
      },
    ],
  },
  {
    id: "evals.scorer-errors.zero-score",
    ownerHref: "/docs/api/evals",
    claim:
      "runEval records a thrown scorer as a zero with its error reason and continues evaluating the report.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/evals/test/run-eval.test.ts",
        testNames: ["a thrown scorer scores 0 with the error in reason and does not abort"],
        assertionFingerprint:
          "expect(boom.score).toBe(0)\nexpect(boom.reason).toMatch(/kaboom/)\nexpect(report.passed).toBe(true)",
      },
    ],
  },
  {
    id: "evals.run-and-gate",
    ownerHref: "/docs/api/evals",
    claim:
      "runEval scores every case with every scorer; a scorer exception becomes zero without aborting; an explicit gate wins over threshold, and no gate or threshold is informational and passes. gate.perScorer() checks only scorers with explicit thresholds and ignores scorers without one.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/evals/test/run-eval.test.ts",
        testNames: [
          "scores every case×scorer, aggregates, and applies the gate",
          "a thrown scorer scores 0 with the error in reason and does not abort",
          "is informational (passes) when no gate or threshold is set",
        ],
        assertionFingerprint:
          'expect ( report . cases ) . toHaveLength ( 2 )\nexpect ( report . byScorer . find ( ( s ) => s . scorer . startsWith ( "contains" ) ) ?. mean ) . toBe ( 0.5 )\nexpect ( report . passed ) . toBe ( false )\nexpect ( report . gated ) . toBe ( true )\nexpect ( boom . score ) . toBe ( 0 )\nexpect ( boom . reason ) . toMatch ( /kaboom/ )\nexpect ( report . passed ) . toBe ( true )\nexpect ( report . mean ) . toBe ( 0 )\nexpect ( report . gated ) . toBe ( false )\nexpect ( report . passed ) . toBe ( true )',
      },
      {
        kind: "test-assertion",
        file: "packages/evals/test/gate.test.ts",
        testNames: [
          "perScorer() requires each scorer with a threshold to meet it",
          "perScorer() ignores scorer aggregates without an explicit threshold",
          "resolveGate prefers gate, then threshold sugar, then informational",
        ],
        assertionFingerprint:
          'expect ( gate . perScorer ( ) ( report ) . passed ) . toBe ( false )\nexpect ( gate . perScorer ( ) ( { ... report , byScorer : [ { scorer : "informational" , mean : 0 } ] , } ) . passed , ) . toBe ( true )\nexpect ( resolveGate ( { name : "e" , dataset : [ ] , scorers : [ ] , gate : gate . mean ( 0.9 ) } ) ( report ) . passed , ) . toBe ( false )\nexpect ( resolveGate ( { name : "e" , dataset : [ ] , scorers : [ ] , threshold : 0.7 } ) ( report ) . passed , ) . toBe ( true )\nexpect ( resolveGate ( { name : "e" , dataset : [ ] , scorers : [ ] } ) ( report ) . passed ) . toBe ( true )',
      },
    ],
  },
  {
    id: "permissions.match.prefix",
    ownerHref: "/docs/api/permissions",
    claim:
      "Non-reserved command, path, and memory candidates use prefix matching, and deny wins over allow.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/permissions/test/pattern-matching.test.ts",
        testNames: [
          "commands keep prefix matching",
          "treats path candidates with absolute prefixes",
          "allows deeper namespaces under the route",
          "deny wins over allow when both match",
          "deny wins over allow for the memory key",
        ],
        assertionFingerprint:
          'expect ( matchPermission ( "bash" , "ls -la" , { bash : [ "ls" ] } , { } ) ) . toBe ( "allow" )\nexpect ( matchPermission ( "readFile" , "/Users/blove/.zshrc" , { readFile : [ "/Users/blove/" ] } , { } ) , ) . toBe ( "allow" )\nexpect ( matchPermission ( "memory" , "workspace=app|route=/a|tenant=acme|" , allow , { } ) ) . toBe ( "allow" , )\nexpect ( matchPermission ( "bash" , "rm -rf /tmp" , { bash : [ "rm -rf" ] } , { bash : [ "rm -rf" ] } ) ) . toBe ( "deny" , )\nexpect ( matchPermission ( "memory" , "workspace=app|route=/a|" , allow , deny ) ) . toBe ( "deny" )',
      },
    ],
  },
  {
    id: "permissions.tool.exact",
    ownerHref: "/docs/api/permissions",
    claim: "Reserved tool names match exactly rather than by prefix.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/permissions/test/pattern-matching.test.ts",
        testNames: ["does not prefix-match tool names", "matches an exact tool name"],
        assertionFingerprint:
          'expect(matchPermission("tool", "deployProd", { tool: ["deploy"] }, {})).toBe("unknown")\nexpect(matchPermission("tool", "deployProd", { tool: ["deployProd"] }, {})).toBe("allow")',
      },
    ],
  },
  {
    id: "permissions.subagent.exact",
    ownerHref: "/docs/api/permissions",
    claim: "Reserved subagent identities match exactly rather than by prefix.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/permissions/test/pattern-matching.test.ts",
        testNames: [
          "matches an exact parent route and subagent name tuple",
          "does not prefix-match a serialized tuple identity",
        ],
        assertionFingerprint:
          'expect ( matchPermission ( "subagent" , supportResearcher , { subagent : [ supportResearcher ] } , { } ) , ) . toBe ( "allow" )\nexpect ( matchPermission ( "subagent" , `\u0024{ supportResearcher }:extended` , { subagent : [ supportResearcher ] } , { } , ) , ) . toBe ( "unknown" )',
      },
    ],
  },
  {
    id: "permissions.store.noninteractive",
    ownerHref: "/docs/api/permissions",
    claim: "Non-interactive mode ignores the runtime permissions file.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/permissions/test/permissions-store.test.ts",
        testNames: ["ignores the runtime file in non-interactive mode"],
        assertionFingerprint:
          'expect(store.match("bash", "npm install react")).toBe("unknown")\nexpect(store.match("bash", "ls -la")).toBe("allow")',
      },
    ],
  },
  {
    id: "workspace.compose.order",
    ownerHref: "/docs/api/workspace",
    claim: "Backend middleware composes right-to-left, with the first listed middleware outermost.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/workspace/test/compose.test.ts",
        testNames: ["applies middlewares right-to-left (outermost first)"],
        assertionFingerprint:
          'expect(trace).toEqual(["a:before", "b:before", "b:after", "a:after"])',
      },
    ],
  },
  {
    id: "workspace.exec.timeout",
    ownerHref: "/docs/api/workspace",
    claim: "The local exec backend enforces its configured timeout.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/workspace/test/local-exec.test.ts",
        testNames: ["runCommand enforces timeout"],
        assertionFingerprint:
          'await expect ( exec . runCommand ( { command : "sleep 1" } , ctx ( root ) ) , ) . rejects . toThrow ( /timeout/i )',
      },
    ],
  },
  {
    id: "workspace.filesystem.symlink",
    ownerHref: "/docs/api/workspace",
    claim:
      "localFilesystem.realPath resolves an escaping symlink to its outside real path; Core owns any path-jail enforcement.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/workspace/test/local-filesystem.test.ts",
        testNames: ["realPath resolves an escaping symlink to the outside real path"],
        assertionFingerprint:
          "expect(await fs.realPath(link, ctx(root))).toBe(realpathSync(target))",
      },
      {
        kind: "test-assertion",
        file: "packages/core/test/capabilities/workspace-fs.test.ts",
        testNames: ["gates a symlink that escapes the workspace (caught, not silently allowed)"],
        assertionFingerprint: 'await expect(fs.readFile("escape")).rejects.toThrow(/fail-closed/)',
      },
    ],
  },
  {
    id: "sandbox.docker.release",
    ownerHref: "/docs/api/sandbox",
    claim: "Docker release removes the container but retains its volume; destroy removes both.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sandbox/test/docker-sandbox.unit.test.ts",
        testNames: ["release removes container but not volume; destroy removes both"],
        assertionFingerprint:
          'expect(runs.some((r) => r[0] === "rm" && r.includes("dawn-sbx-abc"))).toBe(true)\nexpect(runs.some((r) => r[0] === "volume" && r[1] === "rm")).toBe(false)\nexpect ( runs . some ( ( r ) => r [ 0 ] === "volume" && r [ 1 ] === "rm" && r . includes ( "dawn-sbx-vol-abc" ) ) , ) . toBe ( true )',
      },
    ],
  },
  {
    id: "sandbox.kubernetes.release",
    ownerHref: "/docs/api/sandbox",
    claim: "Kubernetes release deletes the Pod but retains the PVC; destroy removes both.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sandbox/test/kube-sandbox.unit.test.ts",
        testNames: ["release deletes the pod but keeps the PVC; destroy removes both"],
        assertionFingerprint:
          'expect(k.pods.has("dawn-sbx-t")).toBe(false)\nexpect(k.pvcs.has("dawn-sbx-vol-t")).toBe(true)\nexpect(k.pvcs.has("dawn-sbx-vol-t")).toBe(false)',
      },
    ],
  },
  {
    id: "sandbox.kubernetes.allow-network",
    ownerHref: "/docs/api/sandbox",
    claim: "Kubernetes network:allow without an allowlist emits no NetworkPolicy.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sandbox/test/kube-sandbox.unit.test.ts",
        testNames: ["network:allow with no allowlist emits no NetworkPolicy"],
        assertionFingerprint: 'expect(k.netpols.has("dawn-sbx-net-t")).toBe(false)',
      },
    ],
  },
  {
    id: "sandbox.error.create",
    ownerHref: "/docs/api/sandbox",
    claim: "A failed sandbox container creation is tagged DAWN_E2001.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sandbox/test/sandbox-error-code.test.ts",
        testNames: ["a failed container creation throws an error tagged DAWN_E2001"],
        assertionFingerprint:
          'await expect ( p . acquire ( { threadId : "t1" , policy : { network : { mode : "deny" } } , signal : signal ( ) } ) , ) . rejects . toMatchObject ( { code : "DAWN_E2001" } )',
      },
    ],
  },
  {
    id: "langgraph.entry.exclusive",
    ownerHref: "/docs/api/langgraph",
    claim: "A route module must provide exactly one of graph or workflow.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/langgraph/test/define-entry.test.ts",
        testNames: [
          "rejects modules that provide both graph and workflow",
          "rejects modules that provide neither graph nor workflow",
        ],
        assertionFingerprint:
          'expect ( ( ) => defineEntry ( { graph , workflow , } as never ) , ) . toThrow ( `Route index.ts must export exactly one of "workflow" or "graph"` )\nexpect ( ( ) => normalizeRouteModule ( invalidModule as never ) ) . toThrow ( `Route index.ts must export exactly one of "workflow" or "graph"` , )\nexpect ( ( ) => defineEntry ( { } as never ) ) . toThrow ( `Route index.ts exports neither "workflow" nor "graph"` , )\nexpect ( ( ) => normalizeRouteModule ( { } as never ) ) . toThrow ( `Route index.ts exports neither "workflow" nor "graph"` , )',
      },
    ],
  },
  {
    id: "langgraph.route-module.surface",
    ownerHref: "/docs/api/langgraph",
    claim:
      "The route-module subpath exposes only its published normalization and route-module contracts.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/langgraph/test/route-module.test.ts",
        testNames: ["exposes publishable exports and types on the package surface"],
        assertionFingerprint:
          'expect ( packageJson . types ) . toBe ( "./dist/index.d.ts" )\nexpect ( packageJson . exports [ "." ] ?. types ) . toBe ( "./dist/index.d.ts" )\nexpect ( packageJson . exports [ "." ] ?. default ) . toBe ( "./dist/index.js" )\nexpect ( packageJson . exports [ "./route-module" ] ?. types ) . toBe ( "./dist/route-module.d.ts" )',
      },
    ],
  },
  {
    id: "langchain.provider.explicit",
    ownerHref: "/docs/api/langchain",
    claim: "An explicit model provider bypasses provider inference.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/langchain/test/model-provider-resolver.test.ts",
        testNames: ["explicit provider bypasses inference"],
        assertionFingerprint:
          'expect ( resolveProvider ( { provider : "groq" , model : "llama-3.3-70b-versatile" } ) ) . toBe ( "groq" )',
      },
    ],
  },
  {
    id: "langchain.retry.exhaustion",
    ownerHref: "/docs/api/langchain",
    claim: "Retry throws after the configured maximum attempts are exhausted.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/langchain/test/retry.test.ts",
        testNames: ["throws after max attempts exhausted"],
        assertionFingerprint:
          'await expect ( withRetry ( async ( ) => { attempts ++ throw new Error ( "503 Service Unavailable" ) } , { baseDelayMs : 10 , maxAttempts : 2 } , ) , ) . rejects . toThrow ( "503 Service Unavailable" )\nexpect ( attempts ) . toBe ( 2 )',
      },
    ],
  },
  {
    id: "langchain.tool-loop.limit",
    ownerHref: "/docs/api/langchain",
    claim: "The tool loop limits iterations to prevent an infinite loop.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/langchain/test/tool-loop.test.ts",
        testNames: ["limits tool loop iterations to prevent infinite loops"],
        assertionFingerprint:
          'await expect ( executeWithToolLoop ( { chain : mockChain , input : { } , tools , signal : new AbortController ( ) . signal , maxIterations : 3 , } ) , ) . rejects . toThrow ( /maximum.*iterations/i )',
      },
    ],
  },
  {
    id: "langchain.chain.stream-fallback",
    ownerHref: "/docs/api/langchain",
    claim: "A chain stream falls back to invoke when the entry has no stream method.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/langchain/test/chain-adapter.test.ts",
        testNames: ["stream falls back to invoke when no stream method"],
        assertionFingerprint: 'expect ( chunks ) . toEqual ( [ { result : { msg : "hi" } } ] )',
      },
    ],
  },
  {
    id: "sqlite.checkpointer.persistence",
    ownerHref: "/docs/api/sqlite-storage",
    claim: "A file-backed SQLite checkpoint persists across saver instances.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sqlite-storage/test/checkpointer.test.ts",
        testNames: ["persists across saver instances (file-backed)"],
        assertionFingerprint: "expect(t?.checkpoint.channel_values).toEqual({ x: 1 })",
      },
    ],
  },
  {
    id: "sqlite.threads.order",
    ownerHref: "/docs/api/sqlite-storage",
    claim: "listThreads returns most-recently-updated threads first.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sqlite-storage/test/threads.test.ts",
        testNames: ["listThreads returns most-recently-updated first"],
        assertionFingerprint:
          "expect(list[0]?.thread_id).toBe(b.thread_id)\nexpect(list[1]?.thread_id).toBe(a.thread_id)",
      },
    ],
  },
  {
    id: "sqlite.db.pragmas",
    ownerHref: "/docs/api/sqlite-storage",
    claim: "SQLite opens with WAL mode, foreign keys enabled, and synchronous NORMAL.",
    authorities: [
      {
        kind: "test-assertion",
        file: "packages/sqlite-storage/test/db.test.ts",
        testNames: [
          "opens a database with WAL journal_mode, foreign_keys ON, and synchronous=NORMAL",
        ],
        assertionFingerprint:
          'expect(journal.journal_mode).toBe("wal")\nexpect(fk.foreign_keys).toBe(1)\nexpect(sync.synchronous).toBe(1)',
      },
    ],
  },
  {
    id: "sqlite.public.no-close",
    ownerHref: "/docs/api/sqlite-storage",
    claim: "The public SQLite saver and thread store expose no explicit close method.",
    authorities: [
      {
        kind: "source-ast",
        file: "packages/sqlite-storage/src/checkpointer/saver.ts",
        selector: "DawnSqliteSaver.publicMembers",
        expected: "public members: deleteThread, getTuple, list, put, putWrites",
      },
      {
        kind: "source-ast",
        file: "packages/sqlite-storage/src/threads/store.ts",
        selector: "ThreadsStore.publicMembers",
        expected:
          "public members: createThread, deleteThread, getThread, listThreads, updateMetadata, updateStatus",
      },
    ],
  },
] as const satisfies readonly ApiBehaviorContract[]

interface ArtifactPolicy {
  readonly coverage: ApiReferenceCoverage
  readonly audience: ApiReferenceAudience
  readonly stability: ApiReferenceStability
}

export interface RuntimeImportArtifact extends ArtifactPolicy {
  readonly kind: "import"
  readonly packageName: string
  readonly subpath: string
  readonly surfaceKind: "typescript-runtime"
  readonly runtime: RuntimeCompatibility
  readonly purity: RuntimePurity
  readonly guardIds: readonly ApiReferenceGuardId[]
}

export interface StaticImportArtifact extends ArtifactPolicy {
  readonly kind: "import"
  readonly packageName: string
  readonly subpath: string
  readonly surfaceKind: "config-artifact" | "metadata"
}

export interface GeneratedTypesArtifact extends ArtifactPolicy {
  readonly kind: "generated"
  readonly moduleName: "dawn:routes"
  readonly ownerHref: "/docs/api/generated-routes"
  readonly surfaceKind: "generated-types"
  readonly coverage: "detailed"
  readonly audience: "application"
  readonly stability: "supported"
}

export interface OperatedArtifact extends ArtifactPolicy {
  readonly kind: "operated"
  readonly packageName: string
  readonly selector: string
  readonly operatedKind: OperatedArtifactKind
  readonly manifestTarget: string
  readonly runtime: RuntimeCompatibility
  readonly guardIds: readonly ApiReferenceGuardId[]
}

export type ApiReferenceArtifact =
  | RuntimeImportArtifact
  | StaticImportArtifact
  | GeneratedTypesArtifact
  | OperatedArtifact

export interface PackageCatalogEntry {
  readonly packageName: string
  readonly purpose: string
  readonly readmePath: string
  readonly canonicalReferenceDestination: string
  readonly conceptualGuideDestination: string
  readonly artifactAddresses: readonly string[]
  readonly audience: ApiReferenceAudience
  readonly stability: ApiReferenceStability
}

// Authored signatures are intentionally selective, but selection itself must
// fail closed: removing a tag cannot silently turn a high-value contract into
// an ordinary example. The inventory analyzer resolves every key back to the
// public source export and its canonical owner page.
export const API_REQUIRED_CONTRACT_KEYS = [
  "@dawn-ai/langchain#.:AgentStreamChunk",
  "@dawn-ai/langchain#.:OffloadToolOutputCtx",
  "@dawn-ai/langchain#.:RetryOptions",
  "@dawn-ai/langchain#.:UnwrappedToolResult",
  "@dawn-ai/langchain#.:resolveProvider",
  "@dawn-ai/langchain#.:withRetry",
  "@dawn-ai/langgraph#./define-entry:defineEntry",
  "@dawn-ai/langgraph#./route-module:GraphRouteModule",
  "@dawn-ai/langgraph#./route-module:NormalizedRouteModule",
  "@dawn-ai/langgraph#./route-module:RouteModule",
  "@dawn-ai/langgraph#./route-module:WorkflowRouteModule",
  "@dawn-ai/langgraph#./route-module:assertExactlyOneEntry",
  "@dawn-ai/langgraph#./route-module:normalizeRouteModule",
  "@dawn-ai/ag-ui#./sse:encodeAgUiSse",
  "@dawn-ai/ag-ui#.:DAWN_PLAN_ACTIVITY_TYPE",
  "@dawn-ai/ag-ui#.:DAWN_SUBAGENT_ACTIVITY_TYPE",
  "@dawn-ai/ag-ui#.:DawnRunInput",
  "@dawn-ai/ag-ui#.:DawnPlanActivityContent",
  "@dawn-ai/ag-ui#.:DawnSubagentActivityContent",
  "@dawn-ai/ag-ui#.:RunContext",
  "@dawn-ai/ag-ui#.:ToAguiOptions",
  "@dawn-ai/ag-ui#.:fromRunAgentInput",
  "@dawn-ai/ag-ui#.:toAguiEvents",
  "@dawn-ai/cli#.:ServeRuntimeOptions",
  "@dawn-ai/cli#.:serveRuntime",
  "@dawn-ai/core#.:loadDawnConfig",
  "@dawn-ai/core#.:resolveStateFields",
  "@dawn-ai/evals#.:EvalCase",
  "@dawn-ai/evals#.:EvalDefinition",
  "@dawn-ai/evals#.:EvalReport",
  "@dawn-ai/evals#.:RunEvalOptions",
  "@dawn-ai/evals#.:Scorer",
  "@dawn-ai/evals#.:defineEval",
  "@dawn-ai/evals#.:runEval",
  "@dawn-ai/memory#./namespace:MemoryScopeTuple",
  "@dawn-ai/memory#./namespace:serializeNamespace",
  "@dawn-ai/memory#./reconcile:approveWithReconcile",
  "@dawn-ai/memory#.:BrowsePage",
  "@dawn-ai/memory#.:BrowseQuery",
  "@dawn-ai/memory#.:MemoryQuery",
  "@dawn-ai/memory#.:MemoryRecord",
  "@dawn-ai/memory#.:MemoryStore",
  "@dawn-ai/memory-pgvector#.:PgvectorMemoryStore",
  "@dawn-ai/memory-pgvector#.:pgvectorMemoryStore",
  "@dawn-ai/postgres-storage#./node:NodePostgresPermissionsStoreOptions",
  "@dawn-ai/postgres-storage#./node:NodePostgresStoreOptions",
  "@dawn-ai/postgres-storage#./node:createPostgresPermissionsStore",
  "@dawn-ai/postgres-storage#./node:createPostgresThreadsStore",
  "@dawn-ai/postgres-storage#./node:postgresCheckpointer",
  "@dawn-ai/postgres-storage#.:PostgresPermissionsStoreOptions",
  "@dawn-ai/postgres-storage#.:PostgresStoreOptions",
  "@dawn-ai/postgres-storage#.:createPostgresPermissionsStore",
  "@dawn-ai/postgres-storage#.:createPostgresThreadsStore",
  "@dawn-ai/postgres-storage#.:postgresCheckpointer",
  "@dawn-ai/sandbox#./testing:runProviderConformance",
  "@dawn-ai/sandbox#.:KubernetesSandboxOptions",
  "@dawn-ai/sandbox#.:dockerSandbox",
  "@dawn-ai/sandbox#.:kubernetesSandbox",
  "@dawn-ai/permissions#.:PermissionDecision",
  "@dawn-ai/permissions#.:PermissionMode",
  "@dawn-ai/permissions#.:PermissionsFile",
  "@dawn-ai/permissions#.:PermissionsStore",
  "@dawn-ai/sdk#.:AgentConfig",
  "@dawn-ai/sdk#.:ReasoningConfig",
  "@dawn-ai/sdk#.:RetryConfig",
  "@dawn-ai/sdk#.:RouteConfig",
  "@dawn-ai/sdk#.:agent",
  "@dawn-ai/sdk#.:allow",
  "@dawn-ai/sdk#.:defineMemory",
  "@dawn-ai/sdk#.:defineMiddleware",
  "@dawn-ai/sdk#.:isDawnAgent",
  "@dawn-ai/sdk#.:reject",
  "@dawn-ai/sdk#.:validateModelId",
  "@dawn-ai/sqlite-storage#.:CreateThreadInput",
  "@dawn-ai/sqlite-storage#.:SqliteCheckpointerOptions",
  "@dawn-ai/sqlite-storage#.:Thread",
  "@dawn-ai/sqlite-storage#.:ThreadStatus",
  "@dawn-ai/sqlite-storage#.:ThreadsStore",
  "@dawn-ai/sqlite-storage#.:ThreadsStoreOptions",
  "@dawn-ai/sqlite-storage#.:createThreadsStore",
  "@dawn-ai/sqlite-storage#.:sqliteCheckpointer",
  "@dawn-ai/testing#.:AgentHarness",
  "@dawn-ai/testing#.:AgentHarnessOptions",
  "@dawn-ai/testing#.:ScriptBuilder",
  "@dawn-ai/testing#.:createAgentHarness",
  "@dawn-ai/testing#.:fakeEmbedder",
  "@dawn-ai/testing#.:loadFixtures",
  "@dawn-ai/testing#.:runCheckpointerConformance",
  "@dawn-ai/testing#.:runMemoryStoreConformance",
  "@dawn-ai/testing#.:runPermissionsStoreConformance",
  "@dawn-ai/testing#.:runThreadsStoreConformance",
  "@dawn-ai/testing#.:writeFixtures",
  "@dawn-ai/workspace#./node:LocalExecOptions",
  "@dawn-ai/workspace#./node:LocalFilesystemOptions",
  "@dawn-ai/workspace#./node:localExec",
  "@dawn-ai/workspace#./node:localFilesystem",
  "@dawn-ai/workspace#.:BackendContext",
  "@dawn-ai/workspace#.:ExecBackend",
  "@dawn-ai/workspace#.:FilesystemBackend",
  "@dawn-ai/workspace#.:SandboxConfig",
  "@dawn-ai/workspace#.:SandboxHandle",
  "@dawn-ai/workspace#.:SandboxPolicy",
  "@dawn-ai/workspace#.:SandboxProvider",
  "@dawn-ai/workspace#.:SandboxSecurityPolicy",
  "@dawn-ai/workspace#.:compose",
] as const satisfies readonly ApiContractKey[]

function runtimeImport(
  packageName: string,
  subpath: string,
  coverage: ApiReferenceCoverage,
  runtime: RuntimeCompatibility,
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability = "supported",
  purity: RuntimePurity = "not-claimed",
): RuntimeImportArtifact {
  const guardIds: readonly ApiReferenceGuardId[] =
    runtime === "edge-safe"
      ? [
          "edge-import-bundle",
          ...(purity === "dependency-free" ? (["dependency-free-import-graph"] as const) : []),
        ]
      : [
          "node-import-bundle",
          "browser-import-negative-control",
          ...(purity === "dependency-free" ? (["dependency-free-import-graph"] as const) : []),
        ]
  return {
    kind: "import",
    packageName,
    subpath,
    coverage,
    surfaceKind: "typescript-runtime",
    runtime,
    audience,
    purity,
    stability,
    guardIds,
  }
}

function staticImport(
  packageName: string,
  subpath: string,
  coverage: ApiReferenceCoverage,
  surfaceKind: StaticImportArtifact["surfaceKind"],
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability,
): StaticImportArtifact {
  return { kind: "import", packageName, subpath, coverage, surfaceKind, audience, stability }
}

function operatedArtifact(
  packageName: string,
  selector: string,
  operatedKind: OperatedArtifactKind,
  manifestTarget: string,
  coverage: ApiReferenceCoverage,
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability = "supported",
): OperatedArtifact {
  return {
    kind: "operated",
    packageName,
    selector,
    operatedKind,
    manifestTarget,
    coverage,
    runtime: "node-only",
    guardIds: ["node-operated-bundle", "browser-operated-negative-control"],
    audience,
    stability,
  }
}

export const GENERATED_ROUTES_ARTIFACT = {
  kind: "generated",
  moduleName: "dawn:routes",
  ownerHref: "/docs/api/generated-routes",
  surfaceKind: "generated-types",
  coverage: "detailed",
  audience: "application",
  stability: "supported",
} as const satisfies GeneratedTypesArtifact

export const ARTIFACT_REGISTRY = [
  runtimeImport("@dawn-ai/sdk", ".", "detailed", "edge-safe", "application"),
  runtimeImport(
    "@dawn-ai/sdk",
    "./pure",
    "detailed",
    "edge-safe",
    "integration",
    "supported",
    "dependency-free",
  ),
  runtimeImport("@dawn-ai/sdk", "./testing", "detailed", "node-only", "testing"),
  runtimeImport("@dawn-ai/cli", ".", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/cli", "./fetch", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/cli", "./runtime", "detailed", "node-only", "tooling", "low-level"),
  runtimeImport("@dawn-ai/cli", "./testing", "detailed", "node-only", "testing"),
  runtimeImport("@dawn-ai/core", ".", "detailed", "edge-safe", "integration", "low-level"),
  runtimeImport("@dawn-ai/core", "./node", "detailed", "node-only", "integration", "low-level"),
  runtimeImport(
    "@dawn-ai/core",
    "./internal/compiler",
    "internal",
    "node-only",
    "internal",
    "internal",
  ),
  runtimeImport("@dawn-ai/ag-ui", ".", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/ag-ui", "./sse", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/memory", ".", "detailed", "node-only", "application"),
  runtimeImport(
    "@dawn-ai/memory",
    "./browse",
    "detailed",
    "edge-safe",
    "integration",
    "supported",
    "dependency-free",
  ),
  runtimeImport("@dawn-ai/memory", "./namespace", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/memory", "./reconcile", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/memory-pgvector", ".", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/postgres-storage", ".", "detailed", "edge-safe", "application"),
  runtimeImport("@dawn-ai/postgres-storage", "./node", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/testing", ".", "detailed", "node-only", "testing"),
  runtimeImport("@dawn-ai/evals", ".", "detailed", "node-only", "testing"),

  runtimeImport("@dawn-ai/permissions", ".", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/permissions", "./node", "detailed", "node-only", "integration"),
  runtimeImport(
    "@dawn-ai/workspace",
    ".",
    "detailed",
    "edge-safe",
    "application",
    "supported",
    "dependency-free",
  ),
  runtimeImport("@dawn-ai/workspace", "./node", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/sandbox", ".", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/sandbox", "./testing", "detailed", "node-only", "testing"),
  runtimeImport(
    "@dawn-ai/langgraph",
    ".",
    "detailed",
    "edge-safe",
    "integration",
    "supported",
    "dependency-free",
  ),
  runtimeImport(
    "@dawn-ai/langgraph",
    "./define-entry",
    "detailed",
    "edge-safe",
    "integration",
    "supported",
    "dependency-free",
  ),
  runtimeImport(
    "@dawn-ai/langgraph",
    "./route-module",
    "detailed",
    "edge-safe",
    "integration",
    "supported",
    "dependency-free",
  ),
  runtimeImport("@dawn-ai/langchain", ".", "detailed", "edge-safe", "integration"),
  staticImport(
    "@dawn-ai/langchain",
    "./package.json",
    "detailed",
    "metadata",
    "tooling",
    "supported",
  ),
  runtimeImport("@dawn-ai/sqlite-storage", ".", "detailed", "node-only", "application"),

  staticImport(
    "@dawn-ai/config-biome",
    ".",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-biome",
    "./biome",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    ".",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./base",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./library",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./node",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./nextjs",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  runtimeImport("@dawn-ai/devkit", ".", "internal", "node-only", "internal", "internal"),
  runtimeImport("@dawn-ai/vite-plugin", ".", "internal", "node-only", "internal", "internal"),

  operatedArtifact(
    "@dawn-ai/cli",
    "bin.dawn",
    "executable",
    "./dist/index.js",
    "detailed",
    "tooling",
  ),
  operatedArtifact(
    "create-dawn-ai-app",
    "bin.create-dawn-ai-app",
    "executable",
    "./dist/bin.js",
    "catalog-only",
    "tooling",
  ),
  operatedArtifact(
    "@dawn-ai/inspector",
    "dawnInspector.server",
    "operated-application",
    ".next/standalone/packages/inspector/server.js",
    "catalog-only",
    "tooling",
  ),
  GENERATED_ROUTES_ARTIFACT,
] as const satisfies readonly ApiReferenceArtifact[]

export function artifactAddressFor(artifact: ApiReferenceArtifact): string {
  if (artifact.kind === "import") return `import:${artifact.packageName}:${artifact.subpath}`
  if (artifact.kind === "operated") return `operated:${artifact.packageName}:${artifact.selector}`
  return `generated:${artifact.moduleName}`
}

export function artifactBoundaryFor(artifact: ApiReferenceArtifact): string {
  const documentation =
    artifact.coverage === "detailed"
      ? "focused reference"
      : artifact.coverage === "internal"
        ? "internal only"
        : "catalog summary"
  if (artifact.kind === "generated") {
    return `${documentation} · generated types; compile-time only, no runtime import · purity n/a`
  }
  if (artifact.kind === "operated") {
    const operation =
      artifact.operatedKind === "executable"
        ? "executable command"
        : "separately operated application"
    return `${documentation} · \`${artifact.runtime}\` ${operation} · purity n/a`
  }
  if (artifact.surfaceKind === "typescript-runtime") {
    return `${documentation} · \`${artifact.runtime}\` runtime · \`${artifact.purity}\` purity`
  }
  if (artifact.surfaceKind === "config-artifact") {
    return `${documentation} · static configuration; no runtime import · purity n/a`
  }
  if (artifact.surfaceKind === "metadata") {
    return `${documentation} · package metadata; read as data, not runtime code · purity n/a`
  }
  return `${documentation} · package metadata; read as data, not runtime code · purity n/a`
}

const importAddress = (packageName: string, subpath: string) =>
  `import:${packageName}:${subpath}` as const
const operatedAddress = (packageName: string, selector: string) =>
  `operated:${packageName}:${selector}` as const

export const PACKAGE_CATALOG = [
  packageEntry(
    "@dawn-ai/ag-ui",
    "AG-UI protocol translation for Dawn runtimes and web clients.",
    "packages/ag-ui/README.md",
    "/docs/api/ag-ui",
    "/docs/ag-ui",
    [importAddress("@dawn-ai/ag-ui", "."), importAddress("@dawn-ai/ag-ui", "./sse")],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/cli",
    "Dawn development, build, type generation, and runtime commands.",
    "packages/cli/README.md",
    "/docs/api/cli",
    "/docs/cli",
    [
      importAddress("@dawn-ai/cli", "."),
      importAddress("@dawn-ai/cli", "./fetch"),
      importAddress("@dawn-ai/cli", "./runtime"),
      importAddress("@dawn-ai/cli", "./testing"),
      operatedAddress("@dawn-ai/cli", "bin.dawn"),
    ],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/config-biome",
    "Shared Biome configuration for Dawn projects.",
    "packages/config-biome/README.md",
    "/docs/api#dawn-ai-config-biome",
    "/docs/getting-started",
    [
      importAddress("@dawn-ai/config-biome", "."),
      importAddress("@dawn-ai/config-biome", "./biome"),
    ],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/config-typescript",
    "Shared TypeScript configurations for Dawn projects.",
    "packages/config-typescript/README.md",
    "/docs/api#dawn-ai-config-typescript",
    "/docs/getting-started",
    [
      importAddress("@dawn-ai/config-typescript", "."),
      importAddress("@dawn-ai/config-typescript", "./base"),
      importAddress("@dawn-ai/config-typescript", "./library"),
      importAddress("@dawn-ai/config-typescript", "./node"),
      importAddress("@dawn-ai/config-typescript", "./nextjs"),
    ],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/core",
    "Route discovery, app configuration, capabilities, and type generation.",
    "packages/core/README.md",
    "/docs/api/core",
    "/docs/routes",
    [
      importAddress("@dawn-ai/core", "."),
      importAddress("@dawn-ai/core", "./node"),
      importAddress("@dawn-ai/core", "./internal/compiler"),
    ],
    "integration",
    "low-level",
  ),
  packageEntry(
    "@dawn-ai/devkit",
    "Internal scaffold templates and generated-app test utilities.",
    "packages/devkit/README.md",
    "/docs/api#dawn-ai-devkit",
    "/docs/getting-started",
    [importAddress("@dawn-ai/devkit", ".")],
    "internal",
    "internal",
  ),
  packageEntry(
    "@dawn-ai/evals",
    "Evaluation definitions, scorers, datasets, and runners.",
    "packages/evals/README.md",
    "/docs/api/evals",
    "/docs/evals",
    [importAddress("@dawn-ai/evals", ".")],
    "testing",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/inspector",
    "Browser application for inspecting a running Dawn app.",
    "packages/inspector/README.md",
    "/docs/api#dawn-ai-inspector",
    "/docs/inspector",
    [operatedAddress("@dawn-ai/inspector", "dawnInspector.server")],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/langchain",
    "LangChain backend adapters for Dawn agents and chains.",
    "packages/langchain/README.md",
    "/docs/api/langchain",
    "/docs/agents",
    [
      importAddress("@dawn-ai/langchain", "."),
      importAddress("@dawn-ai/langchain", "./package.json"),
    ],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/langgraph",
    "LangGraph runtime adapters and route contracts.",
    "packages/langgraph/README.md",
    "/docs/api/langgraph",
    "/docs/routes",
    [
      importAddress("@dawn-ai/langgraph", "."),
      importAddress("@dawn-ai/langgraph", "./define-entry"),
      importAddress("@dawn-ai/langgraph", "./route-module"),
    ],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/memory",
    "Long-term memory storage, ranking, browsing, and reconciliation.",
    "packages/memory/README.md",
    "/docs/api/memory",
    "/docs/memory/long-term",
    [
      importAddress("@dawn-ai/memory", "."),
      importAddress("@dawn-ai/memory", "./browse"),
      importAddress("@dawn-ai/memory", "./namespace"),
      importAddress("@dawn-ai/memory", "./reconcile"),
    ],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/memory-pgvector",
    "Postgres and pgvector storage for shared long-term memory.",
    "packages/memory-pgvector/README.md",
    "/docs/api/memory-pgvector",
    "/docs/memory/long-term",
    [importAddress("@dawn-ai/memory-pgvector", ".")],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/permissions",
    "Permission matching and Node-backed approval stores.",
    "packages/permissions/README.md",
    "/docs/api/permissions",
    "/docs/permissions",
    [importAddress("@dawn-ai/permissions", "."), importAddress("@dawn-ai/permissions", "./node")],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/postgres-storage",
    "Postgres persistence for checkpoints, threads, and permissions.",
    "packages/postgres-storage/README.md",
    "/docs/api/postgres-storage",
    "/docs/persistence",
    [
      importAddress("@dawn-ai/postgres-storage", "."),
      importAddress("@dawn-ai/postgres-storage", "./node"),
    ],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/sandbox",
    "Docker-backed isolated workspace execution for Dawn agents.",
    "packages/sandbox/README.md",
    "/docs/api/sandbox",
    "/docs/sandbox",
    [importAddress("@dawn-ai/sandbox", "."), importAddress("@dawn-ai/sandbox", "./testing")],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/sdk",
    "Author-facing declarations for agents, tools, middleware, and routes.",
    "packages/sdk/README.md",
    "/docs/api/sdk",
    "/docs/agents",
    [
      importAddress("@dawn-ai/sdk", "."),
      importAddress("@dawn-ai/sdk", "./pure"),
      importAddress("@dawn-ai/sdk", "./testing"),
    ],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/sqlite-storage",
    "Local SQLite persistence for Dawn runtime state.",
    "packages/sqlite-storage/README.md",
    "/docs/api/sqlite-storage",
    "/docs/persistence",
    [importAddress("@dawn-ai/sqlite-storage", ".")],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/testing",
    "Harnesses, fixtures, matchers, and runtime test utilities.",
    "packages/testing/README.md",
    "/docs/api/testing",
    "/docs/testing-agents",
    [importAddress("@dawn-ai/testing", ".")],
    "testing",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/vite-plugin",
    "Internal Vite integration for Dawn type generation.",
    "packages/vite-plugin/README.md",
    "/docs/api#dawn-ai-vite-plugin",
    "/docs/routes",
    [importAddress("@dawn-ai/vite-plugin", ".")],
    "internal",
    "internal",
  ),
  packageEntry(
    "@dawn-ai/workspace",
    "Filesystem and shell tools for agent workspaces.",
    "packages/workspace/README.md",
    "/docs/api/workspace",
    "/docs/workspace",
    [importAddress("@dawn-ai/workspace", "."), importAddress("@dawn-ai/workspace", "./node")],
    "application",
    "supported",
  ),
  packageEntry(
    "create-dawn-ai-app",
    "Scaffolder for new Dawn applications.",
    "packages/create-dawn-app/README.md",
    "/docs/api#create-dawn-ai-app",
    "/docs/getting-started",
    [operatedAddress("create-dawn-ai-app", "bin.create-dawn-ai-app")],
    "tooling",
    "supported",
  ),
] as const satisfies readonly PackageCatalogEntry[]

function packageEntry(
  packageName: string,
  purpose: string,
  readmePath: string,
  canonicalReferenceDestination: string,
  conceptualGuideDestination: string,
  artifactAddresses: readonly string[],
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability,
): PackageCatalogEntry {
  return {
    packageName,
    purpose,
    readmePath,
    canonicalReferenceDestination,
    conceptualGuideDestination,
    artifactAddresses,
    audience,
    stability,
  }
}

interface ApiReferenceRegistries {
  readonly pages: readonly ApiReferencePage[]
  readonly artifacts: readonly ApiReferenceArtifact[]
  readonly packages: readonly PackageCatalogEntry[]
}

const COVERAGES = new Set<ApiReferenceCoverage>([
  "detailed",
  "catalog-only",
  "internal",
  "deferred-to-pr2",
])
const AUDIENCES = new Set<ApiReferenceAudience>([
  "application",
  "integration",
  "testing",
  "tooling",
  "internal",
])
const STABILITIES = new Set<ApiReferenceStability>(["supported", "low-level", "internal"])
const RUNTIMES = new Set<RuntimeCompatibility>(["node-only", "edge-safe"])
const PURITIES = new Set<RuntimePurity>(["dependency-free", "not-claimed"])
const GUARD_IDS = new Set<ApiReferenceGuardId>(API_REFERENCE_GUARD_IDS)
const STATIC_SURFACES = new Set<StaticImportArtifact["surfaceKind"]>([
  "config-artifact",
  "metadata",
])
const OPERATED_ONLY_PACKAGES = new Set(["create-dawn-ai-app", "@dawn-ai/inspector"])

function assertExactFields(
  artifact: ApiReferenceArtifact,
  record: Record<string, unknown>,
  fields: readonly string[],
): void {
  const expected = new Set(fields)
  const unexpected = Object.keys(record).filter((field) => !expected.has(field))
  const missing = fields.filter((field) => !Object.hasOwn(record, field))
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `invalid artifact fields for ${artifactAddressFor(artifact)} (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
    )
  }
}

function validateArtifact(artifact: ApiReferenceArtifact): void {
  const record = artifact as unknown as Record<string, unknown>
  if (!COVERAGES.has(artifact.coverage)) throw new Error(`invalid coverage: ${artifact.coverage}`)
  if (!AUDIENCES.has(artifact.audience)) throw new Error(`invalid audience: ${artifact.audience}`)
  if (!STABILITIES.has(artifact.stability))
    throw new Error(`invalid stability: ${artifact.stability}`)
  if (
    (artifact.coverage === "catalog-only" || artifact.coverage === "internal") &&
    artifact.audience === "application"
  ) {
    throw new Error(`${artifact.coverage} artifacts cannot use the application audience`)
  }

  if (artifact.kind === "generated") {
    assertExactFields(artifact, record, [
      "kind",
      "moduleName",
      "ownerHref",
      "surfaceKind",
      "coverage",
      "audience",
      "stability",
    ])
    if (
      artifact.moduleName !== "dawn:routes" ||
      artifact.ownerHref !== "/docs/api/generated-routes" ||
      artifact.surfaceKind !== "generated-types" ||
      artifact.coverage !== "detailed" ||
      artifact.audience !== "application" ||
      artifact.stability !== "supported"
    ) {
      throw new Error(
        "dawn:routes generated artifact must use the canonical owner, generated-types category, application audience, and supported stability",
      )
    }
    return
  }

  if (artifact.kind === "import") {
    if (OPERATED_ONLY_PACKAGES.has(artifact.packageName)) {
      throw new Error(`${artifact.packageName} is an operated artifact, not an import surface`)
    }
    if (artifact.subpath !== "." && !artifact.subpath.startsWith("./")) {
      throw new Error(`invalid import subpath or operated selector: ${artifact.subpath}`)
    }
    if (artifact.surfaceKind === "typescript-runtime") {
      assertExactFields(artifact, record, [
        "kind",
        "packageName",
        "subpath",
        "coverage",
        "surfaceKind",
        "runtime",
        "audience",
        "purity",
        "stability",
        "guardIds",
      ])
      if (!RUNTIMES.has(artifact.runtime)) throw new Error(`invalid runtime: ${artifact.runtime}`)
      if (!PURITIES.has(artifact.purity)) throw new Error(`invalid purity: ${artifact.purity}`)
      validateGuardIds(artifact)
      return
    }
    if (!STATIC_SURFACES.has(artifact.surfaceKind)) {
      throw new Error(`invalid import surface kind: ${String(artifact.surfaceKind)}`)
    }
    assertExactFields(artifact, record, [
      "kind",
      "packageName",
      "subpath",
      "coverage",
      "surfaceKind",
      "audience",
      "stability",
    ])
    return
  }

  if (artifact.kind !== "operated") throw new Error(`invalid artifact kind: ${String(record.kind)}`)
  assertExactFields(artifact, record, [
    "kind",
    "packageName",
    "selector",
    "operatedKind",
    "manifestTarget",
    "coverage",
    "runtime",
    "audience",
    "stability",
    "guardIds",
  ])
  if (artifact.runtime !== "node-only") {
    throw new Error(`operated artifacts must use the node-only runtime`)
  }
  validateGuardIds(artifact)
  if (artifact.manifestTarget.length === 0) {
    throw new Error(`empty manifest target for ${artifactAddressFor(artifact)}`)
  }
  if (!/^(?:bin\.[^.]+|dawnInspector\.server)$/.test(artifact.selector)) {
    throw new Error(`invalid operated selector: ${artifact.selector}`)
  }
  if (
    (artifact.selector.startsWith("bin.") && artifact.operatedKind !== "executable") ||
    (artifact.selector === "dawnInspector.server" &&
      artifact.operatedKind !== "operated-application")
  ) {
    throw new Error(`invalid operated kind for ${artifact.selector}`)
  }
}

function validateGuardIds(artifact: RuntimeImportArtifact | OperatedArtifact): void {
  if (!Array.isArray(artifact.guardIds) || artifact.guardIds.length === 0) {
    throw new Error(`missing compatibility guard for ${artifactAddressFor(artifact)}`)
  }
  for (const guardId of artifact.guardIds) {
    if (!GUARD_IDS.has(guardId)) {
      throw new Error(
        `unknown compatibility guard ${String(guardId)} for ${artifactAddressFor(artifact)}`,
      )
    }
  }
  if (new Set(artifact.guardIds).size !== artifact.guardIds.length) {
    throw new Error(`duplicate compatibility guard for ${artifactAddressFor(artifact)}`)
  }

  const allowedGuardIds: readonly ApiReferenceGuardId[] =
    artifact.kind === "operated"
      ? ["node-operated-bundle", "browser-operated-negative-control"]
      : artifact.runtime === "edge-safe"
        ? ["edge-import-bundle"]
        : ["node-import-bundle", "browser-import-negative-control"]
  const applicableGuardIds =
    artifact.kind === "import" && artifact.purity === "dependency-free"
      ? ([...allowedGuardIds, "dependency-free-import-graph"] as const)
      : allowedGuardIds
  for (const guardId of artifact.guardIds) {
    if (!applicableGuardIds.includes(guardId)) {
      throw new Error(
        `inapplicable compatibility guard ${guardId} for ${artifactAddressFor(artifact)}`,
      )
    }
  }
  for (const guardId of applicableGuardIds) {
    if (artifact.guardIds.includes(guardId)) continue
    throw new Error(`missing compatibility guard ${guardId} for ${artifactAddressFor(artifact)}`)
  }
}

export function validateApiReferenceRegistries(registries: ApiReferenceRegistries): void {
  const packageNames = registries.packages.map(({ packageName }) => packageName)
  if (new Set(packageNames).size !== packageNames.length) {
    throw new Error("duplicate package catalog entry")
  }

  const addresses = new Set<string>()
  const generatedArtifacts = registries.artifacts.filter(
    (artifact): artifact is GeneratedTypesArtifact => artifact.kind === "generated",
  )
  if (generatedArtifacts.length !== 1) {
    throw new Error("dawn:routes must have exactly one generated artifact registry record")
  }
  const generatedArtifact = generatedArtifacts[0]
  if (!generatedArtifact) throw new Error("dawn:routes generated artifact is missing")
  for (const artifact of registries.artifacts) {
    validateArtifact(artifact)
    const address = artifactAddressFor(artifact)
    if (addresses.has(address)) throw new Error(`duplicate artifact address: ${address}`)
    addresses.add(address)
    if (artifact.kind !== "generated" && !packageNames.includes(artifact.packageName)) {
      throw new Error(`artifact owner missing from package catalog: ${artifact.packageName}`)
    }
  }

  const pageHrefs = registries.pages.map(({ href }) => href)
  if (new Set(pageHrefs).size !== pageHrefs.length)
    throw new Error("duplicate API reference page href")
  const pageLabels = registries.pages.map(({ label }) => label)
  if (new Set(pageLabels).size !== pageLabels.length)
    throw new Error("duplicate API reference page labels")
  for (const page of registries.pages) {
    if (page.parent.label !== "API Reference" || page.parent.href !== "/docs/api") {
      throw new Error(`invalid API reference parent for ${page.href}`)
    }
    for (const owner of page.ownerPackageNames) {
      if (!packageNames.includes(owner))
        throw new Error(`page owner missing from package catalog: ${owner}`)
    }
  }
  const generatedPageMatches = registries.pages.filter(
    ({ surfaceName, href }) =>
      surfaceName === generatedArtifact.moduleName && href === generatedArtifact.ownerHref,
  )
  if (generatedPageMatches.length !== 1) {
    throw new Error("dawn:routes generated artifact must map to its one canonical page")
  }

  const catalogAddresses = new Set<string>()
  for (const entry of registries.packages) {
    for (const address of entry.artifactAddresses) {
      if (catalogAddresses.has(address))
        throw new Error(`duplicate package artifact address: ${address}`)
      catalogAddresses.add(address)
      const artifact = registries.artifacts.find(
        (candidate) => artifactAddressFor(candidate) === address,
      )
      if (!artifact) throw new Error(`package catalog references unknown artifact: ${address}`)
      if (artifact.kind === "generated" || artifact.packageName !== entry.packageName) {
        throw new Error(`package catalog associates ${address} with the wrong package`)
      }
    }
  }
  for (const artifact of registries.artifacts) {
    const address = artifactAddressFor(artifact)
    if (artifact.kind !== "generated" && !catalogAddresses.has(address))
      throw new Error(`artifact missing from package catalog: ${address}`)
  }
}
