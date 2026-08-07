# @dawn-ai/testing

## 0.8.18

### Patch Changes

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

- Updated dependencies [7088072]
- Updated dependencies [c6b08a9]
  - @dawn-ai/cli@0.8.18
  - @dawn-ai/sdk@0.8.18
  - @dawn-ai/core@0.8.18
  - @dawn-ai/workspace@0.8.18
  - @dawn-ai/memory@0.8.18

## 0.8.17

### Patch Changes

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

- Updated dependencies [713797f]
- Updated dependencies [7f4bce6]
- Updated dependencies [1a9ae7b]
  - @dawn-ai/cli@0.8.17
  - @dawn-ai/core@0.8.17
  - @dawn-ai/sdk@0.8.17
  - @dawn-ai/workspace@0.8.17
  - @dawn-ai/memory@0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [451c000]
- Updated dependencies [d845720]
- Updated dependencies [2da55fa]
  - @dawn-ai/cli@0.8.16
  - @dawn-ai/core@0.8.16
  - @dawn-ai/memory@0.8.16
  - @dawn-ai/sdk@0.8.16
  - @dawn-ai/workspace@0.8.16

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

- Updated dependencies [029a2cf]
- Updated dependencies [48dbddf]
  - @dawn-ai/memory@0.8.15
  - @dawn-ai/core@0.8.15
  - @dawn-ai/cli@0.8.15
  - @dawn-ai/sdk@0.8.15
  - @dawn-ai/workspace@0.8.15

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
  - @dawn-ai/cli@0.8.14
  - @dawn-ai/sdk@0.8.14
  - @dawn-ai/workspace@0.8.14

## 0.8.13

### Patch Changes

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
- Updated dependencies [2b6be86]
- Updated dependencies [628d1c3]
- Updated dependencies [18df470]
- Updated dependencies [ee83a96]
- Updated dependencies [361a9ac]
- Updated dependencies [df54695]
  - @dawn-ai/cli@0.8.13
  - @dawn-ai/sdk@0.8.13
  - @dawn-ai/core@0.8.13
  - @dawn-ai/memory@0.8.13
  - @dawn-ai/workspace@0.8.13

## 0.8.12

### Patch Changes

- Updated dependencies [e413b05]
  - @dawn-ai/cli@0.8.12
  - @dawn-ai/core@0.8.12
  - @dawn-ai/memory@0.8.12
  - @dawn-ai/sdk@0.8.12
  - @dawn-ai/workspace@0.8.12

## 0.8.11

### Patch Changes

- Updated dependencies [f0261f1]
  - @dawn-ai/cli@0.8.11
  - @dawn-ai/core@0.8.11
  - @dawn-ai/memory@0.8.11
  - @dawn-ai/sdk@0.8.11
  - @dawn-ai/workspace@0.8.11

## 0.8.10

### Patch Changes

- Updated dependencies [e3c253b]
  - @dawn-ai/cli@0.8.10
  - @dawn-ai/core@0.8.10
  - @dawn-ai/memory@0.8.10
  - @dawn-ai/sdk@0.8.10
  - @dawn-ai/workspace@0.8.10

## 0.8.9

### Patch Changes

- ca9bc13: Add `@dawn-ai/memory-pgvector` — a Postgres + pgvector MemoryStore backend for
  production/multi-instance vector memory. Enable with
  `memory: { store: pgvectorMemoryStore({ connectionString, dimensions }) }`. HNSW
  (cosine) vector retrieval; reuses the exact same pure hybrid ranking (RRF +
  recency/confidence) as the default sqlite backend, so recall ordering is
  identical across backends. Adds a shared `runMemoryStoreConformance` kit
  (@dawn-ai/testing) run against both backends. Dimensions ≤2000 use `vector`,
  ≤4000 use `halfvec` (text-embedding-3-large); pgvectorscale/DiskANN and in-SQL
  RRF are deferred. Also pins `openaiEmbedder` to float embedding encoding
  (`encodingFormat: "float"`) — avoids a base64 decode interop quirk that could
  yield wrong embedding dimensionality against some proxies/mocks.
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
- Updated dependencies [628f0c1]
- Updated dependencies [ca9bc13]
- Updated dependencies [1dd2147]
  - @dawn-ai/sdk@0.8.9
  - @dawn-ai/core@0.8.9
  - @dawn-ai/cli@0.8.9
  - @dawn-ai/workspace@0.8.9
  - @dawn-ai/memory@0.8.9

