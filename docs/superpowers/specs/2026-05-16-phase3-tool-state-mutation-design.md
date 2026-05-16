# Phase 3 — Capability Tool State Mutation (Sub-project 2c) — Design

**Date:** 2026-05-16
**Status:** Draft — pending user approval
**Owner:** Brian Love

## Summary

Add a Dawn-native API for capability tools to mutate state channels. The contract: a tool's `run` function may return a wrapped result of shape `{ result, state? }`. The `result` becomes the agent-visible ToolMessage content; the optional `state` is a partial object of state-channel updates applied via the channels' configured reducers.

The langchain bridge translates `state` into a LangGraph `Command({ update })` internally — the `Command` type stays scoped to the bridge and never appears in `@dawn-ai/core`. Capability authors write plain TS. Other backends (future) implement their own translation.

In the same PR, planning's `write_todos` adopts the new pattern. This fixes the re-emission loop documented in [the previous follow-up spec](2026-05-16-planning-state-mutation-followup.md) and proves the API works end-to-end.

## Motivation

Live-LLM smoke testing of the chat example surfaced that `write_todos` doesn't actually mutate the `todos` state channel — the tool runs, returns its output as a string ToolMessage, and the channel stays at its initial value. The agent sees no state change between turns and re-calls `write_todos` with the same content, sometimes hitting LangGraph's recursion limit.

Sub-project 2b (Skills) has the same requirement: when the agent calls `load_skill(name)`, the loaded skill's content needs to persist in a `loaded_skills` state channel so it's re-injected into the system prompt on every subsequent turn. Without a working state-mutation API, Skills can't ship cleanly either.

So this sub-project IS the foundation for the rest of phase 3's stateful capabilities.

## Non-goals

- **A general "side effects from tools" API.** This is scoped to state-channel writes only. Tools that need to call external APIs, write files, etc., still do that imperatively in `run`'s body.
- **Streaming events from tools.** Capability tools already have a separate mechanism (`StreamTransformer`) for emitting human-facing events when their results flow through the agent loop. That stays.
- **Replacing LangGraph's `Command`.** `Command` continues to be the LangGraph-level primitive. We add a Dawn-native shape that the bridge translates into `Command` so capability authors don't import from `@langchain/langgraph`.
- **Conditional state updates / interrupts / human-in-the-loop.** All beyond v1 scope.
- **Migrating user-authored tools.** Users' tools in `tools/*.ts` keep their existing contract — plain return values. The new shape is opt-in for capability tools (and any user tool that wants it).
- **Sub-project 2b (Skills).** Out of scope. Skills is the next sub-project after this lands.

## The contract

A tool's `run` function returns one of:

| Return shape | Interpretation |
|---|---|
| `string` | Plain — becomes the ToolMessage content verbatim, no JSON wrapping. |
| `{ result: string, state?: object }` | Wrapped — `result` becomes the ToolMessage content verbatim; optional `state` is applied to channels. |
| `{ result: <object>, state?: object }` | Wrapped — `result` is `JSON.stringify`'d into the ToolMessage; optional `state` is applied to channels. |
| anything else | Plain — `JSON.stringify`'d into the ToolMessage. |

Detection rule for the wrapped shape: the returned value is an object whose own enumerable keys are **exactly** `result`, or **exactly** `result` and `state` (in any order). Any extra keys → treated as a plain return. Any missing `result` → plain return. The strict check prevents accidental misclassification of plain-object returns that happen to share the field name.

`state`'s shape is `Partial<State>` — keys are state-channel names (matching what the capability's `stateFields` declared), values are the new channel values. Each entry is applied via the channel's configured reducer. Channels not in `state` are left untouched.

`state`'s validation is structural only at the bridge layer; the channel reducer enforces semantics. If `state.todos` is the wrong shape, the reducer's `replace` won't care, but downstream code reading `state.todos` will fail at use time. (Future: tighten with zod validation per channel. Deferred.)

## Examples

**Planning's `write_todos` (after this PR):**

```ts
const writeTodos = {
  name: "write_todos",
  description: "...",
  schema: WRITE_TODOS_INPUT,
  run: (input: unknown) => {
    const validated = validateWriteTodosInput(input)
    return {
      result: { todos: validated },   // → JSON.stringify'd ToolMessage content
      state:  { todos: validated },   // → todos channel write
    }
  },
}
```

