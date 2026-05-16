# Phase 3 — Planning Capability (Sub-project 1) — Design

**Date:** 2026-05-15
**Status:** Draft — pending user approval
**Owner:** Brian Love

## Summary

Add a built-in planning capability to Dawn agents, opted in by the presence of a `plan.md` file in the route directory. When the file is present, Dawn auto-injects three things into the compiled LangGraph agent: a `write_todos` tool, a `todos` state channel, and a Dawn-locked planning guidance fragment appended to the user's `systemPrompt`. The current `todos` are re-injected into the system prompt every turn so the agent always sees its own plan. State changes stream to clients as a typed `plan_update` SSE event.

This sub-project is the first of seven that together compose Dawn's opinionated agent harness ("phase 3"). It is deliberately small in scope but exercises the three machinery pieces that every later sub-project will reuse: tool injection, state-channel injection, and prompt-fragment injection. Subsequent sub-projects (skills, subagents, etc.) build on the same internal autowiring engine.

## Motivation

Per `memory/project_dawn_harness_strategy.md`, Dawn is building its own opinionated agent harness inspired by — but not a copy of — LangChain's `deepagents`. The harness is autowired from filesystem conventions (the same way `tools/*.ts` is discovered today). The agent descriptor `agent({ model, systemPrompt })` stays minimal; capabilities come from the route's directory layout.

Planning is the smallest capability that forces all three injection mechanisms to exist. Once they exist, adding skills / subagents / tool-output offloading / etc. is incremental.

A working planning capability also closes a real gap from PR #140's chat example, which currently relies on the agent ad-hoc remembering to maintain a plan in `AGENTS.md`.

## Non-goals

- **Skills, subagents, sandbox backends, or any other phase-3 capability.** Each of those is its own sub-project.
- **Per-thread persistent plans on disk** (live mirror to `workspace/plans/<thread-id>.md`). The route-level `plan.md` is a *seed* file only; live state lives in the LangGraph thread state channel and streams via SSE.
- **Configurable planning prompt.** Dawn ships one tuned guidance block. Authors who want different planning semantics write their own `systemPrompt` and don't add a `plan.md`.
- **Incremental todo APIs** (`add_todo`, `update_todo(id, status)`). The agent uses one tool, `write_todos`, with full-replace semantics.
- **A `read_todos` tool.** The agent reads its current plan via system-prompt re-injection on each turn — no API call needed.
- **Live mirroring of `todos` state to `workspace/plan.md` on each update.** Deferred. Adds I/O reconciliation surface (per-thread vs. shared workspace, hand-edit semantics, write contention) that warrants its own design pass once a concrete consumer exists.
- **Backwards-compat shims.** The capability is opt-in; existing routes that don't have `plan.md` are entirely unaffected.

## User-facing surface

### Opt in: presence of `plan.md`

```
src/app/<route>/
├── index.ts        # agent({ model, systemPrompt })
├── state.ts        # (optional) user state schema
├── plan.md         # ← presence opts the agent into planning
└── tools/
    └── ...
```

`plan.md` may be:

- **Empty.** The opt-in marker only; agent starts with an empty `todos` list and populates it.
- **Seeded.** Markdown checklist that becomes the initial value of the `todos` channel for every new thread:
  ```markdown
  - [ ] Read AGENTS.md
  - [ ] Survey the workspace
  - [x] (this would be marked completed at thread start)
  ```

Parsing rules: lines matching `- [ ] <content>` and `- [x] <content>` (case-insensitive) become todo items. Other lines (headings, blank lines, prose) are ignored. Items in `[x]` form get `status: "completed"`; `[ ]` get `status: "pending"`. The `in_progress` status only appears at runtime via agent updates — it isn't expressible in the seed file (deliberate; the seed is "what should be done," not "what's mid-flight").

### What the agent sees

A new tool, `write_todos`, with the following shape:

```ts
write_todos(input: {
  todos: ReadonlyArray<{
    content: string
    status: "pending" | "in_progress" | "completed"
  }>
}): Promise<{ todos: TodoItem[] }>
```

