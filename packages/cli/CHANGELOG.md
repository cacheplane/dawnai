# @dawn-ai/cli

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
