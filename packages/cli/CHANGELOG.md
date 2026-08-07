# @dawn-ai/cli

## 0.8.17

### Patch Changes

- 713797f: Purge `node:` imports from the edge module graph (deploy-anywhere B3, PR 2a).

  A bundle built from `@dawn-ai/cli/fetch` now links **zero** `node:` specifiers —
  previously it linked 33 of them (including `node:fs` and `node:child_process`)
  via Dawn's own supporting packages. Because static imports resolve when a module
  graph is instantiated, those edges made the bundle require a `node:` shim layer
  (Cloudflare Workers with `nodejs_compat`) even though the injected request path
  never called them. The artifact is now runtime-agnostic, verified by an esbuild
  purity test that bundles on the `neutral` and `browser` platforms with no `node:`
  externals and asserts an empty graph, plus a negative control proving the check
  still fails against the CLI entry.

  **Node-only exports moved to `/node` subpaths.** They are unchanged in behavior;
  only the import specifier differs:

  - `@dawn-ai/core` → `@dawn-ai/core/node`: `discoverRoutes`, `findDawnApp`,
    `assertDawnRoutesDir`, `extractToolSchemasForRoute`, `extractToolTypesForRoute`,
    `registerTsxLoader`
  - `@dawn-ai/permissions` → `@dawn-ai/permissions/node`: `createPermissionsStore`
  - `@dawn-ai/workspace` → `@dawn-ai/workspace/node`: `localFilesystem`, `localExec`

  **New:** `@dawn-ai/sdk/pure` (pure path/hash helpers, parity-tested against
  `node:path`/`node:crypto`); `@dawn-ai/core` gains `registerConfigLoader` and the
  `DawnConfigLoader` type; `@dawn-ai/core/node` gains `registerNodeConfigLoader`,
  `loadDawnConfigUncached`, and `nodeLoadRouteDescription`. `CapabilityMarkerContext`
  gains optional `backendFactories` and `loadRouteDescription` — capability markers
  no longer reach for node implementations by static import, and throw a named error
  when a runtime supplies neither an instance nor a factory.

  **Behavior change:** `createWorkspaceFs` now requires an absolute, POSIX-normalized
  `workspaceRoot` and throws a named error otherwise. Previously a relative root
  silently resolved against `process.cwd()`. Every in-repo caller already passes an
  absolute path; the host lane canonicalizes before calling core. This is
  fail-closed — it cannot widen the workspace path jail, only reject earlier and
  more loudly.

- 7f4bce6: Memory distillation: `dawn memory consolidate` and `dawn memory reflect`.

  Two explicitly-invoked passes that compact accumulated memories. Neither runs
  automatically — nothing is wired into the runtime, a request, or the lazy
  retention pass.

  **`dawn memory consolidate`** groups active episodic records older than
  `consolidate.olderThanMs` (default 7 days) per (namespace, ISO week), spends one
  model call per batch, and writes a summary record (kind `episodic`, tagged
  `consolidated`, `data = { period, sourceCount, derivedFrom }`, `effectiveAt` at
  the window's end, no expiry by default). The summary is written FIRST and its
  sources superseded only afterwards, so a crash leaves a redundant summary rather
  than orphaned sources with nothing summarizing them. Each superseded source is
  additionally stamped with `consolidate.sourceTtlMs` (default 7 days) so the
  normal prune reaps it later — a superseded row is invisible to `recall` but still
  occupies a slot in the per-namespace episodic cap. Summaries are never
  re-consolidated (`data.derivedFrom` excludes them from every pass).

  **`dawn memory reflect`** derives durable insights per namespace from records
  newer than that namespace's watermark (the highest `data.coveredUntil` on its
  existing reflections), between `reflect.minNewRecords` (10) and
  `reflect.maxRecords` (100). Insights are written as **candidates by default**
  (`reflect.writes: "candidate" | "auto"`) — a model's generalization about your
  users gets a human read before `recall` can surface it. Approve them with
  `dawn memory approve` or the Inspector, exactly like any other candidate write.

  **Cron-safe.** Both commands share the flags
  `[--dry-run] [--namespace <prefix>] [--model <id>] [--provider <id>] [--max-batches <n>]`
  and are threshold-aware no-ops: below the thresholds they print one line, exit
  `0`, and never construct a model — so they never read an API key. `--dry-run`
  reports the full plan while making zero model calls, and `--max-batches`
  (default 5) bounds the spend of any single invocation. That makes
  `0 3 * * * cd /srv/app && npx dawn memory consolidate && npx dawn memory reflect`
  free on an idle app and safe on an app with no credentials configured.

  Configured under `memory.distill` in `dawn.config.ts` (`model` defaults to
  `gpt-5-mini`; `provider` is inferred from the model id, falling back to
  `openai`).

  **Distilled records are written to be findable.** Recall is keyword match, and a
  model asked to generalize writes an abstraction that names none of its sources
  ("earlier-week deployment windows are lower risk" for a batch about _griffin_) —
  which no realistic question retrieves, and for consolidation the sources that did
  carry the name are already superseded. Both distillation prompts now require the
  concrete entities (service and project names, ticket/error identifiers,
  filenames, people) to be carried through verbatim. Measured live, this is the
  difference between an insight that ranks first for "griffin deploys" and one that
  does not appear at all.

  **`recall` no longer invites guessed time windows.** The `since`/`until` schema
  descriptions now steer the model to relative offsets (`"-7d"`, resolved against
  the request clock) and state that it does not know today's date. A model asked
  "what did I work on last week?" would otherwise supply an absolute window from
  around its training cutoff — observed live: a 2026 store queried with
  `since: "2023-10-02"` — which matches nothing, silently, because an empty result
  is indistinguishable from an empty store.

  **Placeholder model output can never destroy history.** Both prompts end with
  their own schema example (`{"summary": "..."}`); a model that echoes it back
  returns a payload that is structurally valid and semantically empty. Written, that
  summary would then supersede the real episodes it claims to summarize — whose
  content is the only other copy. A summary or insight carrying no letter and no
  digit anywhere is now a parse failure, so the batch fails loudly and its sources
  stay active.

  **A zero-insight reflection pass still advances the watermark.** It persists one
  `superseded` sentinel (content `(no insights from this pass)`) carrying
  `coveredUntil`, invisible to `recall`. Without it, a namespace whose memories
  legitimately yield no durable insight was re-examined — and re-paid for — on
  every cron run, forever.

  **One failed source link can no longer split a batch.** A batch is the atom of
  idempotency (its summary id hashes its own source-id list), so each source's
  supersede/expiry pair is now isolated: a transient failure on one source leaves
  that source active and unstamped while the rest of the batch links normally,
  instead of leaving the survivors to form a different chunk — and a second
  overlapping summary — on the next run. The batch still reports as failed.
  `--max-batches 0` now reports the deferred work rather than claiming there is
  nothing to do.

  **`kind: "reflection"` is now accepted** by `defineMemory` and the generated
  `remember` tool, where it previously threw. Reflections are append-only, like
  episodic writes — a later insight never supersedes an earlier one. This is
  **additive, not breaking**: no existing app changes behavior and no action is
  required. `procedural` remains typed-but-unwired and still throws.

