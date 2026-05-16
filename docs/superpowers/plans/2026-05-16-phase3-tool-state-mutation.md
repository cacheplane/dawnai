# Phase 3 — Capability Tool State Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Add a Dawn-native API for capability tools to mutate state channels (`{result, state}` wrapped return), translated by the langchain bridge into LangGraph `Command({update})` calls. Migrate planning's `write_todos` to the new shape so the re-emission loop is fixed.

**Architecture:** New `unwrap-tool-result.ts` helper in `@dawn-ai/langchain` detects the wrapped shape. `tool-converter.ts`'s inner `func` consults the helper; when state is present, returns a `Command({update, messages: [ToolMessage]})` instead of a string. `@dawn-ai/core`'s planning marker adopts the new shape — single-line diff at the `run` body.

**Tech Stack:** TypeScript 6.0.2, `@langchain/langgraph@1.3.0`, `@langchain/core@1.1.46`, vitest.

**Spec:** [docs/superpowers/specs/2026-05-16-phase3-tool-state-mutation-design.md](../specs/2026-05-16-phase3-tool-state-mutation-design.md)

**Working directory:** `/Users/blove/repos/dawn/.claude/worktrees/tool-state` (branch `claude/tool-state`).

---

## File map

**Create:**
- `packages/langchain/src/unwrap-tool-result.ts` — pure helper, the detection rule
- `packages/langchain/test/unwrap-tool-result.test.ts` — unit tests covering every shape branch
- `.changeset/phase3-tool-state-mutation.md`

**Modify:**
- `packages/langchain/src/tool-converter.ts` — `func` consults `unwrapToolResult`; returns `Command` when state present
- `packages/langchain/src/index.ts` — re-export `unwrapToolResult` (internal but useful for testing)
- `packages/core/src/capabilities/built-in/planning.ts` — `write_todos.run` returns `{result, state}`
- `packages/langchain/test/tool-converter.test.ts` — extend with a Command-return assertion
- `packages/langchain/test/planning.test.ts` — assert the state channel actually reflects writes

---

## Task 1: `unwrapToolResult` helper + tests (pure logic)