## 0.8.8

### Patch Changes

- 6fb2b10: Improve the default scaffold and packaged external verification.

  The research scaffold now dogfoods reviewable memory and the Docker sandbox,
  shared scaffold tools can run through sandbox-aware workspace APIs, generated
  apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
  tests install the current packed devkit templates instead of stale registry
  contents.

- Updated dependencies [6fb2b10]
- Updated dependencies [dd02f56]
- Updated dependencies [26780ab]
- Updated dependencies [5ccae68]
- Updated dependencies [57e8cd9]
  - @dawn-ai/cli@0.8.8
  - @dawn-ai/core@0.8.8
  - @dawn-ai/memory@0.8.8
  - @dawn-ai/workspace@0.8.8
  - @dawn-ai/sdk@0.8.8

## 0.8.7

### Patch Changes

- Updated dependencies [6a683c8]
  - @dawn-ai/memory@0.8.7
  - @dawn-ai/core@0.8.7
  - @dawn-ai/cli@0.8.7
  - @dawn-ai/sdk@0.8.7
  - @dawn-ai/workspace@0.8.7

## 0.8.6

### Patch Changes

- Updated dependencies [9d115de]
- Updated dependencies [4ede7b8]
- Updated dependencies [1d51b75]
  - @dawn-ai/cli@0.8.6
  - @dawn-ai/workspace@0.8.6
  - @dawn-ai/core@0.8.6
  - @dawn-ai/sdk@0.8.6
  - @dawn-ai/memory@0.8.6

## 0.8.5

### Patch Changes

- Updated dependencies [91d999c]
- Updated dependencies [f195096]
  - @dawn-ai/cli@0.8.5
  - @dawn-ai/core@0.8.5
  - @dawn-ai/memory@0.8.5
  - @dawn-ai/sdk@0.8.5
  - @dawn-ai/workspace@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [f8c3a21]
- Updated dependencies [4e3e020]
  - @dawn-ai/cli@0.8.4
  - @dawn-ai/core@0.8.4
  - @dawn-ai/memory@0.8.4
  - @dawn-ai/sdk@0.8.4
  - @dawn-ai/workspace@0.8.4

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
  - @dawn-ai/cli@0.8.3
  - @dawn-ai/sdk@0.8.3
  - @dawn-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- 5372180: Add `dawn eval --record`. Records replayable aimock fixtures from a real-model
  eval run into per-case sibling `<evalBasename>.<caseSlug>.fixtures.json` files,
  auto-loaded on a plain (replay) `dawn eval`. Inline `script()` fixtures stay
  authoritative (record skips those cases); the gate still applies during record
  but captured fixtures are flushed per-case before the verdict. New
  `@dawn-ai/testing` harness capability: `createAgentHarness({ record: true })` +
  `harness.getRecordedFixtures()`.
- f62b555: Consistent lifecycle API. Every harness/handle is now created with a `create*` factory and torn down with `close()` (plus `[Symbol.asyncDispose]`, so `await using` works everywhere). **Breaking renames:** `startAimock` → `createAimock` (type `AimockHandle` → `Aimock`, `.stop()` → `.close()`); `startSubprocessApp` → `createSubprocessApp` (`.stop()` → `.close()`); `injectAgentProtocol` → `createAgentProtocolInjector`. The `create*Harness` helpers and pure fixture functions are unchanged.
- 1241d21: Unit-test harnesses for tools, middleware, and the workspace. `createToolHarness(tool)` invokes a route tool against a real, temp-backed `ctx.fs` (reusable `invoke()` for cumulative-state assertions); `createMiddlewareHarness(mw)` exercises a `FilesystemMiddleware` over a temp `localFilesystem` and offers `assertForwardsAll()` to catch dropped backend methods; `createWorkspaceHarness()` is the shared temp-`WorkspaceFs` fixture, also usable to test `ctx.fs` code directly. All are async `create*Harness` factories with `.close()` and `[Symbol.asyncDispose]` (for `await using`), matching `createAgentHarness`. Adds `@dawn-ai/workspace` and `@dawn-ai/sdk` as peer dependencies.
- Updated dependencies [5372180]
  - @dawn-ai/cli@0.8.2
  - @dawn-ai/core@0.8.2
  - @dawn-ai/sdk@0.8.2
  - @dawn-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- 306380e: Fix test-harness scenario isolation. `createAgentHarness().reset()` now clears
  the accumulated aimock fixtures (restoring the constructor baseline) instead of
  only swapping the thread id. Previously fixtures were registered additively and
  aimock's matcher is first-match-in-array-order, so a loosely-matched fixture
  from an earlier scenario (a raw `FixtureSet` without a `userMessage`, e.g. the
  offload pattern) could shadow a later run's first model call. This surfaced as a
  HITL permission interrupt that "only fired on the first run." The research
  scaffold's HITL test now shares one harness with `reset()` between tests instead
  of constructing a dedicated one.