The agent sees the tool's JSON output in the ToolMessage (`{"todos":[...]}`) and on the next turn the planning prompt fragment renders `Current plan:` from the now-updated `todos` channel.

**Plain string result (a future capability that returns a status message):**

```ts
run: () => "Memory checkpoint saved."
// → ToolMessage content is literally "Memory checkpoint saved." — no surrounding quotes
```

**Plain object result (existing behavior, unchanged):**

```ts
run: () => ({ filename: "AGENTS.md", bytes: 312 })
// → ToolMessage content is '{"filename":"AGENTS.md","bytes":312}'
```

**Wrapped with string result and no state (no-op wrapping):**

```ts
run: () => ({ result: "done" })
// → ToolMessage content is "done", no state mutation
```

## Internal architecture

### Where the change lives

| Concern | File |
|---|---|
| Wrapped-return detection helper + state extraction | `packages/langchain/src/tool-converter.ts` (or a new sibling file) |
| `Command`-construction logic that consumes the extracted `state` | `packages/langchain/src/tool-converter.ts` |
| Verbatim-string-result vs `JSON.stringify` branch in the ToolMessage content path | Same |
| Planning marker updated | `packages/core/src/capabilities/built-in/planning.ts` |
| New tests | `packages/langchain/test/tool-converter.test.ts` (extend), new `packages/langchain/test/tool-state-mutation.test.ts` |

`@dawn-ai/core` does **not** change otherwise. The capability tool's `run` signature stays `(input, context) => unknown | Promise<unknown>`. The new shape is structural.

### Bridge implementation sketch

In `packages/langchain/src/tool-converter.ts`'s `convertToolToLangChain`, the inner `func` currently looks roughly like:

```ts
func: async (input, _runManager, config) => {
  const signal = config?.signal ?? new AbortController().signal
  const result = await tool.run(input, { ..., signal })
  return JSON.stringify(result)
},
```

After this PR, it becomes (sketch):

```ts
func: async (input, _runManager, config) => {
  const signal = config?.signal ?? new AbortController().signal
  const rawResult = await tool.run(input, { ..., signal })

  const { content, stateUpdates } = unwrapToolResult(rawResult)

  if (stateUpdates) {
    return new Command({ update: stateUpdates, ...maybeToolMessage(content) })
  }
  return content
}
```

`unwrapToolResult`:
- Detects the `{result, state?}` shape per the rules above.
- Returns `content` (the JSON-stringified or verbatim-string ToolMessage payload) and `stateUpdates` (the extracted `state` object or `undefined`).

`maybeToolMessage`: when returning a `Command`, LangGraph 1.x's tool wrapper needs both the state update AND the tool message it normally would have built. The bridge constructs a `ToolMessage({ content, tool_call_id, name })` from the originating tool call context and includes it in `Command.messages` alongside the `update`.

### Why this keeps `Command` scoped

Capability authors only see `{ result, state }` — no LangChain types in their imports. The translation to `Command` happens in `@dawn-ai/langchain`'s `tool-converter.ts`, which already depends on LangChain. Future backends would implement their own version of `unwrapToolResult` → backend-native state mutation, with no changes required in `@dawn-ai/core` or in capability markers.

### Planning marker change

`packages/core/src/capabilities/built-in/planning.ts`'s `writeTodos.run`:

```ts
// Before:
run: (input: unknown) => {
  const validated = validateWriteTodosInput(input)
  return { todos: validated }
}

// After:
run: (input: unknown) => {
  const validated = validateWriteTodosInput(input)
  return {
    result: { todos: validated },
    state:  { todos: validated },
  }
}
```

The existing `# Planning` prompt fragment already re-renders `Current plan:` from `state.todos` on every turn — once the channel actually updates, the agent sees its plan reflected, and the re-emission loop stops.

### `chain-adapter.ts` parallel

`chain-adapter.ts` calls tools via `tool-loop.ts`'s ReAct loop. Same `tool.run` interface; same wrapped-return detection should apply. The ReAct loop currently calls `tool.run(input, context)` and JSON-stringifies the result. After this PR, it consults `unwrapToolResult` and — if there's a `state` update — emits a state-channel write through whatever mechanism the chain-adapter uses to thread state.