**Files:**
- Create: `packages/langchain/src/unwrap-tool-result.ts`
- Create: `packages/langchain/test/unwrap-tool-result.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/langchain/test/unwrap-tool-result.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { unwrapToolResult } from "../src/unwrap-tool-result.js"

describe("unwrapToolResult", () => {
  it("treats a string as plain — content is JSON-stringified", () => {
    expect(unwrapToolResult("hello")).toEqual({
      content: JSON.stringify("hello"),
      stateUpdates: undefined,
    })
  })

  it("treats a number as plain", () => {
    expect(unwrapToolResult(42)).toEqual({
      content: JSON.stringify(42),
      stateUpdates: undefined,
    })
  })

  it("treats null as plain", () => {
    expect(unwrapToolResult(null)).toEqual({
      content: JSON.stringify(null),
      stateUpdates: undefined,
    })
  })

  it("treats a plain object as plain (no `result` key)", () => {
    expect(unwrapToolResult({ a: 1, b: 2 })).toEqual({
      content: JSON.stringify({ a: 1, b: 2 }),
      stateUpdates: undefined,
    })
  })

  it("treats an array as plain", () => {
    expect(unwrapToolResult([1, 2, 3])).toEqual({
      content: JSON.stringify([1, 2, 3]),
      stateUpdates: undefined,
    })
  })

  it("unwraps { result } — object result is JSON-stringified, no state", () => {
    expect(unwrapToolResult({ result: { todos: [] } })).toEqual({
      content: JSON.stringify({ todos: [] }),
      stateUpdates: undefined,
    })
  })

  it("unwraps { result } where result is a string — content is verbatim", () => {
    expect(unwrapToolResult({ result: "done" })).toEqual({
      content: "done",
      stateUpdates: undefined,
    })
  })

  it("unwraps { result, state } — object result JSON-stringified, state passed through", () => {
    const value = {
      result: { todos: [{ content: "x", status: "pending" }] },
      state: { todos: [{ content: "x", status: "pending" }] },
    }
    expect(unwrapToolResult(value)).toEqual({
      content: JSON.stringify({ todos: [{ content: "x", status: "pending" }] }),
      stateUpdates: { todos: [{ content: "x", status: "pending" }] },
    })
  })

  it("unwraps { result, state } with string result — content is verbatim", () => {
    const value = { result: "ok", state: { foo: 1 } }
    expect(unwrapToolResult(value)).toEqual({
      content: "ok",
      stateUpdates: { foo: 1 },
    })
  })

  it("treats { result, state, extra } as plain (extra keys = not the wrapper shape)", () => {
    const value = { result: "x", state: { foo: 1 }, extra: "ignored" }
    expect(unwrapToolResult(value)).toEqual({
      content: JSON.stringify(value),
      stateUpdates: undefined,
    })
  })

  it("treats { state } (no result) as plain", () => {
    expect(unwrapToolResult({ state: { foo: 1 } })).toEqual({
      content: JSON.stringify({ state: { foo: 1 } }),
      stateUpdates: undefined,
    })
  })

  it("treats { result: undefined } as plain (missing result)", () => {
    // Hard to express `{ result: undefined }` since hasOwnProperty('result') is true,
    // but value is undefined — semantically the wrapper requires a defined result.
    // We treat this as the wrapper with undefined content, which JSON.stringify
    // returns undefined for, yielding "undefined" string — UNDESIRABLE. So filter.
    const value: unknown = { result: undefined }
    const out = unwrapToolResult(value)
    // We want this to fall back to plain — JSON.stringify({ result: undefined }) is "{}"
    expect(out).toEqual({
      content: JSON.stringify({ result: undefined }),
      stateUpdates: undefined,
    })
  })

  it("treats { result, state: undefined } as plain (key order doesn't matter for the strict-keys check)", () => {
    // result is defined, state key exists but is undefined. Strict-keys says
    // exactly {result} or {result, state}. The presence of the state key
    // (even = undefined) satisfies the shape, so we treat this as wrapped
    // with stateUpdates = undefined → no mutation. This is fine — caller
    // would skip the Command anyway.
    const value = { result: "ok", state: undefined }
    expect(unwrapToolResult(value)).toEqual({
      content: "ok",
      stateUpdates: undefined,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify RED**

```bash
pnpm install
pnpm --filter @dawn-ai/sdk build
pnpm --filter @dawn-ai/core build
pnpm --filter @dawn-ai/langchain test -- unwrap-tool-result.test
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `packages/langchain/src/unwrap-tool-result.ts`:

```ts
/**
 * Result of unwrapping a tool's return value.
 *
 * - `content` is the string that becomes the ToolMessage content the agent sees.
 *   Built rules:
 *     • If the tool returned a wrapped `{result}` shape and `result` is a string,
 *       `content` is that string verbatim (no JSON quoting).
 *     • If `result` is any other value, `content` is `JSON.stringify(result)`.
 *     • If the tool returned a plain value (no wrapper), `content` is
 *       `JSON.stringify(value)`.
 *
 * - `stateUpdates` is the partial state-channel update object to apply, or
 *   undefined if the tool didn't request any state mutation.
 */
export interface UnwrappedToolResult {
  readonly content: string
  readonly stateUpdates: Record<string, unknown> | undefined
}

/**
 * Detect whether a tool's return value uses the Dawn wrapper shape
 * `{result, state?}` and split it into the agent-facing `content` and the
 * optional `stateUpdates` for the route's state channels.
 *
 * The wrapper shape is recognized strictly: the value must be a non-null
 * plain object whose own enumerable keys are exactly `result`, or exactly
 * `result` and `state`. Any other shape (including objects with extra keys,
 * missing `result`, or arrays) falls through to plain-return handling.
 *
 * Plain returns: the entire value is JSON-stringified into `content` and
 * `stateUpdates` is undefined.
 */
export function unwrapToolResult(value: unknown): UnwrappedToolResult {
  if (!isWrapperShape(value)) {
    return { content: JSON.stringify(value), stateUpdates: undefined }
  }
  const { result, state } = value
  const content = typeof result === "string" ? result : JSON.stringify(result)
  return { content, stateUpdates: state }
}

function isWrapperShape(
  value: unknown,
): value is { result: unknown; state?: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  if (keys.length === 1) return keys[0] === "result"
  if (keys.length === 2) return keys.includes("result") && keys.includes("state")
  return false
}
```