- Updated dependencies [407303f]
- Updated dependencies [89b2a73]
  - @dawn-ai/cli@0.8.1
  - @dawn-ai/core@0.8.1

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward. This package is renumbered down from its previous independent 5.x line; the old higher versions were removed from npm.

## 5.0.0

### Minor Changes

- 2be46a4: Add `expectToolSequence(run, names, opts?)` and `expectNoToolErrors(run)` matchers,
  plus a derived `toolResults` field on `AgentRunResult` (and a `deriveToolResults`
  helper). `expectToolSequence` asserts tool call order (subsequence by default,
  `{ strict: true }` for contiguous); `expectNoToolErrors` catches tools that
  returned an error result while correctly treating HITL permission interrupts as
  non-errors.

### Patch Changes

- Updated dependencies [9fd967f]
- Updated dependencies [a38ff61]
  - @dawn-ai/cli@0.7.0
  - @dawn-ai/core@0.7.0

## 4.0.0

### Patch Changes

- @dawn-ai/cli@0.6.0
- @dawn-ai/core@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies [b4a2295]
  - @dawn-ai/cli@0.5.0
  - @dawn-ai/core@0.5.0

## 2.0.0

### Patch Changes

- @dawn-ai/cli@0.4.0
- @dawn-ai/core@0.4.0

## 1.0.0

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

- d4efa2a: `@dawn-ai/core`: the workspace and AGENTS.md capabilities now activate relative to the **app root** instead of `process.cwd()`, so they work when an app is run from any working directory (e.g. in-process tests, embedded use). No behavior change under `dawn dev` (where cwd is the app root). `CapabilityMarkerContext` gained a required `appRoot: string` field — if you construct that type in a custom capability marker or its tests, add `appRoot`.

  Extend `@dawn-ai/testing` to cover the rest of Dawn's agent capabilities. `AgentRunResult` now captures interrupts, plan updates, subagent runs, and the composed system prompt (read from aimock's request journal via `AimockHandle.getRequests()`); `harness.resume({ decision })` drives HITL interrupt→resume flows. New matchers: `expectInterrupt`/`expectNoInterrupt`, `expectSubagent`, `expectPlan`, `expectSystemPrompt` (and `expectPlan().toHaveLength`, `expectSystemPrompt().toMatch`). Dawn's own chat/coordinator example apps are now dogfooded with in-process e2e for HITL permissions, subagents, planning, skills, and AGENTS.md memory. The dogfood surfaced and fixed a harness bug: gpt-5/reasoning routes send the system prompt under the `developer` role, which the system-prompt capture now recognizes. No framework changes — all capability events were already emitted by the runtime. CI now runs the `@dawn-ai/testing` package suite and the chat-example capability e2e (both were previously absent from the vitest workspace).

- 64ca1c7: `@dawn-ai/testing`: close the fixture record→commit→replay loop with `loadFixtures(path)` / `writeFixtures(path, script()|FixtureSet)`, and add a gated live mode — `createAgentHarness({ live: true })` runs the real model via aimock proxy-record (real responses, with `run.systemPrompt` retained), requiring `OPENAI_API_KEY` and meant to be gated with `skipIf` (never in CI). Drift detection remains deferred to a future phase. (A `create-dawn-ai-app` scaffold sample test will follow once `@dawn-ai/testing` is published to npm.)

### Patch Changes

- Updated dependencies [b51de58]
- Updated dependencies [55b69f0]
- Updated dependencies [2e3bc8d]
- Updated dependencies [8133553]
- Updated dependencies [027b1cc]
- Updated dependencies [d4efa2a]
  - @dawn-ai/cli@0.3.0
  - @dawn-ai/core@0.3.0
