# Tool-sequence & tool-error matchers for `@dawn-ai/testing` (Design)

**Status:** Approved for planning
**Date:** 2026-06-11
**Context:** While live-smoking the research starter we hit a class of bug the existing matchers can't catch: a tool genuinely fails (e.g. `writeFile`/`readDoc` → `ENOENT`), the model recovers, and the run's final answer + root status still look *successful* — so the failure is invisible to `expectFinalMessage`/`expectToolCalled`. Separately, a HITL **permission interrupt** surfaces in LangSmith's red `error` channel identically to a real failure, which is confusing. A throwaway `assert-trace.mjs` script (reads LangSmith traces) prototyped the verification; this spec brings the *harness-driven* half into `@dawn-ai/testing` as first-class matchers — no LangSmith dependency.

## Problem & goal

`@dawn-ai/testing` exposes per-aspect matchers over `AgentRunResult` (`expectToolCalled`, `expectFinalMessage`, `expectInterrupt`, `expectOffloaded`, `expectSubagent`, `expectPlan`, …). Two useful assertions are missing:

1. **Tool *order*.** `expectToolCalled(run, "x")` checks presence, not sequence. Research/agentic flows have a meaningful arc (`searchCorpus → readDoc → writeFile`); there's no way to assert it.
2. **Real tool *errors*.** Nothing detects that a tool returned an error result. This is the highest-value gap: it catches the `ENOENT`-class bug even when the run "succeeds," and it must **not** flag a HITL permission interrupt (which is a pause, not a failure).

**Goal:** add `expectToolSequence(run, names, opts?)` and `expectNoToolErrors(run)` in the existing standalone-function style, backed by a new `toolResults` field on `AgentRunResult`. Works in both replay and live mode (same run object). Zero new dependencies.

**Non-goals:** the LangSmith trace-reader / `dawn verify --trace` (the `assert-trace.mjs` script remains the tool for reading back *arbitrary*/production traces — different need, separate effort). No CLI command. No changes to the scaffold templates.

## Verified facts (against current code)

- **Matcher style** (`packages/testing/src/matchers.ts`): standalone `export function expect…(run: AgentRunResult, …)`; failures call a local `fail(msg)` that throws. Exported from `packages/testing/src/index.ts`. New matchers follow this exact shape (no new `expectRun` entry point).
- **`AgentRunResult`** (`packages/testing/src/run-result.ts:38`): has `toolCalls: ReadonlyArray<ObservedToolCall>` (`{ name; args; id? }`), `interrupts: ReadonlyArray<InterruptInfo>`, `messages`, `finalMessage`, `subagents`, etc. **`toolCalls` is populated in call order** from `tool_call` stream chunks (`collectRunResult` line 146-154). **There is no capture of tool *results*** today.
- **`collectRunResult`** (`run-result.ts:100`) consumes a `StreamChunk` async-iterable with a `switch (chunk.type)` handling `chunk`/`tool_call`/`done`/`interrupt`/`plan_update`/`subagent.*`. There is **no `case "tool_result"`** — that chunk type is silently dropped today.
- **VERIFIED — error ToolMessages live in the final state, not in `tool_result` chunks.** Empirically confirmed (a live run that forced a `readDoc` on a missing path): the run emitted **4 `tool_call` chunks but only 3 `tool_result` chunks** — the *errored* `readDoc` produced **no `tool_result` chunk**. Its error surfaced **only in the final `done` chunk's `state.messages`**, as a serialized `ToolMessage` with **`kwargs.status: "error"`** and `kwargs.content` = `"...ENOENT...\n Please fix your mistakes."` (LangGraph's tool-node error handling). Successful tools DO emit `tool_result` chunks (e.g. a `runBash` success had `kwargs.status: "success"`) **and** also appear in `state.messages`. **Conclusion: `state.messages` (`run.messages`) is the complete, reliable source for tool results — capturing `tool_result` *chunks* would silently miss every thrown error.** Each serialized `ToolMessage` is `{ lc, type, id: [..., "ToolMessage"], kwargs: { status?: "error" | "success"; content: unknown; name?: string; tool_call_id?: string } }`.
- **`run.messages` is already populated** by `collectRunResult` (`messages: Array.isArray(state.messages) ? state.messages : []`, line 242). So **no streaming-capture change is required** — `toolResults` can be *derived* from `run.messages`.
- **Interrupts are captured separately** (`interrupt` chunk → `run.interrupts`), and a permission-gated tool that pauses produces **no `ToolMessage` at all** (it never executed) — so deriving errors from `ToolMessage` status naturally excludes HITL interrupts.
- **Replay executes tools for real** (only the model is mocked). So an offline fixture that drives a tool call to a failing path (e.g. `readDoc` on a missing file) yields a *real* error `tool_result` — enabling a deterministic, offline unit test of `expectNoToolErrors`.

## Architecture

Three units, each small and independently testable.

### 1. Derive tool results from `run.messages`

New type + pure helper in `run-result.ts` (NO streaming-capture change — `tool_result` chunks are incomplete; derive from the final messages instead):

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