- [ ] **Step 4: Run tests to verify GREEN**

```bash
pnpm --filter @dawn-ai/langchain test -- unwrap-tool-result.test
```

Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/unwrap-tool-result.ts packages/langchain/test/unwrap-tool-result.test.ts
git commit -m "feat(langchain): unwrapToolResult helper for {result, state} return shape"
```

---

## Task 2: Re-export `unwrapToolResult` from `@dawn-ai/langchain`

**Files:**
- Modify: `packages/langchain/src/index.ts`

- [ ] **Step 1: Find the export block**

```bash
cat packages/langchain/src/index.ts
```

- [ ] **Step 2: Append the export**

Add (preserve all existing exports):

```ts
export type { UnwrappedToolResult } from "./unwrap-tool-result.js"
export { unwrapToolResult } from "./unwrap-tool-result.js"
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @dawn-ai/langchain typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add packages/langchain/src/index.ts
git commit -m "feat(langchain): re-export unwrapToolResult"
```

---

## Task 3: Wire `unwrapToolResult` into `tool-converter.ts`

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Modify: `packages/langchain/test/tool-converter.test.ts`

- [ ] **Step 1: Read the current `convertToolToLangChain` to see its exact shape**

```bash
cat packages/langchain/src/tool-converter.ts
```

The inner `func` currently is:

```ts
func: async (input, _runManager, config) => {
  const signal = config?.signal ?? new AbortController().signal
  const result = await tool.run(input, {
    ...(middlewareContext ? { middleware: middlewareContext } : {}),
    signal,
  })
  return JSON.stringify(result)
}
```

- [ ] **Step 2: Write the failing test first**

In `packages/langchain/test/tool-converter.test.ts`, append (don't replace) the new test. Read the existing test file first to understand the existing fixtures and patterns:

```bash
cat packages/langchain/test/tool-converter.test.ts | head -50
```

Then append (adapt to the actual existing testing patterns/imports):

```ts
import { Command, isCommand } from "@langchain/langgraph"