Full-replace semantics: every call passes the entire new list. Returns the canonicalized list (after Dawn validation).

The agent does **not** see a separate `read_todos` tool. Instead, on every model turn, Dawn re-injects the current `todos` channel state into the system prompt via the planning guidance block (see below). The agent therefore always has its plan in immediate context.

### What the agent's `systemPrompt` becomes at runtime

If the user's authored `systemPrompt` is:

```
You are a coding agent. Use the workspace tools to do what the user asks.
```

Then at thread runtime, the effective system prompt is:

```
You are a coding agent. Use the workspace tools to do what the user asks.

# Planning

For tasks with multiple steps, maintain a plan using `write_todos({ todos: [...] })`.
Mark items `in_progress` immediately before working on them and `completed` when
finished. Always include the full list — `write_todos` is full-replace, not incremental.

Current plan:
- [in_progress] survey the workspace
- [pending] identify the user's goal before acting
- [completed] read AGENTS.md
```

The `# Planning` heading and the surrounding two paragraphs are **Dawn-locked**: a single tuned fragment shipped with the framework. The `Current plan:` block at the bottom regenerates each turn from the live `todos` channel.

### What the client sees

A new SSE event type on `POST /runs/stream`:

```jsonc
event: plan_update
data: {
  "todos": [
    { "content": "Read AGENTS.md",                     "status": "completed" },
    { "content": "Survey workspace",                   "status": "in_progress" },
    { "content": "Identify the user's goal before acting", "status": "pending" }
  ]
}
```

Emitted every time the agent calls `write_todos` and the call resolves successfully. UIs render it as a sidebar / progress bar / etc. Existing event types (`token`, `tool_call`, `tool_result`, `done`) are unchanged.

The full `todos` channel is also accessible via the standard LangGraph `GET /threads/<id>/state` endpoint for non-streaming consumers and tooling. No work required for that — it falls out of state-channel injection.

## Internal architecture

### The autowiring engine (born in this sub-project)

This sub-project introduces the **build-time autowiring engine** that every later phase-3 sub-project will use. The engine sits in `@dawn-ai/core` and is invoked during route compilation. Its responsibility:

> Given a route directory, scan it for capability markers (files / dirs matching known conventions), and produce a list of "capability contributions" — each describing tools, state channels, and prompt fragments to inject into the LangGraph build.

For this sub-project, exactly one capability marker exists: `plan.md`. The engine is built generically so that future sub-projects can register additional markers (`skills/`, `subagents/`, etc.) without re-architecting.

Concretely, the engine exports:

```ts
// @dawn-ai/core
export interface CapabilityMarker {
  readonly name: string                    // e.g., "planning"
  readonly detect: (routeDir: string) => Promise<boolean>
  readonly load: (routeDir: string) => Promise<CapabilityContribution>
}

export interface CapabilityContribution {
  readonly tools?: ReadonlyArray<DawnToolDefinition>
  readonly stateFields?: ReadonlyArray<ResolvedStateField>
  readonly promptFragment?: PromptFragment
  readonly initialState?: Record<string, unknown>
  readonly streamTransformers?: ReadonlyArray<StreamTransformer>
}

export interface PromptFragment {
  readonly placement: "after_user_prompt"   // v1: only one placement
  readonly render: (state: Record<string, unknown>) => string
}

export interface StreamTransformer {
  readonly observes: "tool_result"          // v1: only one observation point
  readonly transform: (event: ToolResultEvent) => AsyncIterable<HumanFacingEvent>
}
```

A `CapabilityMarker` is registered once at framework startup. The engine iterates registered markers, asks each whether it applies to the current route, and if so calls `load()` to get the contribution. Contributions are merged into the existing route compilation pipeline.