Open question: does chain-adapter even have state channels in v1? If not, capability-tool state mutations are a no-op for `chain` routes; the bridge logs a warning. Confirm during implementation.

## Tests

| Test | File |
|---|---|
| `unwrapToolResult` detects `{ result }`, `{ result, state }`, both with object and string result types | `packages/langchain/test/tool-state-mutation.test.ts` |
| `unwrapToolResult` treats `{ result, state, extra }` as plain return | same |
| `unwrapToolResult` treats `{ state }` (no result) as plain return | same |
| `unwrapToolResult` treats `"foo"` as plain return (no wrap) | same |
| `unwrapToolResult` treats `{ a: 1, b: 2 }` as plain return | same |
| `convertToolToLangChain`: a tool returning `{result, state}` produces a `Command` with the right `update` and `messages` | `packages/langchain/test/tool-converter.test.ts` (extend) |
| `convertToolToLangChain`: a tool returning a plain value produces a string content (unchanged behavior) | same (existing test should already cover) |
| Planning end-to-end: invoke `write_todos`, verify the `todos` state channel actually reflects the new value on the next render | `packages/langchain/test/planning.test.ts` (extend with state-channel assertion) |

A live LLM smoke against the chat example is the final acceptance check — the agent calls `write_todos` and then does NOT re-call it on subsequent turns (proving the state actually updated). Manual; verified outside the test suite.

## Documentation deliverables

- Inline JSDoc on `unwrapToolResult` and `convertToolToLangChain` explaining the contract.
- Brief note in the planning capability's source comments that `write_todos` now uses the wrapped return shape.
- Update the planning sub-project spec (#144) with a footnote pointing at this spec for the actual state-mutation mechanism. Not in this PR — the original spec is historical; new readers should find this spec by date.
- No new docs page; this is internal API. When sub-project 2b (Skills) ships, its spec will reference this one.

## Edge cases & rules

- **A user-authored tool returns `{result: "x", state: {...}}` accidentally.** Treated as wrapped per the rules. If `state` happens to match a state channel name, it'll mutate the channel. Documented as an edge case; the structural check prevents most accidents, but a tool author could collide intentionally or by accident. Mitigation: only capabilities should be doing this; users should know what they're doing.
- **`state` references a channel name that doesn't exist on the route.** The reducer is keyed on channel name. LangGraph applies updates only to known channels and warns (or ignores) the rest. We don't validate this in the bridge.
- **Multiple capabilities' tools all write to the same channel in the same turn.** LangGraph serializes tool calls per turn, so each `Command` is applied in order via the channel's reducer. The reducer (`replace` or `append`) determines the merge semantics. The chat example never has overlapping state writes today.
- **`run` throws an error.** No state mutation occurs; the error propagates up as a tool-call failure. Existing behavior, unchanged.
- **`state` is `undefined` or `{}`.** Treated as no state mutation; the tool produces a plain ToolMessage. Same as omitting `state`.

## Success criteria

- Capability tools can return `{ result, state }` and the state mutation actually applies.
- Planning's `write_todos` returns the new shape; live smoke confirms the agent no longer loops on re-calling it.
- No new imports from `@langchain/langgraph` appear in `@dawn-ai/core`.
- No existing user-authored tool or capability is broken (all tests pass).
- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm pack:check` all pass.
- The `Command` construction in `tool-converter.ts` is contained to a single helper; visible at one site.

## Open questions

- **Verbatim-string-result handling for plain returns.** A pre-existing tool returning a `string` today gets `JSON.stringify`'d into the ToolMessage (wrapping it in quotes). This PR keeps that behavior for plain returns — changing it would be a separate concern. If we want plain string returns to be verbatim too, that's a follow-up.
- **Should `state` mutations also flow through the SSE stream as a `state_update` event?** Useful for UIs that want to render state changes live, parallel to `plan_update`. Not in this PR's scope, but worth considering for v2. Capabilities can already emit custom events via `StreamTransformer` if they need to.
- **Validating `state` against the channel's declared shape.** The reducer enforces nothing about types; an author could write `state: { todos: 42 }` and the channel ends up `42`. Future: integrate the capability's `stateFields` zod schemas to validate. Deferred.