- 1a9ae7b: Support TypeScript 7 workspaces and generated apps, and move Dawn's Next.js applications
  to Next 16.3's experimental CLI type checker with `experimental.useTypeScriptCli`.

  Consolidate tool analysis in Core behind one compiler boundary and program, with shared
  projections for declarations, JSON Schema, and Vite Zod metadata. Core internally pins
  the exact TypeScript 6 compatibility wrapper and implementation until the native compiler
  API can be revisited for TypeScript 7.1. Generated JSON schemas now preserve mapped-type
  optionality and use a compiler-neutral fallback for collection intersections.

  Generate collision-safe Vite metadata bindings and remove the unsupported `extractJsDoc`
  and `extractParameterType` exports. Their removal is an intentional breaking change.

  Add permanent packed-consumer and exact-version post-publish verification for the
  TypeScript tooling packages.

- Updated dependencies [713797f]
- Updated dependencies [7f4bce6]
- Updated dependencies [1a9ae7b]
  - @dawn-ai/core@0.8.17
  - @dawn-ai/sdk@0.8.17
  - @dawn-ai/permissions@0.8.17
  - @dawn-ai/langchain@0.8.17
  - @dawn-ai/memory@0.8.17
  - @dawn-ai/langgraph@0.8.17
  - @dawn-ai/ag-ui@0.8.17
  - @dawn-ai/sqlite-storage@0.8.17

## 0.8.16

### Patch Changes

