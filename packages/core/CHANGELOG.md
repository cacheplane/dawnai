# @dawn-ai/core

## 1.0.0

### Minor Changes

- dd242ac: Add the `agents-md` built-in capability: Dawn now auto-injects `<workspace>/AGENTS.md` into every agent's system prompt under a `# Memory` heading on every model turn. Always-on (no opt-in marker). Preserves the feedback loop — the agent updates its memory via `writeFile` and the next turn sees the change automatically. Re-reads the file each turn (64 KiB cap; oversize, empty, or unreadable files render empty or a one-line notice).
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- 2ba0773: Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

  - An always-on `# Skills` section in the system prompt listing each skill's name + description
  - A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

  Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. Typegen includes `readSkill` in `RouteTools` when a route has skills. The chat example ships two seeded skills (`workspace-conventions`, `recover-from-failure`).

- affeb46: Capability tools can now mutate state channels via a Dawn-native `{result, state}` wrapped return shape — `result` becomes the agent-visible ToolMessage; `state` is a partial channel update applied via reducers. The langchain bridge translates this into a LangGraph `Command({update})` internally; capability authors don't import from `@langchain/langgraph`. Plain tool returns (anything not matching the strict wrapper shape) work unchanged.

  Planning's `write_todos` adopts the new shape, fixing the previously-documented re-emission loop: the `todos` state channel now actually reflects the agent's writes between turns, so the agent stops re-calling `write_todos` with the same content. The `plan_update` stream transformer also reads defensively from both legacy and Command-shaped tool outputs so the SSE event keeps firing.

### Patch Changes

- 12ee95f: Two fixes surfaced by live LLM smoke testing the chat example end-to-end:

  - **Planning `write_todos` now declares a real zod schema.** Previously the tool's `schema` field was undefined; the LangChain bridge fell back to `z.record(z.string(), z.unknown())`, which produced JSON Schema without `properties`. OpenAI strict-mode tool calling rejected the tool with `400 Invalid schema for function 'write_todos': object schema missing properties`. Now the planning marker exports an explicit zod schema for `{ todos: Array<{ content, status }> }`. Adds `zod` as a runtime dependency of `@dawn-ai/core`.
  - **`# Memory` block now includes orientation text.** The agents-md prompt fragment used to inject `# Memory\n\n<content>` only. With both planning and memory loaded, the model often called `listDir` and `readFile` to look at AGENTS.md even though Dawn had already injected its contents. The fragment now opens with a short paragraph telling the agent the block IS the memory file, re-rendered each turn, and that the way to update it is `writeFile`. Existing unit tests still pass — the `# Memory` heading and content substrings are unchanged.

- Updated dependencies [e8462db]
  - @dawn-ai/sdk@1.0.0

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
