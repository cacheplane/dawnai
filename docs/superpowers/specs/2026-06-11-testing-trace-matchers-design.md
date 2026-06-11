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
- **`tool_result` chunk shape** (`packages/cli/src/lib/runtime/stream-types.ts:4`): `{ readonly type: "tool_result"; readonly name: string; readonly output: unknown }`, emitted at `execute-route.ts:301` (`yield { type: "tool_result", name: tr.name, output: tr.output }`). The `output` is a **serialized LangChain `ToolMessage`**: `{ lc, type, id: [..., "ToolMessage"], kwargs: { status?: "error" | "success"; content: unknown; name?: string } }`. **Observed live:** a successful `runBash` `tool_result` had `kwargs.status: "success"`. **Verify-first dependency:** that a *thrown* tool error (e.g. `readFile`/`readDoc` ENOENT) surfaces in the `tool_result` chunk as `kwargs.status: "error"` was confirmed at the LangSmith layer (the tool run errored) but **must be confirmed at the harness `tool_result` chunk level as the very first implementation step** — the whole `isError`/`expectNoToolErrors` design hinges on this signal. If a thrown tool error instead arrives as `status: "success"` with error-prefixed `content` (or via a separate `error`/event channel), adjust `isError` accordingly (fall back to a documented `content` heuristic) before building the matcher.
- **Interrupts are captured separately** (`interrupt` chunk → `run.interrupts`), so a permission-gated tool that pauses produces an `InterruptInfo`, **not** a `tool_result` — i.e. `expectNoToolErrors` reading `toolResults` will naturally exclude HITL interrupts.
- **Replay executes tools for real** (only the model is mocked). So an offline fixture that drives a tool call to a failing path (e.g. `readDoc` on a missing file) yields a *real* error `tool_result` — enabling a deterministic, offline unit test of `expectNoToolErrors`.

## Architecture

Three units, each small and independently testable.

### 1. Capture tool results in `collectRunResult`

New type in `run-result.ts`:

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
```

Add `readonly toolResults: ReadonlyArray<ObservedToolResult>` to `AgentRunResult`. In `collectRunResult`, add:

```ts
case "tool_result": {
  const c = chunk as unknown as { name: string; output?: unknown }
  const out = c.output as { kwargs?: { status?: unknown; content?: unknown } } | undefined
  const status =
    out?.kwargs?.status === "error" || out?.kwargs?.status === "success"
      ? out.kwargs.status
      : undefined
  const content = out?.kwargs?.content
  toolResults.push({ name: c.name, content, isError: status === "error", ...(status ? { status } : {}) })
  break
}
```

(push into a `const toolResults: ObservedToolResult[] = []` declared alongside `toolCalls`, and return it.)

**Error classification = `status === "error"` only.** Tools that *catch* their own failure and return an error *string* with `status: "success"` are intentionally NOT flagged — the tool chose to handle it (the model still sees the text). The matcher targets *thrown/unhandled* tool errors (the `ENOENT` class), which LangGraph's tool node marks `status: "error"`. The raw `content` is retained on `ObservedToolResult` so consumers can write stricter custom checks if they want.

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

`harness.run({ live? })` → `collectRunResult(stream)` now also folds `tool_result` chunks → `run.toolResults`. `expectToolSequence` reads `run.toolCalls`; `expectNoToolErrors` reads `run.toolResults`. No network, no LangSmith. Identical in replay and live.

## Testing

All offline/deterministic (replay; tools execute for real):

1. **`toolResults` capture** — a fixture that calls a tool returning success → `run.toolResults` has one entry, `isError: false`. (Use an existing probe app / the testing package's e2e harness.)
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

1. Add `ObservedToolResult` + `toolResults` field + `tool_result` capture in `run-result.ts` (test: capture).
2. `expectToolSequence` matcher + export (tests: subsequence pass/fail, strict).
3. `expectNoToolErrors` matcher + export (tests: real error caught, happy path, interrupt-not-error).
4. Docs entry + consumer snippet.
5. Changeset (`@dawn-ai/testing` minor — new matchers + new `AgentRunResult` field), `pnpm ci:validate`, PR.

## Out of scope (cut)

- LangSmith trace-reader / `dawn verify --trace` / `@dawn-ai/testing/langsmith` (the `assert-trace.mjs` script covers reading back arbitrary/production traces; different need).
- A fluent `expectRun(run).toHave…()` entry point (inconsistent with the existing per-aspect functions).
- Content-based error heuristics beyond `status === "error"` (raw `content` is exposed for custom checks instead).
- Asserting subagent-internal tool sequences/errors (the top-level run is the scope; `expectSubagent` already covers subagent tool presence).