- 451c000: Add `POST /threads/:thread_id/cancel` to stop an in-flight Agent Protocol run, and enforce one run per thread.

  Runs previously had no way to be stopped short of killing the process — the only `AbortSignal` reaching a route was the server shutdown signal. Cancellation now works across `/runs/stream`, `/runs/wait`, and `/resume`, and keeps checkpointed state (LangGraph's `action=interrupt` semantics; there is no rollback). The endpoint returns `200 {thread_id, status:"interrupted"}`, `404` for an unknown thread, or `409` when no run is in flight. A cancelled SSE run ends with `done` carrying `{"cancelled":true}`, distinguishing it from a failure; a cancelled `runs/wait` returns `409` with code `run_cancelled`, since it has not committed to a response body yet.

  **Behaviour change:** a second concurrent run on a thread that is already running now returns `409` with code `run_in_flight` instead of being admitted. Concurrent runs previously drove the same LangGraph checkpoint thread and interleaved their writes last-writer-wins, silently corrupting thread state, so this converts data loss into a clear error. The gate is keyed on in-memory state rather than the persisted thread status, so a process that crashes mid-run does not leave the thread permanently unusable.

  Client-disconnect behaviour is unchanged and now documented rather than incidental: Agent Protocol runs continue (matching LangGraph Platform's `on_disconnect: "continue"` default for a durable, resumable surface), while AG-UI keeps aborting because it is ephemeral with nothing to reattach to.

  Also fixes an unbounded memory leak in the AG-UI handler, which composed `AbortSignal.any([shutdownSignal, requestController.signal])` once per request. A composed signal is retained for the lifetime of its source, and the shutdown signal lives as long as the process, so memory grew with total historical request count and was never freed — roughly 92 MB per 200k requests on Node 24. Both the AG-UI handler and the new run registry use a manual listener with explicit removal instead.

  Run tracking is process-local, so the concurrency gate and `/cancel` assume a single replica — a constraint that already applied to Dawn's pod-local threads database and checkpoints, and is now documented in the `dawn-app` chart README.

- d845720: Runtime edge-readiness (deploy-anywhere B3, PR 1 of 3).

  New `@dawn-ai/cli/fetch` entry exposes the web-standard runtime with a module
  graph that contains none of Dawn's own filesystem, SQLite, or CLI code —
  enforced by an esbuild-metafile test that also pins the remaining upstream
  `node:` edges so the set can only shrink.

  `serveRuntime`/`startRuntimeServer`/`createRuntimeFetchHandler` now accept an
  injected checkpointer, threads store, permissions store, memory store,
  middleware, and a `DawnConfig` object (`seedDawnConfig`). With everything
  supplied, nothing reads `dawn.config.ts` or opens SQLite — including subagent
  turns, which previously rebuilt their own stores. On the injected path a
  missing store fails loudly at boot instead of silently falling back.

  Capability markers read through a new sync `MarkerFs` facade (node
  implementation behind `@dawn-ai/core/node`), the subagents descriptor map is
  derived from the static module manifest with no dynamic imports, the manifest
  now carries `src/middleware.ts`, and `@dawn-ai/memory` gained pure
  `./namespace` and `./reconcile` subpaths. Behavior with nothing injected is
  unchanged.

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [d845720]
- Updated dependencies [2da55fa]
  - @dawn-ai/core@0.8.16
  - @dawn-ai/memory@0.8.16
  - @dawn-ai/langchain@0.8.16
  - @dawn-ai/ag-ui@0.8.16
  - @dawn-ai/langgraph@0.8.16
  - @dawn-ai/permissions@0.8.16
  - @dawn-ai/sdk@0.8.16
  - @dawn-ai/sqlite-storage@0.8.16

## 0.8.15

### Patch Changes

- 029a2cf: Episodic memory: Dawn apps can now remember what happened. An opt-in runtime
  recorder (`memory.episodes.enabled`) writes one episode per agent run from the
  trace — input, outcome, tools used, duration — with TTL + per-namespace cap
  retention; routes can also author episodes via `defineMemory({ kind: "episodic" })`
  (append-only, never superseded). `recall` gains `since`/`until` time windows
  (ISO or relative like "-24h"); the Inspector gains a timeline view; `dawn memory
prune` runs retention manually.

  BREAKING: `MemoryStore` now requires `prune(opts)`; `search`/`browse` accept
  `since`/`until` and exclude expired rows when `now` is supplied. Custom stores
  must implement `prune` (`runMemoryStoreConformance` enforces the contract).

- 48dbddf: `dawn build`'s node target now emits `.dawn/build/modules.mjs` — a generated
  static module manifest that imports every route, tool, state definition, and
  route memory module and inlines their schemas. The built `server.mjs` boots
  from it, so production startup performs no route-tree scanning or per-file
  discovery. The runtime accepts the manifest via a new optional
  `modules` field on `serveRuntime`/`startRuntimeServer` (absent = dynamic
  discovery, unchanged), and `dawn check` fails on a manifest that has drifted
  from the routes on disk. Static and dynamic serving are verified
  response-equivalent end to end. This is the mechanism the upcoming edge build
  targets consume.
- Updated dependencies [029a2cf]
  - @dawn-ai/memory@0.8.15
  - @dawn-ai/core@0.8.15
  - @dawn-ai/langchain@0.8.15
  - @dawn-ai/ag-ui@0.8.15
  - @dawn-ai/langgraph@0.8.15
  - @dawn-ai/permissions@0.8.15
  - @dawn-ai/sqlite-storage@0.8.15

## 0.8.14

### Patch Changes

- 937be0f: New `@dawn-ai/inspector`: a browser-based runtime inspector (`dawn inspect`) with a
  Memory panel — browse, search (recall-equivalent hybrid), inspect, and govern
  memories with supersede-aware approval. Ships as a scaffold devDependency.

  BREAKING: `MemoryStore` now requires `browse(q?)` and `stats(opts?)`; custom stores
  must implement them (the built-in sqlite/pgvector stores already do, and
  `runMemoryStoreConformance` enforces the contract). The config-facing store type is
  now the full `MemoryStore` contract. `dawn memory approve` now supersedes a
  contradicting active row instead of leaving two actives.

- 83e5153: Load the app once per process. `dawn.config.ts` is memoized per app root; the
  runtime passes its boot-resolved checkpointer, threads store, and permissions
  store into route execution instead of reconstructing them per request (three
  SQLite opens per turn eliminated); the memory store opens lazily on first use
  and is shared between the memory HTTP routes and the memory capability; route
  modules, tools, state, and route memory load once per route and are cached for
  the process lifetime, and the per-request route rediscovery is gone. In
  `dawn dev`, tool/state/reducer edits now restart the child runtime — fixing a
  stale-module bug where such edits silently did not apply (the previous
  re-import mechanism was a no-op under tsx) — and the restart log names the
  reason. Groundwork for build-time static wiring and the edge deploy targets.
- Updated dependencies [937be0f]
- Updated dependencies [83e5153]
  - @dawn-ai/memory@0.8.14
  - @dawn-ai/core@0.8.14
  - @dawn-ai/langchain@0.8.14
  - @dawn-ai/ag-ui@0.8.14
  - @dawn-ai/langgraph@0.8.14
  - @dawn-ai/permissions@0.8.14
  - @dawn-ai/sqlite-storage@0.8.14

## 0.8.13

### Patch Changes

- 20f0407: Consolidate the existing `@dawn-ai/ag-ui` package as Dawn's pure canonical AG-UI
  adapter. Its root API now maps standard `RunAgentInput` requests and Dawn stream
  chunks, including standard interrupt outcomes and addressed resume decisions,
  while the focused `@dawn-ai/ag-ui/sse` subpath provides event-stream encoding
  without taking ownership of a server or runtime transport.

  The CLI AG-UI endpoint now uses the canonical adapter, applies the same request
  projection as other runtime middleware, and emits canonical events without the
  former custom state event shapes. Pending checkpoint interrupts are resolved
  through the standard resume contract.

  The langchain adapter surfaces each tool invocation's `run_id` on its
  `tool_call` and `tool_result` chunks, and the CLI preserves those IDs through
  Dawn and AG-UI streams for reliable `toolCallId` correlation. Local in-process
  `dawn run` also assigns agent routes a one-shot thread ID so the default SQLite
  checkpointer can execute the same route shape supported by `dawn dev`.

- 2b6be86: Run app middleware for the `POST /agui/{routeId}` endpoint, matching
  `runs/stream` / `runs/wait` / `resume`. A middleware that rejects now blocks an
  AG-UI run (returning its status/body), and a middleware that returns `context`
  has it threaded into the run — so auth, rate-limiting, and context injection
  apply to AG-UI clients too, not just the Agent-Protocol endpoints.
- 628d1c3: Wire `DAWN_E` error codes into `dawn verify`'s runtime preflight. Add
  `DAWN_E5101` ("Node version below the supported floor") to the error-code
  registry, and surface it (or `DAWN_E2002` for an unreachable sandbox daemon)
  on a failed `dawn verify` runtime check — in both the CLI's `[CODE] See <docs>`
  line and the `--json` output's `runtime.node.code` / `runtime.docker.code`
  fields.
- 18df470: Add a central `DAWN_Exxxx` error-code registry in `@dawn-ai/sdk` and surface
  codes on the failure channels. `CliError` now carries an optional `code` and the
  CLI prints `[CODE] See <docs>`; HTTP/SSE error bodies gain optional `code`/`docsUrl`;
  permission denials returned as tool results are prefixed with `[DAWN_E3001]`.
  The high-value families are wired (`dawn check` config errors, sandbox
  unavailable, permission denied, missing model provider / unknown model id, and
  tool-file shape errors), and a generated `/docs/errors` reference page is guarded
  against drift. Additive and backward-compatible.
- ee83a96: Add dev-server HTTP endpoints for memory candidates so a web client can review
  durable-memory proposals without the CLI: `GET /memory/candidates`,
  `POST /memory/candidates/:id/approve` (candidate → active, 404/409 guarded), and
  `POST /memory/candidates/:id/reject`. Backed by the same store methods as
  `dawn memory list/approve/reject`.
- 361a9ac: `dawn verify` now runs an environment preflight. A new `runtime` check asserts the running Node version meets Dawn's `22.13.0` floor (a stale Node fails verify) and, when `dawn.config.ts` configures a sandbox provider, runs the provider's Docker daemon preflight. The `deps` env-var check is now provider-aware: it derives the required API-key env var from the providers your routes actually use (e.g. `ANTHROPIC_API_KEY` for an Anthropic-only app) instead of always nagging about `OPENAI_API_KEY`.
- df54695: Internal refactor: the runtime server now runs on a transport-agnostic
  `(Request) => Promise<Response>` core (`createRuntimeFetchHandler`, exported from
  `@dawn-ai/cli/runtime`), with the Node listener reimplemented as a thin adapter
  over it. No behavior change — routes, status codes, headers, JSON error bodies,
  SSE framing, streaming incrementality, and shutdown/drain semantics are
  preserved (verified against the full suite unchanged plus new wire-parity
  tests). The `@dawn-ai/testing` Agent-Protocol harness now drives the fetch core
  directly (dropping `light-my-request`). This is the first step of the
  deploy-anywhere epic: edge build targets (Cloudflare Workers / Vercel / Hono)
  build on this core.
- Updated dependencies [20f0407]
- Updated dependencies [5bbd6e3]
- Updated dependencies [18df470]
  - @dawn-ai/ag-ui@0.8.13
  - @dawn-ai/langchain@0.8.13
  - @dawn-ai/core@0.8.13
  - @dawn-ai/langgraph@0.8.13
  - @dawn-ai/memory@0.8.13
  - @dawn-ai/permissions@0.8.13
  - @dawn-ai/sqlite-storage@0.8.13

## 0.8.12

### Patch Changes

- e413b05: Add a production serve path. `dawn build` now emits a Node/Docker target (a
  `server.mjs` over the Dawn runtime plus a hardened Dockerfile) alongside the existing
  LangSmith `langgraph.json`, selectable via `build.targets`. The new `dawn start`
  command serves the runtime on 0.0.0.0 (HOST/PORT configurable). This is the first
  server that runs the Dawn runtime in production, so a deployed app engages the
  execution sandbox and serves both Agent Protocol and AG-UI. The langgraphjs/LangSmith
  path does not run the runtime and does not engage the sandbox.
- Updated dependencies [e413b05]
  - @dawn-ai/core@0.8.12
  - @dawn-ai/langchain@0.8.12
  - @dawn-ai/ag-ui@0.8.12
  - @dawn-ai/langgraph@0.8.12
  - @dawn-ai/memory@0.8.12
  - @dawn-ai/permissions@0.8.12
  - @dawn-ai/sqlite-storage@0.8.12

## 0.8.11

### Patch Changes

- f0261f1: Add `@dawn-ai/ag-ui`: translate Dawn's runtime stream to the AG-UI protocol and
  serve it at `POST /agui/{routeId}`, so CopilotKit and other AG-UI clients can
  drive Dawn agents. Additive — the existing Agent-Protocol endpoints are unchanged.
- Updated dependencies [f0261f1]
  - @dawn-ai/ag-ui@0.8.11
  - @dawn-ai/core@0.8.11
  - @dawn-ai/langchain@0.8.11
  - @dawn-ai/langgraph@0.8.11
  - @dawn-ai/memory@0.8.11
  - @dawn-ai/permissions@0.8.11
  - @dawn-ai/sqlite-storage@0.8.11

## 0.8.10

### Patch Changes

- e3c253b: Type generated `remember.data` from each route's `defineMemory()` Zod schema
  instead of `Record<string, unknown>`, so route code gets compile-time memory fact
  shape checks that match runtime validation. `pgvectorMemoryStore()` now validates
  the dimension ceiling during construction, failing invalid configs before opening
  a pool or initializing schema.
  - @dawn-ai/core@0.8.10
  - @dawn-ai/langchain@0.8.10
  - @dawn-ai/langgraph@0.8.10
  - @dawn-ai/memory@0.8.10
  - @dawn-ai/permissions@0.8.10
  - @dawn-ai/sqlite-storage@0.8.10

## 0.8.9

### Patch Changes

- d3d94af: Argument-level tool constraints: `agent({ tools: { constrain: { deployProd: (args, ctx) => … } } })` runs a per-tool predicate against the model's arguments at call time, returning allow / deny-with-reason / `{ approve: true }` (escalate to the HITL prompt). Predicates may be async and receive a read-only policy context; a throwing or off-contract predicate fails closed. The tool run context now also carries the live `threadId` + route params. `dawn check` validates `constrain` tool names and warns on `approve`/`constrain` overlap.
- 628f0c1: Add a `kubernetesSandbox` provider: run each thread's sandbox as a Kubernetes Pod
  with a per-thread PersistentVolumeClaim for the durable workspace, implementing the
  same `SandboxProvider` contract as `dockerSandbox`. Tier-1 hardening maps onto Pod
  SecurityContext (non-root via `fsGroup`, read-only rootfs, dropped capabilities,
  no-new-privileges, RuntimeDefault seccomp); sandbox pods mount no ServiceAccount
  token. Per-thread NetworkPolicy provides best-effort egress control (requires a
  policy-capable CNI; `dawn check` warns when unconfirmed). New `resources.diskGb`
  sets the PVC size.
- 1dd2147: Opt-in vector/semantic recall for long-term memory. Enable with
  `memory: { vector: { embedder: openaiEmbedder() } }`: recall becomes hybrid —
  keyword (IDF) and vector (cosine) candidate lists fused co-equally by Reciprocal
  Rank Fusion, with a bounded recency/confidence second stage. Keyword recall is
  never dropped (dense retrieval is weak on exact IDs/codes/names), and default
  keyword-only recall is unchanged. Pluggable `Embedder` (`openaiEmbedder`,
  `fakeEmbedder`); embeddings stored as Float32 BLOBs in the existing node:sqlite
  store (zero new native deps), tagged by embedder id with graceful keyword-only
  fallback on model change. pgvector is a planned follow-up backend.
- Updated dependencies [d3d94af]
- Updated dependencies [ca9bc13]
- Updated dependencies [1dd2147]
  - @dawn-ai/core@0.8.9
  - @dawn-ai/langchain@0.8.9
  - @dawn-ai/memory@0.8.9
  - @dawn-ai/langgraph@0.8.9
  - @dawn-ai/permissions@0.8.9
  - @dawn-ai/sqlite-storage@0.8.9

## 0.8.8

### Patch Changes

- 6fb2b10: Improve the default scaffold and packaged external verification.

  The research scaffold now dogfoods reviewable memory and the Docker sandbox,
  shared scaffold tools can run through sandbox-aware workspace APIs, generated
  apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
  tests install the current packed devkit templates instead of stale registry
  contents.

- dd02f56: New memory write-governance mode `writes: "ask"`: memory supersedes (belief contradictions) prompt a HITL Once/Always/Deny interrupt with old-vs-new detail; ADDs and idempotent updates flow silently; headless behaves as `auto`. New `kind: "memory"` permission interrupt, `gateMemorySupersede`, `suggestedMemoryPattern`, and a `dawn check` warning for the `ask` + `approve: ["remember"]` double-gate overlap.
- 57e8cd9: Harden the Docker sandbox by default: drop all Linux capabilities, no-new-privileges,
  a PID limit (512), a read-only root filesystem (workspace + /tmp stay writable), and
  run-as-non-root (uid/gid 1000:1000 via a create-time root chown-init) — expressed as a
  provider-agnostic `SandboxPolicy.security` intent. `resources.timeoutMs` is now enforced
  per command (in-container `timeout`, exit 124). All hardening is on by default with
  per-flag opt-outs (`readOnlyRootFilesystem`, `runAsNonRoot`, etc.). Behavior changes only
  for apps already using `sandbox`; runtime system-directory writes / global installs now
  fail under the defaults — bake system deps into your image or opt out.
- Updated dependencies [dd02f56]
- Updated dependencies [26780ab]
- Updated dependencies [5ccae68]
  - @dawn-ai/core@0.8.8
  - @dawn-ai/permissions@0.8.8
  - @dawn-ai/memory@0.8.8
  - @dawn-ai/langchain@0.8.8
  - @dawn-ai/langgraph@0.8.8
  - @dawn-ai/sqlite-storage@0.8.8

## 0.8.7

### Patch Changes

- 6a683c8: Smarter recall: long-term-memory `recall` now ranks results by IDF-weighted
  relevance blended with recency decay and stored confidence, instead of pure
  recency — a six-week-old fact that actually answers the query outranks
  yesterday's marginal match. Deterministic (no clock, no network, no new deps;
  same store + same query → same order), zero-config (tune via
  `DawnConfig.memory.recall` only if needed), and query-less searches (the
  injected index, `dawn memory list`) keep their recency order.
- Updated dependencies [6a683c8]
  - @dawn-ai/memory@0.8.7
  - @dawn-ai/core@0.8.7
  - @dawn-ai/langchain@0.8.7
  - @dawn-ai/langgraph@0.8.7
  - @dawn-ai/permissions@0.8.7
  - @dawn-ai/sqlite-storage@0.8.7

## 0.8.6

### Patch Changes

- 9d115de: `dawn dev` startup readiness timeout is now configurable via `DAWN_DEV_READY_TIMEOUT_MS` (default unchanged at 5s). Also de-flakes the dev-command disposal test that raced child startup against the readiness window in CI.
- 4ede7b8: Add an opt-in execution sandbox: a provider-agnostic `SandboxProvider` contract
  with a Docker reference (`dockerSandbox`), giving each conversation thread a
  hard-isolated workspace (filesystem + shell + network). Enable via
  `dawn.config.ts` `sandbox: { provider: dockerSandbox({ image }) }`; without it,
  behavior is unchanged. Adds a typed `config()` helper. When sandboxed, the
  materialized agent cache is bypassed so tools bind per-thread. Honest scope:
  Docker's boundary (not a microVM); `allow`-mode network denylist is best-effort
  in the Docker reference. New package `@dawn-ai/sandbox` (+ `@dawn-ai/sandbox/testing`
  `fakeSandbox` and a provider conformance kit).
- 1d51b75: Per-tool approval gating: `agent({ tools: { approve: ["deployProd"] } })` makes any named tool require a HITL permission prompt per call (`kind: "tool"` interrupt). Decisions persist name-level under the reserved `tool` key in `.dawn/permissions.json` (exact-name matching); pre-approve via `permissions.allow.tool`. `dawn check` validates `approve` names and warns on overlap with the internally-gated workspace tools, `deny`, and the unsupported `task` case.
- Updated dependencies [4ede7b8]
- Updated dependencies [1d51b75]
  - @dawn-ai/core@0.8.6
  - @dawn-ai/langchain@0.8.6
  - @dawn-ai/permissions@0.8.6
  - @dawn-ai/langgraph@0.8.6
  - @dawn-ai/memory@0.8.6
  - @dawn-ai/sqlite-storage@0.8.6

## 0.8.5

### Patch Changes

- 91d999c: Add `dawn add <name>` — fetch an integration blueprint (a Markdown guide served from dawnai.org) and print it for your coding agent to apply. `dawn add` lists the catalog; `dawn add <url>` applies a third-party blueprint. Ships with pgvector, pinecone, opentelemetry, and docker blueprints.
- Updated dependencies [f195096]
  - @dawn-ai/core@0.8.5
  - @dawn-ai/langchain@0.8.5
  - @dawn-ai/langgraph@0.8.5
  - @dawn-ai/memory@0.8.5
  - @dawn-ai/permissions@0.8.5
  - @dawn-ai/sqlite-storage@0.8.5

## 0.8.4

### Patch Changes

- f8c3a21: Bundle the Dawn documentation inside `@dawn-ai/cli` as a version-matched markdown tree, add a `dawn docs` command to read it locally, ship a `SKILL.md`, and scaffold a root `AGENTS.md` pointer into new apps. Coding agents can now read Dawn's docs offline, matched to the installed version.
- 4e3e020: Fix long-term memory being unusable by real agents: the generated `remember`/`recall`
  tools now expose input schemas to the model. `remember.data` is the route's own
  `defineMemory()` zod schema (threaded through `MemoryContext.schema`), so the model
  knows exactly what to pass; previously both tools shipped without a schema, so a real
  model called them with empty/invalid args and every write was rejected by validation.
  Found by a live smoke test against a real model — the deterministic aimock suite
  couldn't catch it because it scripts exact tool arguments.
- Updated dependencies [4e3e020]
  - @dawn-ai/core@0.8.4
  - @dawn-ai/langchain@0.8.4
  - @dawn-ai/langgraph@0.8.4
  - @dawn-ai/memory@0.8.4
  - @dawn-ai/permissions@0.8.4
  - @dawn-ai/sqlite-storage@0.8.4

## 0.8.3

### Patch Changes

- 2744a5c: Add long-term memory. Routes gain a typed, cross-session memory collection via
  `defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
  `remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
  (node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
  profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
  Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
  kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
  The research scaffold template now ships a `memory.ts`/`memory.md` example.
- 7339ded: Tool scoping: `agent({ tools: { allow, deny } })` restricts which tools a route's agent may call. `deny` revokes a tool; `allow` grants a withheld capability tool; deny wins.

  **Behavior change (pre-1.0):** subagents are now least-privilege by default — a subagent gets only its own route-local `tools/*.ts`; ambient capability tools (`writeFile`, `runBash`, `task`, `writeTodos`, `remember`/`recall`, …) are withheld unless named in `tools.allow`. A subagent that relied on inheriting these must add `tools: { allow: [...] }`. `dawn check` validates scope names. This scopes the tool surface, not execution (not a sandbox).

- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/memory@0.8.3
  - @dawn-ai/core@0.8.3
  - @dawn-ai/langchain@0.8.3
  - @dawn-ai/langgraph@0.8.3
  - @dawn-ai/permissions@0.8.3
  - @dawn-ai/sqlite-storage@0.8.3

## 0.8.2

### Patch Changes

- 5372180: Add `dawn eval --record`. Records replayable aimock fixtures from a real-model
  eval run into per-case sibling `<evalBasename>.<caseSlug>.fixtures.json` files,
  auto-loaded on a plain (replay) `dawn eval`. Inline `script()` fixtures stay
  authoritative (record skips those cases); the gate still applies during record
  but captured fixtures are flushed per-case before the verdict. New
  `@dawn-ai/testing` harness capability: `createAgentHarness({ record: true })` +
  `harness.getRecordedFixtures()`.
  - @dawn-ai/core@0.8.2
  - @dawn-ai/langchain@0.8.2
  - @dawn-ai/langgraph@0.8.2
  - @dawn-ai/permissions@0.8.2
  - @dawn-ai/sqlite-storage@0.8.2

## 0.8.1

### Patch Changes

- 407303f: Friendlier import errors. When a route, tool, or config module fails to load with the opaque ESM error "does not provide an export named X", Dawn now identifies the offending package and explains the likely cause and fix — an older hoisted `@langchain/core` (with the installed-vs-required versions and an `npm ls` pointer) or a CommonJS dependency imported with named bindings under Dawn's ESM resolver. `CliError` now preserves the original error via `cause`. Also aligns `@dawn-ai/sqlite-storage`'s `@langchain/core` peer floor to `^1.1.47` to match the rest of the suite.
- Updated dependencies [407303f]
- Updated dependencies [89b2a73]
  - @dawn-ai/sqlite-storage@0.8.1
  - @dawn-ai/core@0.8.1
  - @dawn-ai/langchain@0.8.1
  - @dawn-ai/langgraph@0.8.1
  - @dawn-ai/permissions@0.8.1

## 0.8.0

### Minor Changes

- Unknown model ids now get advisory warnings instead of late provider 404s. `dawn check`/`verify` warn (exit code unchanged) when an agent route's `model` isn't in the curated list for its resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same `[dawn:models]` advisory once per model at chat-model construction. Curated lists are values now (`CURATED_MODEL_IDS` etc.) with types derived, Anthropic and xAI ids included; `validateModelId` and `inferProvider` are exported from `@dawn-ai/sdk`. Note: the narrow `GoogleModelId` union dropped the vendor-retired `gemini-3-pro-preview` (replaced by `gemini-3.1-pro-preview`).

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Minor Changes

- 9fd967f: Friendlier tool-discovery errors. Default-exporting a LangChain `tool()` (StructuredTool) from a route tool file now produces a targeted error naming the export and showing the 3-line plain-function wrapper conversion; the generic "must default export a function" error now describes what was actually exported and links the tools documentation.
- a38ff61: Sandboxed `ctx.fs` for route tools and workflow/graph entries. Tools and route entries now receive a `WorkspaceFs` handle (`readFile`, `readBinaryFile`, `writeFile`, `listDir`) that resolves paths against the route's `workspace/` directory and runs the same permission gate as the agent-facing workspace tools — no more dropping to `node:fs`. The permission gate is extracted to a shared core module; in execution contexts where interactive prompts can't appear (workflow/graph entries), outside-workspace access fails closed with guidance to add an allow rule.

### Patch Changes

- Updated dependencies [a38ff61]
  - @dawn-ai/core@0.7.0
  - @dawn-ai/langchain@0.7.0
  - @dawn-ai/langgraph@0.7.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.6.0

### Patch Changes

- @dawn-ai/core@0.6.0
- @dawn-ai/langchain@0.6.0
- @dawn-ai/langgraph@0.6.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0

## 0.5.0

### Minor Changes

- b4a2295: Add eval authoring: a new `@dawn-ai/evals` package (`defineEval`, built-in + `custom` + `llmJudge` scorers, composable `gate.*` policies, `dataset` as array/path/function) and a `dawn eval` command that runs an agent route over a dataset and reports/gates on scores. Default execution is deterministic replay (per-case aimock fixtures, CI-safe); `dawn eval --live` runs the real model locally (gated on `OPENAI_API_KEY`, never in CI). Evals are discovered from `src/app/<route>/evals/*.eval.ts`, mirroring the `run.test.ts` convention.

### Patch Changes

- Updated dependencies [b6e71a7]
  - @dawn-ai/langchain@0.5.0
  - @dawn-ai/core@0.5.0
  - @dawn-ai/langgraph@0.5.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.4.0

### Patch Changes

- @dawn-ai/core@0.4.0
- @dawn-ai/langchain@0.4.0
- @dawn-ai/langgraph@0.4.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0

## 0.3.0

### Minor Changes

- b51de58: Add `@dawn-ai/testing` — a productized, aimock-backed package for writing deterministic, CI-safe tests of Dawn agents.

  The model is mocked at the HTTP wire via `@copilotkit/aimock`, so tests exercise the real agent loop, tool calls, streaming, state, offloading, and summarization without a live API key. Three layers, one package:

  - **In-process (default):** `createAgentHarness({ appRoot, route })` runs your route through Dawn's runtime; the fastest layer and the one most users reach for.
  - **http-inject:** `injectAgentProtocol({ appRoot })` drives the full Agent-Protocol request→response pipeline in-process via `light-my-request` (no port bound) — for framework/SSE coverage.
  - **subprocess:** `startSubprocessApp({ appRoot })` boots a real `dawn dev` — for restart/persistence scenarios.

  A fluent `script()` builder compiles multi-turn tool-call conversations to aimock fixtures (auto `turnIndex`/`hasToolResult`, fixed `tool_call_id`s), and `expect*` matchers assert agent behavior: `expectToolCalled().withArgs()`, `expectFinalMessage()`, `expectStreamedTokens()`, `expectState().field()`, `expectOffloaded()`. A local-only `record()` helper captures real interactions into fixtures (CI replays strict/read-only).

  `@dawn-ai/cli` gains a `@dawn-ai/cli/runtime` programmatic export subpath (`streamResolvedRoute`, `createRuntimeRegistry`, `runTypegen`, `createRuntimeRequestListener`, …) and `buildOffload` now resolves the workspace relative to the app root (no behavior change under `dawn dev`, where cwd is the app root).

  `@dawn-ai/langchain` fixes a bug where the streamed `tool_call` event carried `undefined` tool arguments — `on_tool_start` now reads `event.data.input` (the field LangChain populates with tool args), so stream consumers (e.g. UI tool-call displays) receive the real arguments.

  Dawn's own aimock e2e lane (SP5 union schema, SP6a tool-output offloading, conversation summarization) was migrated onto this package in-process, removing the per-test `pnpm pack` + install + dev-server boot.

- 8133553: Add opt-in conversation summarization (Phase 3 sub-project 6b). When a thread's history exceeds a token threshold, the agent is fed a condensed view — a running summary of older turns plus the most recent turns verbatim — while the **full history stays intact in the checkpoint**. This is non-destructive: summarization runs as a LangGraph `preModelHook` that returns `llmInputMessages` for the turn only and never rewrites saved `messages`, so `GET /threads/:id/state`, resume, and restart always see the complete history (and there is no tool-call/result pairing hazard).

  Enable it in `dawn.config.ts`:

  ```ts
  export default {
    summarization: {
      enabled: true, // default false
      maxTokens: 12_000, // threshold over which older turns are summarized
      keepRecentTurns: 6, // most-recent turns kept verbatim
      // model defaults to the route's model
      // tokenCounter defaults to a lazy gpt-tokenizer (o200k_base) counter
      // summarize defaults to a built-in single-LLM-call running-summary fold
    },
  };
  ```

  Both the token counter and the summarizer are pluggable (`tokenCounter`, `summarize`). The running summary is cached in agent state and refreshed incrementally — each turn folds only the newly-aged messages, so cost stays bounded. The turn-boundary split is pairing-safe (a tool-call message is never separated from its results). When summarization is disabled (the default), behavior is unchanged and `gpt-tokenizer` is never loaded. If the summarizer call fails on a given turn, the agent falls back to the full history for that turn rather than failing the run.

- 027b1cc: Add tool-output offloading. When a tool returns output larger than `toolOutput.offloadThresholdChars` (default 40,000), the full payload is written to `workspace/tool-outputs/` and the in-context ToolMessage is replaced with a preview+pointer stub; the agent retrieves the full content with the existing `readFile` tool (which bypasses the size cap for `tool-outputs/` paths). Active automatically when a workspace exists. The directory is bounded by a size + TTL cap (defaults 256MB / 3h) with throttled evict-on-write and LRU-by-access eviction (readFile bumps mtime for tool-outputs/ files). Large content never enters message state, so there is no tool-call/result pairing hazard. Configurable via `dawn.config.ts` `toolOutput`. The `FilesystemBackend` interface gains optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods and an optional per-call `maxBytes` override on `readFile`.

### Patch Changes

- 55b69f0: Fix tool-output offloading so retrieval tools are exempt. Previously the workspace `readFile` tool — the very tool the agent uses to read back an offloaded output — had its own (large) result offloaded again, replacing it with a second pointer stub. The agent could never see the retrieved content. Retrieval/inspection tools (`readFile`, `listDir`) are now never offloaded; the new `dawn.config.ts` `toolOutput.noOffloadTools` option adds further exemptions (merged with the always-exempt built-ins). Found by a live-API smoke test.
- Updated dependencies [30db6ed]
- Updated dependencies [b51de58]
- Updated dependencies [55b69f0]
- Updated dependencies [2e3bc8d]
- Updated dependencies [8133553]
- Updated dependencies [027b1cc]
- Updated dependencies [d4efa2a]
  - @dawn-ai/langchain@0.3.0
  - @dawn-ai/core@0.3.0
  - @dawn-ai/langgraph@0.3.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.2.0

### Minor Changes

- 17fa4aa: Configurable env loading for `dawn dev` and `dawn verify`. The env file is now resolved by precedence: `--env-file <path>` flag > `dawn.config.ts` `env` field > default `./.env`. Shell-exported variables still win over file contents.

  - New optional `DawnConfig.env` field (a path relative to the app root). Local-only — it does not affect the deploy artifact; `langgraph.json` env detection (`.env.example` → `.env`) is unchanged.
  - New `--env-file <path>` flag on `dawn dev` and `dawn verify`.
  - A shared `resolveEnvPath` resolver now backs both `dev` and `verify`, so they agree on which file they read.
  - `loadEnvFile(dir)` is refactored to `loadEnvFiles(absPaths)` with a back-compat wrapper retained; the LangSmith auto-trace and shell-wins behaviors are preserved.

  This unblocks monorepo apps: a nested app can set `env: "../../.env"` to load the workspace-root env file.

- ad17e85: Upgrade `@langchain/core` (0.3 → 1.x), `@langchain/langgraph` (0.2 → 1.x), `@langchain/openai` (0.3 → 1.x), and `zod` (3 → 4). Removes the dual-zod-version cast workaround in `tool-converter.ts`; `DynamicStructuredTool` now accepts Standard Schema directly. Downstream consumers must align on the new peer ranges (`@langchain/core >=1.1.0`).
- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.

- dd242ac: Add the `agents-md` built-in capability: Dawn now auto-injects `<workspace>/AGENTS.md` into every agent's system prompt under a `# Memory` heading on every model turn. Always-on (no opt-in marker). Preserves the feedback loop — the agent updates its memory via `writeFile` and the next turn sees the change automatically. Re-reads the file each turn (64 KiB cap; oversize, empty, or unreadable files render empty or a one-line notice).
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- 2ba0773: Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

  - An always-on `# Skills` section in the system prompt listing each skill's name + description
  - A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

  Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. Typegen includes `readSkill` in `RouteTools` when a route has skills. The chat example ships two seeded skills (`workspace-conventions`, `recover-from-failure`).

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- 13bc466: Fix SSE event payload double-wrap. `toSseEvent` used to emit `data: {"data": <value>}` for the built-in `chunk` event and for capability-contributed events like `plan_update`, when it should emit `data: <value>` directly. The shaped events (`tool_call`, `tool_result`, `done`) are unchanged.
- 36552c1: docs: rebrand "LangGraph Platform" → "LangSmith" in user-visible CLI strings, README, and comments. The `langgraph.json` artifact format is unchanged.
- Updated dependencies [17fa4aa]
- Updated dependencies [82dd52f]
- Updated dependencies [8e02fe1]
- Updated dependencies [ad17e85]
- Updated dependencies [cfc3e8c]
- Updated dependencies [dd242ac]
- Updated dependencies [c777569]
- Updated dependencies [34e615b]
- Updated dependencies [2ba0773]
- Updated dependencies [affeb46]
- Updated dependencies [12ee95f]
- Updated dependencies [1005b3a]
- Updated dependencies [e8462db]
  - @dawn-ai/core@0.2.0
  - @dawn-ai/langchain@0.2.0
  - @dawn-ai/langgraph@0.2.0
  - @dawn-ai/sqlite-storage@0.2.0
  - @dawn-ai/permissions@0.1.8

## 0.1.8

### Patch Changes

- 8c63c1a: Move testing helpers to `@dawn-ai/sdk/testing`.

  `expectError`, `expectMeta`, `expectOutput`, and the `RuntimeExecutionResult` type family now live at `@dawn-ai/sdk/testing` — the canonical home users have been intuitively reaching for. The old `@dawn-ai/cli/testing` subpath continues to work as a re-export for back-compat (and is now JSDoc-deprecated).

  ```ts
  // Preferred
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/sdk/testing";

  // Still works (re-exports from sdk)
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/cli/testing";
  ```

  No behavior change. The packed runtime contract test now exercises both subpaths.

  - @dawn-ai/core@0.1.8
  - @dawn-ai/langchain@0.1.8
  - @dawn-ai/langgraph@0.1.8

## 0.1.7

### Patch Changes

- db635b1: Docs overhaul.

  - **Public package READMEs** (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`) fleshed out with overview, install, key APIs, and links to the website.
  - All package READMEs include the Dawn brand image header.

  No code or runtime behavior changes — README content only.

- db635b1: Middleware context now flows through to tools.

  A tool's second argument is now `{ middleware?: Readonly<Record<string, unknown>>, signal: AbortSignal }`. Whatever the global middleware passes via `allow({ ... })` is available to every tool invocation as `ctx.middleware` — for both `/runs/wait` and `/runs/stream` paths.

  Example:

  ```ts
  // src/middleware.ts
  export default defineMiddleware(async (req) => {
    const userId = await verifyToken(req.headers.authorization);
    return allow({ userId });
  });

  // src/app/.../tools/lookup.ts
  export default async (input, { middleware }) => {
    const userId = middleware?.userId;
    return await db.lookup(userId, input);
  };
  ```

- db635b1: Production readiness: deployment config, LLM retry, request middleware.

  - **@dawn-ai/sdk:** `agent()` descriptor now accepts an optional `retry: { maxAttempts, baseDelay }`. Adds `defineMiddleware`, `reject(status, body?)`, `allow(context?)` for request middleware, plus `MiddlewareRequest`, `MiddlewareResult`, and `RetryConfig` types.
  - **@dawn-ai/cli:** `dawn build` produces a correctly-shaped `langgraph.json` for LangGraph Platform (`dependencies: ["."]`, `env` as file path). `dawn verify` adds an advisory `deps` check (4 checks total). Dev server loads `.env` files and runs middleware before route execution.
  - **@dawn-ai/langchain:** Per-agent retry config (`maxAttempts`, `baseDelayMs`) is wired through the agent adapter and applies to streaming and non-streaming paths.

- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
  - @dawn-ai/langchain@0.1.7
  - @dawn-ai/core@0.1.7
  - @dawn-ai/langgraph@0.1.7

## 0.1.6

### Patch Changes

- Use codegen schemas in dawn build output — tool descriptions and JSON Schema from .dawn/routes/<id>/tools.json are now injected into generated entry files for LangGraph Platform deployment.
  - @dawn-ai/core@0.1.6
  - @dawn-ai/langchain@0.1.6
  - @dawn-ai/langgraph@0.1.6

## 0.1.5

### Patch Changes

- 0127c57: Fix tool schema wiring so OpenAI receives valid function parameters from codegen-generated tools.json
- Updated dependencies [0127c57]
  - @dawn-ai/langchain@0.1.5
  - @dawn-ai/core@0.1.5
  - @dawn-ai/langgraph@0.1.5

## 0.1.4

### Patch Changes

- 86e24c0: Switch to pure OIDC trusted publishing (no npm token required)
  - @dawn-ai/core@0.1.4
  - @dawn-ai/langchain@0.1.4
  - @dawn-ai/langgraph@0.1.4

## 0.1.3

### Patch Changes

- 78745f6: chore: validate trusted publishing pipeline
  - @dawn-ai/core@0.1.3
  - @dawn-ai/langchain@0.1.3
  - @dawn-ai/langgraph@0.1.3

## 0.1.2

### Patch Changes

- Fix watch-mode typegen not picking up file changes due to ESM import cache
  - @dawn-ai/core@0.1.2
  - @dawn-ai/langchain@0.1.2
  - @dawn-ai/langgraph@0.1.2

## 0.1.0

### Minor Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

### Patch Changes

- Updated dependencies [fbe7770]
  - @dawn-ai/core@0.1.0

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/core@0.0.2
  - @dawn-ai/langchain@0.0.2
  - @dawn-ai/langgraph@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/core@0.0.1
  - @dawn-ai/langchain@0.0.1
  - @dawn-ai/langgraph@0.0.1