Add `readonly toolResults: ReadonlyArray<ObservedToolResult>` to `AgentRunResult`, and in `collectRunResult`'s return object set `toolResults: deriveToolResults(messages)` (reusing the same `messages` array already computed for the `messages` field). No new `switch` case.

**Error classification = `status === "error"` only.** Tools that *catch* their own failure and return an error *string* with `status: "success"` are intentionally NOT flagged — the tool chose to handle it (the model still sees the text). The matcher targets *thrown/unhandled* tool errors (the `ENOENT` class), which LangGraph's tool node marks `status: "error"` (verified). The raw `content` is retained on `ObservedToolResult` so consumers can write stricter custom checks if they want.

### 2. `expectToolSequence(run, names, opts?)`

```ts
export function expectToolSequence(
  run: AgentRunResult,
  names: readonly string[],
  opts?: { readonly strict?: boolean },
): void
```

- Reads `run.toolCalls.map((c) => c.name)`.
- **Default (subsequence):** the `names` must appear in order, with other tool calls allowed between them (agentic flows interleave `writeTodos`/`readSkill`/`task`). Walk a pointer through the actual names; advance on each match; pass iff the pointer reaches the end.
- **`strict: true` (contiguous):** the actual names must contain `names` as a contiguous run, in order.
- **Failure message:** `expected tool sequence a → b → c; got <actual joined by " → "> (missing: <unmatched>)`.

### 3. `expectNoToolErrors(run)`

```ts
export function expectNoToolErrors(run: AgentRunResult): void
```

- Reads `run.toolResults.filter((r) => r.isError)`.
- Passes when empty. Fails listing each errored tool and the first line of its `content`:
  `expected no tool errors; "<name>" returned an error: <first line of content, ≤140 chars>`.
- HITL permission interrupts are in `run.interrupts`, not `run.toolResults`, so they are not flagged. (No special-casing needed.)

Export both from `packages/testing/src/index.ts` next to the other matchers.

## Data flow

`harness.run({ live? })` → `collectRunResult(stream)` builds `state` from the `done` chunk, then `run.toolResults = deriveToolResults(run.messages)`. `expectToolSequence` reads `run.toolCalls` (captured from `tool_call` chunks, in order); `expectNoToolErrors` reads `run.toolResults` (derived from the final `ToolMessage`s). No network, no LangSmith. Identical in replay and live.

## Testing

All offline/deterministic (replay; tools execute for real):

1. **`deriveToolResults` / `toolResults`** — unit-test `deriveToolResults` directly with a hand-built messages array (a success `ToolMessage` and an `status:"error"` `ToolMessage`) → correct `isError` flags + names; and a fixture-driven run where a tool succeeds → `run.toolResults` has the entry with `isError: false`.
2. **`expectNoToolErrors` catches a real error** — a fixture driving a tool call to a failing path (e.g. a workspace `readFile`/`readDoc` on a missing file) → `run.toolResults` has `isError: true`; `expectNoToolErrors(run)` throws with the tool name + ENOENT message; the happy path does not throw.
3. **`expectToolSequence`** — pure-ish: build an `AgentRunResult` (or drive a fixture) with tool calls `[a, x, b, c]`; assert subsequence `[a, b, c]` passes, `[b, a]` fails, and `strict: true` on a non-contiguous set fails. Failure messages match the spec strings.
4. **HITL interrupt is not a tool error** — reuse the permission-gated `runBash` scenario: the run has an `interrupt` and an empty/error-free `toolResults`; `expectNoToolErrors(run)` passes. (This is the regression guard for the core "interrupt ≠ error" distinction.)

Follow the testing package's existing e2e/probe-app patterns; do not add a live (`OPENAI_API_KEY`-gated) test or touch the scaffold templates.

## Docs

Add the two matchers to the testing package's matcher reference/docs (wherever `expectToolCalled`/`expectOffloaded` are documented), with the consumer snippet:

```ts
const run = await h.run({ input: "…", live: true })
expectToolSequence(run, ["searchCorpus", "readDoc", "writeFile"])
expectNoToolErrors(run)
```

## Tasks (single plan, ordered)

1. Add `ObservedToolResult` + `deriveToolResults(messages)` helper + `toolResults` field (derived from `run.messages`) in `run-result.ts` (test: `deriveToolResults` unit + fixture-run capture).
2. `expectToolSequence` matcher + export (tests: subsequence pass/fail, strict).
3. `expectNoToolErrors` matcher + export (tests: real error caught, happy path, interrupt-not-error).
4. Docs entry + consumer snippet.
5. Changeset (`@dawn-ai/testing` minor — new matchers + new `AgentRunResult` field), `pnpm ci:validate`, PR.

## Out of scope (cut)

- LangSmith trace-reader / `dawn verify --trace` / `@dawn-ai/testing/langsmith` (the `assert-trace.mjs` script covers reading back arbitrary/production traces; different need).
- A fluent `expectRun(run).toHave…()` entry point (inconsistent with the existing per-aspect functions).
- Content-based error heuristics beyond `status === "error"` (raw `content` is exposed for custom checks instead).
- Asserting subagent-internal tool sequences/errors (the top-level run is the scope; `expectSubagent` already covers subagent tool presence).