describe("convertToolToLangChain — wrapped {result, state} return", () => {
  it("returns a string ToolMessage content for a plain return (unchanged behavior)", async () => {
    const tool = {
      name: "echo",
      description: "Echo input.",
      run: async (input: unknown) => input,
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      { msg: "hi" },
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(typeof result).toBe("string")
    expect(result).toBe(JSON.stringify({ msg: "hi" }))
  })

  it("returns a Command when the tool returns {result, state}", async () => {
    const tool = {
      name: "writeFoo",
      description: "Write foo to state.",
      run: async () => ({ result: { ok: true }, state: { foo: 42 } }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(isCommand(result)).toBe(true)
    const cmd = result as InstanceType<typeof Command>
    expect(cmd.update).toEqual({ foo: 42 })
  })

  it("returns a Command whose tool message content is the verbatim string when result is a string", async () => {
    const tool = {
      name: "writeNote",
      description: "Write note + state",
      run: async () => ({ result: "noted", state: { note: "noted" } }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(isCommand(result)).toBe(true)
    const cmd = result as InstanceType<typeof Command>
    // The tool message is part of cmd.update or cmd.messages depending on
    // how LangGraph 1.x exposes it; assert structurally.
    const cmdAny = cmd as unknown as Record<string, unknown>
    // Either cmd.update has a `messages` field or cmd has a top-level messages array
    const messages =
      (cmdAny.update as Record<string, unknown> | undefined)?.messages ??
      (cmdAny.messages as unknown[] | undefined)
    expect(Array.isArray(messages)).toBe(true)
    expect((messages as unknown[]).length).toBeGreaterThanOrEqual(1)
    const msg = (messages as Array<{ content?: unknown }>)[0]
    expect(msg?.content).toBe("noted")
  })

  it("returns string content (not Command) when tool returns { result } only (no state)", async () => {
    const tool = {
      name: "noState",
      description: "...",
      run: async () => ({ result: "ok" }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(typeof result).toBe("string")
    expect(result).toBe("ok")
  })
})
```

Run tests to verify RED:

```bash
pnpm --filter @dawn-ai/langchain test -- tool-converter.test
```

Expected: the 4 new tests FAIL (because the converter still always returns a string). Existing tests should still pass.

- [ ] **Step 3: Update `convertToolToLangChain`**

Edit `packages/langchain/src/tool-converter.ts`. Add the import at the top (after the existing imports):

```ts
import { Command } from "@langchain/langgraph"
import { ToolMessage } from "@langchain/core/messages"
import { unwrapToolResult } from "./unwrap-tool-result.js"
```

Replace the inner `func` body:

```ts
func: async (input, _runManager, config) => {
  const signal = config?.signal ?? new AbortController().signal
  const rawResult = await tool.run(input, {
    ...(middlewareContext ? { middleware: middlewareContext } : {}),
    signal,
  })
  const { content, stateUpdates } = unwrapToolResult(rawResult)

  if (stateUpdates) {
    const toolCallId =
      (config as { toolCall?: { id?: string } } | undefined)?.toolCall?.id ?? ""
    return new Command({
      update: {
        ...stateUpdates,
        messages: [
          new ToolMessage({
            content,
            tool_call_id: toolCallId,
            name: tool.name,
          }),
        ],
      },
    })
  }

  return content
},
```

Note: `Command`'s `update` field accepts a state-update record AND optionally a `messages` array. The `ToolMessage` we construct manually replaces the one that LangGraph's tool wrapper would have auto-built — without it, the agent never sees the tool's result. If the `toolCall.id` lookup turns out to be wrong for `@langchain/langgraph@1.3.0`, check the actual `config` shape at runtime (the existing helper from `streamFromRunnable` in `agent-adapter.ts` may already extract it elsewhere) and adapt.

- [ ] **Step 4: Run all langchain tests**

```bash
pnpm --filter @dawn-ai/langchain test
```

Expected: all pass — existing 42 + 4 new tool-converter tests + 13 new unwrap-tool-result tests = 59. Adjust the assertion if a test landed differently.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat(langchain): wire unwrapToolResult into tool-converter; emit Command for state writes"
```

---

## Task 4: Migrate planning's `write_todos` to the new shape

**Files:**
- Modify: `packages/core/src/capabilities/built-in/planning.ts`

- [ ] **Step 1: Apply the one-line change**

In `packages/core/src/capabilities/built-in/planning.ts`, find the `writeTodos.run` body:

```ts
run: (input: unknown) => {
  // The actual state mutation happens in the langchain runtime;
  // this run() just echoes the canonicalized input back so the
  // tool result event carries the new todos.
  const validated = validateWriteTodosInput(input)
  return { todos: validated }
}
```

Replace with:

```ts
run: (input: unknown) => {
  const validated = validateWriteTodosInput(input)
  return {
    result: { todos: validated },
    state: { todos: validated },
  }
}
```

The old comment about "the actual state mutation happens in the langchain runtime" was aspirational; remove it (the new shape makes the contract explicit).

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @dawn-ai/core typecheck
```

Expected: passes.

- [ ] **Step 3: Run existing core tests**

```bash
pnpm --filter @dawn-ai/core test -- planning.test
```

The existing `planning.test.ts` tests check the marker's contribution shape AND the tool's run() behavior. The relevant test is "stream transformer ignores tool results from other tools" and similar — but there's also a test that calls `writeTodos.run(input)` directly. With the new shape, the return value changes from `{ todos: [...] }` to `{ result: { todos: [...] }, state: { todos: [...] } }`.

Locate any test that asserts the run() return shape and update it:

```bash
grep -n "writeTodos\|write_todos.*run\|todos:.*\[" packages/core/test/capabilities/planning.test.ts | head -20
```

If a test asserts `expect(...).toEqual({ todos: [...] })` after calling `writeTodos.run(...)`, update it to:

```ts
expect(...).toEqual({
  result: { todos: [...] },
  state:  { todos: [...] },
})
```

Run again to confirm GREEN.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/capabilities/built-in/planning.ts packages/core/test/capabilities/planning.test.ts
git commit -m "feat(core): planning write_todos returns {result, state} to mutate the todos channel"
```

---

## Task 5: Strengthen the planning end-to-end test (state actually changes)

**Files:**
- Modify: `packages/langchain/test/planning.test.ts`

The existing `planning.test.ts` in `@dawn-ai/langchain` tests the marker's contribution shape but does not assert that the `todos` state channel actually reflects writes. Add a test that does, exercising the tool-converter end-to-end.

- [ ] **Step 1: Read the existing test**

```bash
cat packages/langchain/test/planning.test.ts
```

- [ ] **Step 2: Append a state-channel test**

Add this test inside the existing `describe` block (or in a new sibling describe):

```ts
import { Command, isCommand } from "@langchain/langgraph"
import { convertToolToLangChain } from "../src/tool-converter.js"

describe("planning capability — state mutation", () => {
  it("write_todos tool returns a Command that updates the todos channel", async () => {
    // Set up a temp route dir with plan.md present
    const routeDir = mkdtempSync(join(tmpdir(), "dawn-planning-state-"))
    writeFileSync(join(routeDir, "plan.md"), "")

    try {
      const registry = createCapabilityRegistry([createPlanningMarker()])
      const result = await applyCapabilities(registry, routeDir)
      const writeTodos = result.contributions[0]?.contribution.tools?.[0]
      expect(writeTodos?.name).toBe("write_todos")

      const newTodos = [
        { content: "first task", status: "in_progress" as const },
        { content: "second task", status: "pending" as const },
      ]

      // Wrap the tool through the langchain converter to exercise the
      // Command path end-to-end.
      const converted = convertToolToLangChain(writeTodos!)
      const langchainResult = await converted.func(
        { todos: newTodos },
        undefined as unknown as never,
        { signal: new AbortController().signal } as unknown as never,
      )

      expect(isCommand(langchainResult)).toBe(true)
      const cmd = langchainResult as InstanceType<typeof Command>
      const updateAny = cmd.update as Record<string, unknown>
      expect(updateAny.todos).toEqual(newTodos)
    } finally {
      rmSync(routeDir, { recursive: true, force: true })
    }
  })
})
```

You may need to add imports at the top of the file:

```ts
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
```

(If some imports are already there, skip the duplicates.)

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dawn-ai/langchain test -- planning.test
```

Expected: existing tests pass + 1 new state-mutation test passes.

- [ ] **Step 4: Commit**

```bash
git add packages/langchain/test/planning.test.ts
git commit -m "test(langchain): planning write_todos produces Command with todos channel update"
```

---

## Task 6: Full workspace verification (controller-side)

- [ ] **Step 1:** `pnpm install`
- [ ] **Step 2:** `pnpm build` — expect 11/11 green
- [ ] **Step 3:** `pnpm typecheck` — expect 12/12 green
- [ ] **Step 4:** `pnpm test` — expect previous count + ~18 new tests, all green
- [ ] **Step 5:** `pnpm lint` — auto-fix with biome if anything trips, recommit as `style:`
- [ ] **Step 6:** `pnpm pack:check` — expect passes
- [ ] **Step 7 (manual smoke if API key available):** start the chat-server dev with `OPENAI_API_KEY`, issue a prompt that triggers planning. Observe the agent calls `write_todos` and does NOT loop. Capture the relevant SSE events for the PR description.

---

## Task 7: Changeset

**Files:**
- Create: `.changeset/phase3-tool-state-mutation.md`

```markdown
---
"@dawn-ai/core": minor
"@dawn-ai/langchain": minor
---

Capability tools can now mutate state channels via a Dawn-native `{result, state}` wrapped return shape — `result` becomes the agent-visible ToolMessage; `state` is a partial channel update applied via reducers. The langchain bridge translates this into a LangGraph `Command({update})` internally; capability authors don't import from `@langchain/langgraph`. Plain tool returns (anything not matching the strict wrapper shape) work unchanged.

Planning's `write_todos` adopts the new shape, fixing the previously-documented re-emission loop: the `todos` state channel now actually reflects the agent's writes between turns, so the agent stops re-calling `write_todos` with the same content.
```

```bash
git add .changeset/phase3-tool-state-mutation.md
git commit -m "chore: changeset for phase-3 tool state mutation"
```

---

## Task 8: Push + PR (controller-side)

```bash
git push -u origin claude/tool-state
gh pr create --title "feat(core,langchain): phase 3 — capability tool state mutation + planning fix" --body <<<...
gh pr merge <N> --squash --delete-branch --auto
```

Wait for CI green. Auto-merge fires once `validate` passes (review gate is off per the earlier branch-protection change).

After merge: clean up worktree.