This shape is deliberately minimal — it covers exactly what planning needs and exactly what `tools/` discovery already needs (which we'll retroactively re-express through the same interface in a small refactor). Later sub-projects extend the contribution shape if they need things v1 doesn't model (e.g., subagent declarations).

### Where each piece lives

| Concern | Package | Notes |
|---|---|---|
| `CapabilityMarker` interface + registry + engine | `@dawn-ai/core` | Generic, backend-neutral. |
| `planning` `CapabilityMarker` (detects `plan.md`, parses checklist, declares the contribution) | `@dawn-ai/core` | Pure logic, no LangChain types. |
| `write_todos` tool implementation (the function the LangChain agent invokes) | `@dawn-ai/langchain` | LangGraph state-channel write. |
| Prompt fragment renderer (formats `Current plan:` block from `todos` state) | `@dawn-ai/langchain` | Knows how to read state for prompt injection. |
| `plan_update` SSE event emitter | `@dawn-ai/cli` | Lives in `runtime-server.ts` event mapping; observes `tool_result` events for the `write_todos` tool. |
| `todos` state-channel definition (Annotation with `replace` reducer) | `@dawn-ai/langchain` | Built via `state-adapter.ts`'s existing `materializeStateSchema` pathway, with the planning capability contributing fields. |

### Compilation pipeline (after change)

Today's compilation roughly does (per `packages/core/src/discovery/discover-routes.ts` and `packages/langchain/src/agent-adapter.ts`):

1. Discover route file (`src/app/<route>/index.ts`).
2. Read default export → `DawnAgent` descriptor.
3. Discover sibling `tools/*.ts` → tool list.
4. Discover sibling `state.ts` → user state schema.
5. Compile to LangGraph via `createReactAgent({ llm, tools, prompt, stateSchema })`.

After this sub-project:

1. Discover route file.
2. Read default export → `DawnAgent` descriptor.
3. **Run the autowiring engine over the route directory.** For each registered `CapabilityMarker`, detect → load → collect `CapabilityContribution`.
4. Discover sibling `tools/*.ts` → tool list. (Re-expressed as a built-in `CapabilityMarker` in this PR.)
5. Discover sibling `state.ts` → user state schema. (Same.)
6. Merge user tools + capability-contributed tools.
7. Merge user state schema + capability-contributed state fields.
8. Compose `effectiveSystemPrompt = userSystemPrompt + capabilityPromptFragments`.
9. Compose `initialState = mergedDefaults + capabilityInitialState`.
10. Compile to LangGraph as today.
11. Wrap the streaming pipeline so `streamTransformers` from contributions can emit additional human-facing events.

The user-visible behavior of routes without `plan.md` is **unchanged** — the planning marker's `detect` returns `false`, no contribution is added, the route compiles exactly as before.

### Typegen

The generated `RouteTools["/route"]` type currently lists user-defined tools from `tools/`. With planning enabled, it should also include `write_todos`. Concretely:

```ts
// .dawn/dawn.generated.d.ts (after this PR, for a route with plan.md)
export interface DawnRouteTools {
  "/chat": {
    readonly listDir: ...
    readonly readFile: ...
    readonly write_todos: (input: {
      todos: ReadonlyArray<{
        content: string
        status: "pending" | "in_progress" | "completed"
      }>
    }) => Promise<{ todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }>
  }
}
```

The typegen extension lives alongside the existing tool typegen in `packages/core/src/typegen/`. Capability-contributed tools are gathered from each contribution's `tools` array and rendered the same way user tools are. This puts a small but real load on the typegen extension to handle non-discovered tools — acceptable, and required for completeness.

## Edge cases & rules

- **`plan.md` exists but is unparseable** (e.g., no `- [ ]` lines, just prose) → opt-in still applies, but initial `todos` is empty. No warning.
- **`plan.md` exists alongside a user-authored `state.ts` that already declares a `todos` field** → conflict; the build fails fast with a precise error pointing at both files. Capability contributions cannot collide with user state.
- **`write_todos` is called with an empty array** → valid; clears the plan. Emits `plan_update` with empty `todos`.
- **`write_todos` is called with a malformed input** (e.g., bad status value) → tool returns a Zod validation error to the agent. No `plan_update` emitted for that turn.
- **`write_todos` is in the user's `tools/` directory** → conflict; the build fails fast. Tool names cannot collide between user-discovered and capability-contributed sets.
- **Concurrent `write_todos` calls within a single turn** → LangGraph serializes tool calls per turn, so this isn't a real race. The `replace` reducer means the last write wins.
- **Hand-editing `plan.md` after the file is loaded** → no effect on a running thread (the seed is read once at thread start). Affects subsequent threads.

## Tests

This being framework code (not an example), tests are required.

| Test | Where |
|---|---|
| `plan.md` parser handles empty file, checklist-only, mixed prose, malformed lines | `packages/core/test/planning.test.ts` |
| `CapabilityMarker` registry: register → detect → load round-trip | `packages/core/test/autowire-engine.test.ts` |
| Compilation: route with `plan.md` produces an effective state schema with `todos` channel; route without `plan.md` does not | `packages/langchain/test/planning.test.ts` |
| Compilation: route with `plan.md` produces an effective system prompt with the planning fragment appended; route without does not | `packages/langchain/test/planning.test.ts` |
| Conflict: route declares its own `todos` field in `state.ts` AND has `plan.md` → build fails with both file paths in the error | `packages/langchain/test/planning.test.ts` |
| Conflict: route has `tools/write_todos.ts` AND has `plan.md` → build fails with both paths | `packages/core/test/planning.test.ts` |
| Runtime: invoking the route with planning, agent calls `write_todos`, stream emits a `plan_update` event with the right todos | `packages/cli/test/dev-command.test.ts` (extended) |
| Typegen: route with `plan.md` produces a `RouteTools` entry that includes `write_todos` with the right input/output types | `packages/core/test/typegen.test.ts` (extended) |

No new LLM-touching tests required; everything above can be tested with mocked agent invocations.

## Documentation deliverables

- A new docs page (or section) at the marketing site introducing the planning capability with the `plan.md` convention. Out of scope for the implementation PR; tracked as a follow-up.
- Update `docs/next-iterations-roadmap.md` Phase 3 section to point at this spec and decompose the remaining sub-projects.
- The chat example (`examples/chat`) gets a follow-up commit (separate PR) to add a `plan.md` in the route directory and observe the planning capability in action.

## Success criteria

- A route with an empty `plan.md` compiles, exposes a `write_todos` tool to the agent at runtime, and streams a `plan_update` event when the tool is called.
- A route with a seeded `plan.md` starts each thread with the seeded todos as the initial channel value.
- A route without `plan.md` is byte-for-byte identical in behavior to before this change.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`, `pnpm pack:check` all pass.
- The new `CapabilityMarker` interface is reused by at least one existing concern (the `tools/*.ts` discovery is migrated to this interface in the same PR) — proves the abstraction is real, not a one-off.
- A simple manual test in the chat example: add `plan.md`, ask the agent to "plan how you'd add a new tool then write the plan to plan.md," observe `plan_update` events in the smoke-test web client and the agent's plan in the system prompt context.

## Open questions

- **Should the planning prompt fragment include any model-specific tuning?** v1: no — single block for all models. If GPT-5 vs Claude vs Gemini behave noticeably differently with the same instructions, we'd add per-model variants in a later iteration.
- **What happens if `plan.md` content is non-UTF-8 or larger than some sane limit?** v1: read up to 64 KiB, treat encoding errors as parse failures (empty initial todos). Document the limit.
- **Stream event versioning.** Adding a new SSE event type on `/runs/stream` is backwards-compatible (old clients ignore unknown events), but worth confirming downstream consumers (LangSmith Studio, future Dawn dashboard) won't break. Verify during implementation.

## Out of scope (future sub-projects in the phase-3 program)

In rough sequence; each gets its own spec/plan/PR cycle:

2. **Skills** (`skills/<name>.md` + `AGENTS.md` autoload).
3. **Subagents** (sibling-route discovery + auto-generated `task` tool).
4. **Pluggable filesystem / exec backends** (`dawn.config.ts` declaration).
5. **Nested-object tool inputs** (typegen extension).
6. **Tool-output offloading + summarization** (uses the autowiring engine + sub-project 4).
7. **Agent Protocol-compatible HTTP endpoints** (for async subagents).

Each later sub-project will reuse the autowiring engine introduced here. By the time sub-project 7 ships, the engine should be a stable, well-shaped contract.
