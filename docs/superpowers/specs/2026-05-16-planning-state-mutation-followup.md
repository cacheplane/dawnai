# Planning capability — state mutation gap (follow-up)

**Date:** 2026-05-16
**Status:** **RESOLVED in PR #150** — adopted the `{result, state}` wrapped-return shape via sub-project 2c. Planning's `write_todos` now mutates the `todos` channel. The "re-emission loop" observed in live LLM smoke turned out to be a model-behavior issue, not a framework issue — see [the runtime bug followup](2026-05-16-tool-state-mutation-runtime-bug-followup.md) for the full retrospective.
**Owner:** Brian Love

## The bug

`write_todos` doesn't actually update the `todos` state channel. The tool runs successfully, its output goes back to the agent as a ToolMessage, and the planning prompt fragment's `Current plan:` block always renders the initial value (empty or `plan.md` seed).

Observed in live smoke testing of the chat example (#148 description). The agent calls `write_todos`, sees no state change reflected in its next-turn prompt, and re-calls `write_todos` with the same content — burning context and sometimes hitting the LangGraph recursion limit.

## Root cause

`packages/core/src/capabilities/built-in/planning.ts`:

```ts
const writeTodos = {
  name: "write_todos",
  // ...
  run: (input: unknown) => {
    // The actual state mutation happens in the langchain runtime;
    // this run() just echoes the canonicalized input back so the
    // tool result event carries the new todos.
    const validated = validateWriteTodosInput(input)
    return { todos: validated }
  },
}
```

The comment promised "langchain handles the mutation" — but it doesn't. The `tool-converter.ts` in `@dawn-ai/langchain` wraps the tool's return value via `JSON.stringify(result)` and emits it as a ToolMessage's content. LangGraph never sees an instruction to update the `todos` channel.

## Why this is bigger than "polish"

A real fix needs a framework concept: tools that mutate state channels. Options:

1. **LangGraph `Command` returns.** A tool can return `new Command({ update: { todos: ... } })`; LangGraph applies the update via the channel's reducer. The tool-converter needs to detect `isCommand(result)` and pass it through without `JSON.stringify`. But `@dawn-ai/core`'s `planning.ts` doesn't import from `@langchain/langgraph` today — adopting `Command` either couples core to langgraph or moves the planning marker into `@dawn-ai/langchain`.

2. **New `stateUpdate` metadata on the tool definition.** Capability tools declare which state field they mutate: `{ name, run, stateUpdate: (input, output) => Partial<State> }`. The langchain adapter intercepts tool results and constructs a Command from the metadata. Keeps core decoupled, but it's net-new API surface.

3. **Reducer that derives state from messages.** The `todos` channel's reducer could scan recent messages for `write_todos` tool results and extract the latest. Conflates message processing with reduction; ugly.

Recommended path: **option 1**, with the planning marker moved into `@dawn-ai/langchain` (which already has `Command` available). The CapabilityMarker interface stays in core; the planning marker registers from langchain.

## Test/repro

Live smoke with an OpenAI key against `examples/chat/server` with the seeded `workspace/AGENTS.md`. Ask the agent to make a plan, observe write_todos called repeatedly. The captured log from #148's smoke is in this session's transcript.

Without a key, you can manually verify in a unit test by:
1. Building a route with `plan.md`.
2. Applying the planning marker.
3. Calling the contributed `write_todos` tool's `run()` directly.
4. Re-rendering the planning prompt fragment with `{ todos: [] }` as `state` — observe `Current plan: (empty)` even after `write_todos` "ran."

## Scope of the fix PR

- Move planning marker to `@dawn-ai/langchain` (or solve the import-Command-from-core problem).
- `write_todos.run` returns `new Command({ update: { todos: validated } })`.
- `tool-converter.ts` detects `isCommand` and passes through without serialization.
- Test: invoke the route end-to-end (mocked LLM), call write_todos twice with different todos, verify state channel reflects the latest values.
- Doc: update planning sub-project spec (#144 era) to reflect actual mechanism.

## Out of scope here

This file documents the gap. The fix itself is a separate sub-project — comparable in size to one of the phase-3 sub-projects, since it touches the core marker, the langchain bridge, and the tool-result event shape.
