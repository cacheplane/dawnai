# Tool-sequence & tool-error matchers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `expectToolSequence` and `expectNoToolErrors` matchers to `@dawn-ai/testing`, backed by a `toolResults` field derived from the run's final messages, so tests can assert tool *order* and catch *real* tool errors (distinct from HITL interrupts).

**Architecture:** Pure additions to the existing testing package. `collectRunResult` gains a derived `toolResults` field (computed from `run.messages` — NOT from streaming `tool_result` chunks, which verifiably drop thrown errors). Two new standalone matcher functions in the existing `expect…(run, …)` style read `run.toolCalls` (order) and `run.toolResults` (errors). No new dependencies; works in replay and live identically.

**Tech Stack:** TypeScript, vitest, `@dawn-ai/testing`.

**Spec:** `docs/superpowers/specs/2026-06-11-testing-trace-matchers-design.md`

**Verified contract (do not re-derive):** A thrown tool error (e.g. `readDoc` ENOENT) appears in the final `done` chunk's `state.messages` as a serialized `ToolMessage` `{ id: [..., "ToolMessage"], kwargs: { name, status: "error", content: "...ENOENT...\n Please fix your mistakes." } }`. It does **not** emit a `tool_result` chunk. Successful tools may have `kwargs.status: "success"` or **no `status` field** (e.g. `writeTodos`). HITL permission interrupts produce **no** `ToolMessage` (the tool never ran). Therefore tool results/errors must be read from `run.messages`, and `isError` ⇔ `kwargs.status === "error"`.

**Working directory:** the implementing worktree is on branch `feat/testing-trace-matchers` (already created off `origin/main`; the spec is committed there).

---

## File Structure

- `packages/testing/src/run-result.ts` — add `ObservedToolResult` interface, `deriveToolResults(messages)` helper, `toolResults` field on `AgentRunResult`, and set it in `collectRunResult`'s return.
- `packages/testing/src/matchers.ts` — add `expectToolSequence` + `expectNoToolErrors` (+ two small private sequence helpers).
- `packages/testing/src/index.ts` — re-export the two matchers + `ObservedToolResult` type + `deriveToolResults`.
- `packages/testing/test/run-result.test.ts` — unit-test `deriveToolResults`.
- `packages/testing/test/matchers.test.ts` — add `toolResults: []` to the shared `base`; add matcher tests.
- Docs page where matchers are listed — add the two new matchers.
- `.changeset/testing-trace-matchers.md` — `@dawn-ai/testing` minor.

---

## Task 1: `toolResults` derived from messages

**Files:**
- Modify: `packages/testing/src/run-result.ts`
- Test: `packages/testing/test/run-result.test.ts`
- Modify (type fix): `packages/testing/test/matchers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/testing/test/run-result.test.ts` (add `deriveToolResults` to the existing import from `../src/run-result.js`, or add a new import line):

```ts
import { deriveToolResults } from "../src/run-result.js"

describe("deriveToolResults", () => {
  it("extracts tool results from serialized ToolMessages and flags errors", () => {
    const messages = [
      { id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "hi" } },
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: { name: "searchCorpus", status: "success", content: "[...]" },
      },
      // successful Command-style tool with NO status field:
      { id: ["langchain_core", "messages", "ToolMessage"], kwargs: { name: "writeTodos", content: "{}" } },
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: { name: "readDoc", status: "error", content: "Error: ENOENT no such file\n Please fix your mistakes." },
      },
    ]
    const results = deriveToolResults(messages)
    expect(results.map((r) => r.name)).toEqual(["searchCorpus", "writeTodos", "readDoc"])
    expect(results.map((r) => r.isError)).toEqual([false, false, true])
    expect(results[0].status).toBe("success")
    expect(results[1].status).toBeUndefined()
  })
})
```

