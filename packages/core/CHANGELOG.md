# @dawn-ai/core

## 0.8.1

### Patch Changes

- 89b2a73: Harden the workspace path jail against symlink escapes. `FilesystemBackend` gains a required `realPath(path, ctx)` method; `localFilesystem` implements it (resolving symlinks via the deepest existing ancestor so not-yet-created write targets work), and `createWorkspaceFs` canonicalizes both the candidate path and the workspace root before the permission gate. A symlink inside `workspace/` that points outside is now correctly gated instead of being silently classified as inside.

  **Action for custom `FilesystemBackend` implementations:** add a `realPath` method — return the path unchanged (`async (p) => p`) if your backend has no symlink semantics. (Shipped as a patch since `localFilesystem`, the only built-in backend, already implements it; custom backends are not expected at this 0.x stage.)

  **Behavior note:** allow rules for paths outside the workspace are now matched against the canonical (symlink-resolved) path. If your workspace or an allowed target lives under a symlink, express allow-rule paths in canonical form; rules written against a non-canonical alias will fail closed. (No effect when your paths contain no symlinks.)

- Updated dependencies [407303f]
- Updated dependencies [89b2a73]
  - @dawn-ai/sqlite-storage@0.8.1
  - @dawn-ai/workspace@0.8.1
  - @dawn-ai/permissions@0.8.1
  - @dawn-ai/sdk@0.8.1

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Minor Changes

- a38ff61: Sandboxed `ctx.fs` for route tools and workflow/graph entries. Tools and route entries now receive a `WorkspaceFs` handle (`readFile`, `readBinaryFile`, `writeFile`, `listDir`) that resolves paths against the route's `workspace/` directory and runs the same permission gate as the agent-facing workspace tools — no more dropping to `node:fs`. The permission gate is extracted to a shared core module; in execution contexts where interactive prompts can't appear (workflow/graph entries), outside-workspace access fails closed with guidance to add an allow rule.

### Patch Changes

- Updated dependencies [917a99f]
- Updated dependencies [a38ff61]
- Updated dependencies [fa8bdd4]
  - @dawn-ai/workspace@0.3.0
  - @dawn-ai/sdk@0.7.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.6.0

### Patch Changes

- @dawn-ai/sdk@0.6.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0
- @dawn-ai/workspace@0.2.0

## 0.5.0

### Patch Changes

- @dawn-ai/sdk@0.5.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0
- @dawn-ai/workspace@0.2.0

## 0.4.0

### Patch Changes

- @dawn-ai/sdk@0.4.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0
- @dawn-ai/workspace@0.2.0

## 0.3.0

### Minor Changes

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
- d4efa2a: `@dawn-ai/core`: the workspace and AGENTS.md capabilities now activate relative to the **app root** instead of `process.cwd()`, so they work when an app is run from any working directory (e.g. in-process tests, embedded use). No behavior change under `dawn dev` (where cwd is the app root). `CapabilityMarkerContext` gained a required `appRoot: string` field — if you construct that type in a custom capability marker or its tests, add `appRoot`.

  Extend `@dawn-ai/testing` to cover the rest of Dawn's agent capabilities. `AgentRunResult` now captures interrupts, plan updates, subagent runs, and the composed system prompt (read from aimock's request journal via `AimockHandle.getRequests()`); `harness.resume({ decision })` drives HITL interrupt→resume flows. New matchers: `expectInterrupt`/`expectNoInterrupt`, `expectSubagent`, `expectPlan`, `expectSystemPrompt` (and `expectPlan().toHaveLength`, `expectSystemPrompt().toMatch`). Dawn's own chat/coordinator example apps are now dogfooded with in-process e2e for HITL permissions, subagents, planning, skills, and AGENTS.md memory. The dogfood surfaced and fixed a harness bug: gpt-5/reasoning routes send the system prompt under the `developer` role, which the system-prompt capture now recognizes. No framework changes — all capability events were already emitted by the runtime. CI now runs the `@dawn-ai/testing` package suite and the chat-example capability e2e (both were previously absent from the vitest workspace).

### Patch Changes

- 55b69f0: Fix tool-output offloading so retrieval tools are exempt. Previously the workspace `readFile` tool — the very tool the agent uses to read back an offloaded output — had its own (large) result offloaded again, replacing it with a second pointer stub. The agent could never see the retrieved content. Retrieval/inspection tools (`readFile`, `listDir`) are now never offloaded; the new `dawn.config.ts` `toolOutput.noOffloadTools` option adds further exemptions (merged with the always-exempt built-ins). Found by a live-API smoke test.
- 2e3bc8d: Fix tool-input schema extraction for standalone literal types. A single string-literal type (e.g. a discriminated-union discriminant like `by: "date"`) was not recognized as an enum (only multi-member literal unions were), so it fell through to object extraction and was misread as an object carrying `String.prototype` methods (`charAt`, `toString`, …). This produced a bogus schema that rejected the correct argument, breaking every discriminated/object-union tool parameter end-to-end. Standalone string/number/boolean literals now extract correctly, and object extraction is guarded to genuine object types. Found by a live-API smoke test.
- Updated dependencies [027b1cc]
  - @dawn-ai/workspace@0.2.0
  - @dawn-ai/sdk@0.3.0
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

- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.

- dd242ac: Add the `agents-md` built-in capability: Dawn now auto-injects `<workspace>/AGENTS.md` into every agent's system prompt under a `# Memory` heading on every model turn. Always-on (no opt-in marker). Preserves the feedback loop — the agent updates its memory via `writeFile` and the next turn sees the change automatically. Re-reads the file each turn (64 KiB cap; oversize, empty, or unreadable files render empty or a one-line notice).
- c777569: Support nested structures in tool input schemas: nested objects, arrays of objects, `Record<string,T>` maps, and object unions (arbitrary depth, capped at 8 levels). Previously any non-flat input type was silently coerced to `string` in both the generated JSON Schema and the runtime Zod schema. Schemas are emitted fully inlined (no `$ref`); `Record` maps and object unions are incompatible with provider strict mode (documented), which Dawn does not currently enable.
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- 2ba0773: Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

  - An always-on `# Skills` section in the system prompt listing each skill's name + description
  - A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

  Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. Typegen includes `readSkill` in `RouteTools` when a route has skills. The chat example ships two seeded skills (`workspace-conventions`, `recover-from-failure`).

- affeb46: Capability tools can now mutate state channels via a Dawn-native `{result, state}` wrapped return shape — `result` becomes the agent-visible ToolMessage; `state` is a partial channel update applied via reducers. The langchain bridge translates this into a LangGraph `Command({update})` internally; capability authors don't import from `@langchain/langgraph`. Plain tool returns (anything not matching the strict wrapper shape) work unchanged.

  Planning's `write_todos` adopts the new shape, fixing the previously-documented re-emission loop: the `todos` state channel now actually reflects the agent's writes between turns, so the agent stops re-calling `write_todos` with the same content. The `plan_update` stream transformer also reads defensively from both legacy and Command-shaped tool outputs so the SSE event keeps firing.

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- 8e02fe1: Move `@dawn-ai/sqlite-storage` from `peerDependencies` to `dependencies`. It backs the default SQLite checkpointer/threads store that `@dawn-ai/core` ships, so a direct dependency reflects the real relationship and avoids requiring consumers to install it separately.
- 12ee95f: Two fixes surfaced by live LLM smoke testing the chat example end-to-end:

  - **Planning `write_todos` now declares a real zod schema.** Previously the tool's `schema` field was undefined; the LangChain bridge fell back to `z.record(z.string(), z.unknown())`, which produced JSON Schema without `properties`. OpenAI strict-mode tool calling rejected the tool with `400 Invalid schema for function 'write_todos': object schema missing properties`. Now the planning marker exports an explicit zod schema for `{ todos: Array<{ content, status }> }`. Adds `zod` as a runtime dependency of `@dawn-ai/core`.
  - **`# Memory` block now includes orientation text.** The agents-md prompt fragment used to inject `# Memory\n\n<content>` only. With both planning and memory loaded, the model often called `listDir` and `readFile` to look at AGENTS.md even though Dawn had already injected its contents. The fragment now opens with a short paragraph telling the agent the block IS the memory file, re-rendered each turn, and that the way to update it is `writeFile`. Existing unit tests still pass — the `# Memory` heading and content substrings are unchanged.

- Updated dependencies [82dd52f]
- Updated dependencies [cfc3e8c]
- Updated dependencies [1005b3a]
- Updated dependencies [e8462db]
  - @dawn-ai/sdk@0.2.0
  - @dawn-ai/sqlite-storage@0.2.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/workspace@0.1.8

## 0.1.8

### Patch Changes

- Updated dependencies [8c63c1a]
  - @dawn-ai/sdk@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
  - @dawn-ai/sdk@0.1.7

## 0.1.6

### Patch Changes

- @dawn-ai/sdk@0.1.6

## 0.1.5

### Patch Changes

- @dawn-ai/sdk@0.1.5

## 0.1.4

### Patch Changes

- @dawn-ai/sdk@0.1.4

## 0.1.3

### Patch Changes

- @dawn-ai/sdk@0.1.3

## 0.1.2

### Patch Changes

- @dawn-ai/sdk@0.1.2

## 0.1.0

### Minor Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/sdk@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/sdk@0.0.1