(If `describe`/`it`/`expect` aren't already imported in this file, import them from `"vitest"`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/run-result.test.ts`
Expected: FAIL — `deriveToolResults` is not exported.

- [ ] **Step 3: Implement `deriveToolResults` + `toolResults`**

In `packages/testing/src/run-result.ts`, add the interface and helper near `ObservedToolCall` (top of file):

```ts
export interface ObservedToolResult {
  readonly name: string
  /** LangChain ToolMessage status, when present. */
  readonly status?: "error" | "success"
  /** The tool result content (string when the tool returned text/JSON). */
  readonly content: unknown
  /** True when the tool reported an error (status === "error"). */
  readonly isError: boolean
}

/** Extract tool results from final conversation messages (serialized ToolMessages). */
export function deriveToolResults(
  messages: ReadonlyArray<Record<string, unknown>>,
): ObservedToolResult[] {
  const results: ObservedToolResult[] = []
  for (const m of messages) {
    const id = m.id as unknown
    const isToolMessage = Array.isArray(id) && id[id.length - 1] === "ToolMessage"
    if (!isToolMessage) continue
    const kwargs = (m.kwargs ?? {}) as { name?: unknown; status?: unknown; content?: unknown }
    const status =
      kwargs.status === "error" || kwargs.status === "success" ? kwargs.status : undefined
    results.push({
      name: typeof kwargs.name === "string" ? kwargs.name : "",
      content: kwargs.content,
      isError: status === "error",
      ...(status ? { status } : {}),
    })
  }
  return results
}
```

Add the field to the `AgentRunResult` interface (after `toolCalls`):

```ts
  readonly toolResults: ReadonlyArray<ObservedToolResult>
```

In `collectRunResult`'s `return { … }` object, the `messages` array is already computed inline. Pull it into a local and reuse it for `toolResults`. Replace:

```ts
  return {
    threadId,
    tokens,
    toolCalls,
    state,
    messages: Array.isArray(state.messages) ? (state.messages as Record<string, unknown>[]) : [],
    finalMessage: finalMessageFrom(state),
    …
```

with:

```ts
  const finalMessages = Array.isArray(state.messages)
    ? (state.messages as Record<string, unknown>[])
    : []
  return {
    threadId,
    tokens,
    toolCalls,
    toolResults: deriveToolResults(finalMessages),
    state,
    messages: finalMessages,
    finalMessage: finalMessageFrom(state),
    …
```

(Keep every other field in the return unchanged.)

- [ ] **Step 4: Fix the type error in `matchers.test.ts`**

The shared `const base: AgentRunResult` in `packages/testing/test/matchers.test.ts` will now miss `toolResults` and fail to typecheck. Add this line to the `base` object (after the `toolCalls:` line):

```ts
  toolResults: [],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/run-result.test.ts test/matchers.test.ts`
Expected: PASS (the new `deriveToolResults` test + all existing tests).

- [ ] **Step 6: Commit**

```bash
git add packages/testing/src/run-result.ts packages/testing/test/run-result.test.ts packages/testing/test/matchers.test.ts
git commit -m "feat(testing): derive toolResults from run messages"
```

---

## Task 2: `expectToolSequence` matcher

**Files:**
- Modify: `packages/testing/src/matchers.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/matchers.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/testing/test/matchers.test.ts`, add `expectToolSequence` to the import from `../src/matchers.js`, then add:

```ts
it("expectToolSequence passes for an in-order subsequence", () => {
  const run = {
    ...base,
    toolCalls: [
      { name: "a", args: {} },
      { name: "x", args: {} },
      { name: "b", args: {} },
      { name: "c", args: {} },
    ],
  }
  expectToolSequence(run, ["a", "b", "c"])
})

it("expectToolSequence throws for out-of-order tools", () => {
  const run = { ...base, toolCalls: [{ name: "b", args: {} }, { name: "a", args: {} }] }
  expect(() => expectToolSequence(run, ["a", "b"])).toThrow(/expected tool sequence/)
})

it("expectToolSequence strict requires contiguity", () => {
  const run = {
    ...base,
    toolCalls: [{ name: "a", args: {} }, { name: "x", args: {} }, { name: "b", args: {} }],
  }
  expect(() => expectToolSequence(run, ["a", "b"], { strict: true })).toThrow()
  expectToolSequence(run, ["a", "x", "b"], { strict: true })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/matchers.test.ts`
Expected: FAIL — `expectToolSequence` is not exported.

- [ ] **Step 3: Implement the matcher**

In `packages/testing/src/matchers.ts`, add two private helpers (near the top, after `isSubset`) and the exported matcher (alongside the other `expect…` functions):

```ts
function isSubsequence(actual: readonly string[], wanted: readonly string[]): boolean {
  let i = 0
  for (const a of actual) if (i < wanted.length && a === wanted[i]) i++
  return i === wanted.length
}

function containsContiguous(actual: readonly string[], wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true
  for (let s = 0; s + wanted.length <= actual.length; s++) {
    let ok = true
    for (let j = 0; j < wanted.length; j++) {
      if (actual[s + j] !== wanted[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/**
 * Assert the named tools were called IN ORDER. By default a subsequence (other
 * tool calls may appear between them); `{ strict: true }` requires them to be
 * contiguous.
 */
export function expectToolSequence(
  run: AgentRunResult,
  names: readonly string[],
  opts?: { readonly strict?: boolean },
): void {
  const actual = run.toolCalls.map((c) => c.name)
  const ok = opts?.strict ? containsContiguous(actual, names) : isSubsequence(actual, names)
  if (!ok) {
    const missing = names.filter((n) => !actual.includes(n))
    fail(
      `expected tool sequence ${names.join(" → ")}${opts?.strict ? " (contiguous)" : ""}; ` +
        `got ${actual.join(" → ") || "(none)"}` +
        (missing.length ? ` (missing: ${missing.join(", ")})` : ""),
    )
  }
}
```

- [ ] **Step 4: Export it**

In `packages/testing/src/index.ts`, add `expectToolSequence` to the alphabetical matcher re-export list (it currently lists `…, expectSystemPrompt, expectToolCalled`):

```ts
  expectToolCalled,
  expectToolSequence,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/matchers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/testing/src/matchers.ts packages/testing/src/index.ts packages/testing/test/matchers.test.ts
git commit -m "feat(testing): add expectToolSequence matcher"
```

---

## Task 3: `expectNoToolErrors` matcher

**Files:**
- Modify: `packages/testing/src/matchers.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/matchers.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/testing/test/matchers.test.ts`, add `expectNoToolErrors` to the import from `../src/matchers.js`, then add:

```ts
it("expectNoToolErrors passes when no tool errored", () => {
  const run = {
    ...base,
    toolResults: [{ name: "searchCorpus", status: "success" as const, content: "ok", isError: false }],
  }
  expectNoToolErrors(run)
})

it("expectNoToolErrors throws and names the failed tool", () => {
  const run = {
    ...base,
    toolResults: [
      { name: "readDoc", status: "error" as const, content: "Error: ENOENT no such file\n next line", isError: true },
    ],
  }
  expect(() => expectNoToolErrors(run)).toThrow(/readDoc.*ENOENT/)
})

it("expectNoToolErrors treats a HITL interrupt as NOT a tool error", () => {
  const run = {
    ...base,
    interrupts: [{ interruptId: "p1", kind: "command", detail: { command: "x" } }],
    toolResults: [],
  }
  expectNoToolErrors(run)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/matchers.test.ts`
Expected: FAIL — `expectNoToolErrors` is not exported.

- [ ] **Step 3: Implement the matcher**

In `packages/testing/src/matchers.ts`, add:

```ts
/**
 * Assert no tool returned an error result. A HITL permission interrupt is NOT a
 * tool error — it produces no ToolMessage, so it never appears in toolResults.
 */
export function expectNoToolErrors(run: AgentRunResult): void {
  const errored = run.toolResults.filter((r) => r.isError)
  if (errored.length > 0) {
    const detail = errored
      .map((r) => {
        const first = typeof r.content === "string" ? r.content.split("\n")[0].slice(0, 140) : ""
        return `"${r.name}" returned an error: ${first}`
      })
      .join("; ")
    fail(`expected no tool errors; ${detail}`)
  }
}
```

- [ ] **Step 4: Export it**

In `packages/testing/src/index.ts`, add `expectNoToolErrors` to the matcher re-export list (next to `expectNoInterrupt`):

```ts
  expectNoInterrupt,
  expectNoToolErrors,
```

Also extend the run-result re-export (currently `export { type AgentRunResult, collectRunResult, type ObservedToolCall } from "./run-result.js"`) to include the new public surface:

```ts
export {
  type AgentRunResult,
  collectRunResult,
  deriveToolResults,
  type ObservedToolCall,
  type ObservedToolResult,
} from "./run-result.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/testing exec vitest run test/matchers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/testing/src/matchers.ts packages/testing/src/index.ts packages/testing/test/matchers.test.ts
git commit -m "feat(testing): add expectNoToolErrors matcher"
```

---

## Task 4: Docs

**Files:**
- Modify: the docs page that lists the testing matchers.

- [ ] **Step 1: Find the matcher docs**

Run: `grep -rln "expectOffloaded\|expectToolCalled" docs/ packages/testing/README.md 2>/dev/null`
Open the file(s) that list the matchers (a docs page and/or the package README).

- [ ] **Step 2: Add the two matchers**

In the matcher list/table, add entries mirroring the existing style:

```md
- `expectToolSequence(run, names, opts?)` — assert the named tools were called in order (subsequence by default; `{ strict: true }` requires contiguity).
- `expectNoToolErrors(run)` — assert no tool returned an error result. HITL permission interrupts are not counted as errors.
```

And add a short usage snippet near the other examples:

```ts
const run = await h.run({ input: "…", live: true })
expectToolSequence(run, ["searchCorpus", "readDoc", "writeFile"])
expectNoToolErrors(run)
```

If `grep` finds no matcher docs page, add a short "Trace assertions" subsection to `packages/testing/README.md` with the two bullets + snippet above.

- [ ] **Step 3: Verify the docs gate passes**

Run: `node scripts/check-docs.mjs`
Expected: `Docs completeness check passed.` (Avoid banned phrases; if it flags a missing nav entry for a new page, add the entry it asks for — but editing an existing matcher list should not require nav changes.)

- [ ] **Step 4: Commit**

```bash
git add docs/ packages/testing/README.md
git commit -m "docs(testing): document expectToolSequence + expectNoToolErrors"
```

---

## Task 5: Changeset, validate, PR

**Files:**
- Create: `.changeset/testing-trace-matchers.md`

- [ ] **Step 1: Write the changeset**

`.changeset/testing-trace-matchers.md`:

```markdown
---
"@dawn-ai/testing": minor
---

Add `expectToolSequence(run, names, opts?)` and `expectNoToolErrors(run)` matchers,
plus a derived `toolResults` field on `AgentRunResult` (and a `deriveToolResults`
helper). `expectToolSequence` asserts tool call order (subsequence by default,
`{ strict: true }` for contiguous); `expectNoToolErrors` catches tools that
returned an error result while correctly treating HITL permission interrupts as
non-errors.
```

- [ ] **Step 2: Full validate**

Run: `pnpm ci:validate`
Expected: green (build, typecheck, lint, unit tests, docs check, pack check, harness lanes). The testing package's own tests now include the new matcher + `deriveToolResults` tests.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/testing-trace-matchers
gh pr create --title "feat(testing): tool-sequence & tool-error matchers" --body "$(cat <<'EOF'
## Summary
- `expectToolSequence(run, names, opts?)` — assert tool call order (subsequence default; `{ strict: true }` contiguous).
- `expectNoToolErrors(run)` — catch real tool errors, treating HITL permission interrupts as non-errors.
- Derived `toolResults` field on `AgentRunResult` (+ `deriveToolResults`), sourced from the run's final messages — verified that thrown tool errors land in `state.messages` as `ToolMessage` `status:"error"`, NOT as `tool_result` stream chunks.

## Why
A tool can genuinely fail (e.g. `writeFile`/`readDoc` ENOENT) while the model recovers and the run's final answer + root status still look successful — invisible to the existing matchers. `expectNoToolErrors` catches that class; `expectToolSequence` asserts the agentic arc.

## Validation
- `pnpm ci:validate` green; new unit tests in `test/run-result.test.ts` + `test/matchers.test.ts` (incl. the interrupt-is-not-an-error regression).

Spec: `docs/superpowers/specs/2026-06-11-testing-trace-matchers-design.md`
Plan: `docs/superpowers/plans/2026-06-11-testing-trace-matchers.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Commit the changeset**

```bash
git add .changeset/testing-trace-matchers.md
git commit -m "chore: changeset for testing trace matchers"
git push
```

---

## Self-Review

**1. Spec coverage:**
- `deriveToolResults` from messages + `toolResults` field → Task 1. ✓
- `expectToolSequence` (subsequence + strict) → Task 2. ✓
- `expectNoToolErrors` (error detection, interrupt-not-error) → Task 3. ✓
- Exports → Tasks 2/3 (index.ts). ✓
- Docs → Task 4. ✓
- Changeset/validate/PR → Task 5. ✓
- Out-of-scope items (LangSmith reader, CLI, template changes, content heuristics, subagent-internal assertions) → none implemented. ✓
- Spec test #4 "HITL interrupt is not a tool error" → Task 3 Step 1 third test. ✓

**2. Placeholder scan:** Every code step has complete code. The only lookup is Task 4 Step 1 (find the docs page) — bounded by a concrete `grep` + a fallback (add to `packages/testing/README.md`). No TBD/TODO.

**3. Type consistency:** `ObservedToolResult { name; status?; content; isError }` is defined in Task 1 and consumed identically in Task 3's matcher + tests. `toolResults` field name consistent across run-result.ts, the `base` test fixture (Task 1 Step 4), and both matchers. `expectToolSequence(run, names, opts?)` and `expectNoToolErrors(run)` signatures match between implementation, exports, tests, and docs. The `base` fixture gets `toolResults: []` in Task 1 before Tasks 2/3 spread it with overrides. Status literals use `as const` in tests to satisfy the `"error" | "success"` union.
