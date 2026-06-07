# Eval Authoring (Design)

**Status:** Approved for planning
**Date:** 2026-06-06
**Roadmap:** Phase 4 (Richer Authoring Systems), sub-project 1 of N. Phase 4 is a basket of independent subsystems (approvals, memory, eval authoring, richer tool policies, scenario authoring, upgrade guidance); this spec covers **eval authoring** only. The rest stay queued for later cycles.

## Problem

Dawn can author, run, and test agents, but it has no way to **measure** agent quality over a dataset. Scenario tests (`run.test.ts`) and `@dawn-ai/testing` answer "does this exact run behave correctly," deterministically. They don't answer "across N representative inputs, how good is the agent — and did a prompt/model change regress it." Evals close that gap: a filesystem-discovered way to define datasets + scorers and a `dawn eval` command that runs an agent route over a dataset and reports/gates on scores.

Constraints carried from the roadmap's cross-phase rules:
- **Extend filesystem-driven discovery** (Dawn's proven strength) — evals are discovered like routes/tools/skills/scenarios, not registered opaquely.
- **Keep LangSmith as the trace layer** — do not fork it; live runs trace to LangSmith via the existing passive env hook; no custom upload/dataset-sync in v1.
- **No real-model calls in CI** — the default eval mode is deterministic replay; real-model runs are local/gated only.
- **Don't reopen the CLI/runtime boundary** — `dawn eval` is a new command reusing existing runtime exports.

## Verified facts (against current code)

- **`@dawn-ai/testing`** exports the in-process harness `createAgentHarness({ appRoot, route, fixtures?, mode?, live? })`, the `AgentRunResult` shape (`finalMessage`, `messages`, `toolCalls`, `tokens`, `state`, `threadId`, `interrupts`, `planUpdates`, `todos`, `subagents`, `subagentEvents`, `systemPrompt`), the `script()` fixture builder, `loadFixtures`/`writeFixtures`, `record()`, and the `expect*` matchers (`expectToolCalled`, `expectFinalMessage`, `expectState`, …). Evals reuse all of this.
- **CLI commands** are registered in `packages/cli/src/index.ts` via `createProgram` → `registerXCommand(program, io)`; each command module (e.g. `test.ts`'s `registerTestCommand`) defines `program.command(...).action(...)`. `dawn eval` mirrors this.
- **Scenario testing** (`run.test.ts`) is loaded by `cli/src/lib/runtime/load-run-scenarios.ts` (co-located default-export array, run by `runTestCommand`). Eval discovery mirrors this loader.
- **Programmatic runtime** `@dawn-ai/cli/runtime` exports `createRuntimeRegistry(appRoot)` (→ `lookup(routeKey)`), `streamResolvedRoute`, `executeResolvedRoute`, `resolveCheckpointer`/`resolveThreadsStore`. The harness already uses these; the eval runner runs cases through the harness rather than re-implementing execution.
- **LangSmith** tracing is passive: `cli/src/lib/dev/load-env.ts` sets `LANGCHAIN_TRACING_V2=true` when `LANGSMITH_API_KEY` is present. No custom trace emitter exists. Evals inherit this in `--live`.
- **Model wiring** honors `OPENAI_BASE_URL` (`createChatModel`), which is how the harness points the model at aimock. An `llmJudge` scorer's model call flows through the same base URL, so it is mocked in replay and real in `--live` — no special judge plumbing.

## Architecture

Two units, clear boundary:

1. **`@dawn-ai/evals`** (new author-facing package, depends on `@dawn-ai/testing`): the authoring surface + scorer/gate libraries + the pure run/aggregate logic. No CLI, no `commander`. Exhaustively unit-testable.
2. **`dawn eval` command** (in `@dawn-ai/cli`): discovery of `*.eval.ts`, the I/O shell (flags, console/JSON reporting, process exit code), and execution via `@dawn-ai/testing` + `@dawn-ai/cli/runtime`. Depends on `@dawn-ai/evals` for types and the aggregate/gate logic.

This mirrors the established pattern: `sdk`/`testing`/`permissions`/`workspace` are author packages; the CLI owns commands. Authors never import from `@dawn-ai/cli`.

### Authoring surface (`@dawn-ai/evals`)

Co-located `src/app/<route>/evals/<name>.eval.ts`, discovered like `run.test.ts`:

```ts
import { defineEval, contains, toolCalled, custom, llmJudge, gate } from "@dawn-ai/evals"
import { script } from "@dawn-ai/testing"

export default defineEval({
  name: "filter accuracy",
  route: "/chat#agent",                 // optional; defaults to the co-located route
  dataset: [                            // EvalCase[] | string (path) | () => EvalCase[] | Promise<…>
    {
      name: "open items",
      input: "Filter open items",
      expected: { status: "open" },
      fixtures: script().user("Filter open items")
        .callsTool("applyFilter", { status: "open" }).replies("Found 2 open items."),
    },
  ],
  scorers: [
    toolCalled("applyFilter", { threshold: 1 }),     // built-in code scorer (wraps matcher)
    contains("Found"),
    custom(async (run, c) => (run.toolCalls.length <= 2 ? 1 : 0)),
    llmJudge({ criteria: "The answer reflects {{expected}}", model: "gpt-4o-mini", threshold: 0.7 }),
  ],
  gate: gate.all(gate.passRate(0.9), gate.perScorer()), // or `threshold: 0.8` (= gate.mean(0.8))
})
```

**Types:**

```ts
interface EvalCase {
  readonly name?: string
  readonly input: unknown
  readonly expected?: unknown
  readonly fixtures?: FixtureSet | ScriptBuilder   // per-case replay; ignored in --live
  readonly metadata?: Record<string, unknown>
}

type Dataset =
  | EvalCase[]
  | string                                          // path to .json/.jsonl, resolved relative to the eval file
  | (() => EvalCase[] | Promise<EvalCase[]>)        // programmatic / dynamic

type Score = number /* 0..1 */ | boolean | { score: number; label?: string; reason?: string }

interface Scorer {
  readonly name: string
  readonly threshold?: number                       // this scorer's own bar (used by gate.perScorer / passRate)
  readonly score: (run: AgentRunResult, testCase: EvalCase) => Score | Promise<Score>   // param can't be named `case` (reserved)
}

interface EvalDefinition {
  readonly name: string
  readonly route?: string
  readonly dataset: Dataset
  readonly scorers: Scorer[]
  readonly threshold?: number                       // sugar for gate.mean(threshold)
  readonly gate?: GatePolicy
}

function defineEval(def: EvalDefinition): EvalDefinition   // identity + validation (throws on empty dataset/scorers)
```

**Scorer normalization:** `boolean` → `1|0`; `number` clamped to `[0,1]`; object → its `.score` (clamped), retaining `label`/`reason` for reporting. Every scorer is async-capable; the runner `await`s each.

**Built-in scorer library** (all return a `Scorer`, all accept `{ threshold? }`):
- `exactMatch(selector?)` — `run.finalMessage` (or a selector over the run) `===` `case.expected`.
- `contains(substring)` / `regex(re)` — over `run.finalMessage`.
- `jsonEquals(selector?)` — deep-equals `case.expected` (default selector: parse `finalMessage` as JSON; or `run.state`/last tool args via selector).
- `toolCalled(name, { withArgs?, times? })` — wraps `expectToolCalled` semantics → 1/0.
- `latencyUnder(ms)` / `tokensUnder(n)` — budget scorers over run timing / `run.tokens`.
- `custom(fn)` — `fn: (run, testCase) => Score | Promise<Score>`, optional `{ name?, threshold? }`.
- `llmJudge({ criteria, model?, threshold?, name? })` — renders `criteria` (with `{{input}}`/`{{expected}}`/`{{output}}` interpolation), calls the model **through the harness's model wiring** (so replay-mocked / live-real), parses a `{score, reason}` verdict. Deterministic in replay (verdict is a fixture).

**Gate library** (`gate.*`, all return a `GatePolicy = (report: EvalReport) => GateResult`):
- `gate.mean(n)` — mean of all case×scorer scores ≥ n.
- `gate.passRate(n)` — ≥ n fraction of cases *pass*; a case passes iff every scorer meets its bar (`scorer.threshold ?? DEFAULT_CASE_BAR = 0.5`).
- `gate.everyCase(n)` — every case's mean score ≥ n.
- `gate.perScorer()` — every scorer's aggregate mean ≥ its own `threshold` (scorers without a threshold are informational, skipped).
- `gate.all(...policies)` / `gate.any(...policies)` — compose.
- Custom: `gate?: (report) => boolean | { passed: boolean; reason?: string }`.
- Resolution: `gate` wins if present; else `threshold` → `gate.mean(threshold)`; else **informational** (always passes, scores still reported).

### Execution model

The runner (`runEval`, pure, in `@dawn-ai/evals`; driven by the CLI) for each eval:
1. Resolve `dataset` once (await if function; if string, the CLI reads the file relative to the eval path and passes `EvalCase[]`).
2. For each case, run the route via the in-process harness:
   - **Replay (default):** `createAgentHarness({ appRoot, route, fixtures: case.fixtures })` → `h.run({ input: case.input })`. Deterministic and CI-safe. A case with no `fixtures` in replay mode is a hard error (clear message: "case X has no fixtures; record them or run --live").
   - **`--live`:** `createAgentHarness({ appRoot, route, live: true })` → real model (gated; throws without `OPENAI_API_KEY`). `case.fixtures` ignored.
3. Run all scorers over the `AgentRunResult` (await each), normalize scores.
4. Aggregate into an `EvalReport` (per-case rows with per-scorer scores + labels/reasons; per-scorer means; overall mean). Apply the gate → `passed`/`reason`.

**`--record`:** runs `--live` and, after each case, writes the captured aimock journal back as `case.fixtures` to disk via `writeFixtures` (path derived from the eval file + case name under a sibling `__fixtures__/`), then rewrites the eval/dataset to reference them — or, for inline datasets, writes a `<name>.fixtures.json` the case can load. Closes record→commit→replay. (Exact on-disk fixture layout finalized in the plan; principle: committed, per-case, replayable.)

### CLI: `dawn eval [path] [options]`

- `path` — optional file/dir filter (like `dawn test [path]`); default discovers all `*.eval.ts` under `src/`.
- `--live` — real model (local only).
- `--record` — live + capture per-case fixtures.
- `--json [file]` — write a machine-readable `EvalReport[]`; default `.dawn/eval-report.json` (gitignored), or the given path.
- `--cwd <path>` — app root (mirrors other commands).
- **Console output:** a per-eval table (cases × scorers, with mean and pass/fail), then a summary line per eval and an overall summary.
- **Exit code:** non-zero if **any** gated eval fails (so `dawn eval` is usable in CI/pre-commit). Informational evals never cause a non-zero exit.

### Discovery

New `cli/src/lib/runtime/load-evals.ts` mirroring `load-run-scenarios.ts`: walk `src/` for `evals/*.eval.ts` (co-located) + optional shared `src/evals/*.eval.ts`; load via tsx; validate the default export with `defineEval`'s validator; resolve each eval's `route` (explicit `route` field, else the nearest enclosing route directory). Returns `LoadedEval[]` for the runner.

## Error handling / edge cases

- **No fixtures in replay** → hard error per case (above).
- **`--live` without `OPENAI_API_KEY`** → throws at startup (reuses the harness guard).
- **Dataset string path missing/invalid** → error naming the path (reuse `loadFixtures`-style errors).
- **Async dataset in CI** → documented caveat: replay requires deterministic cases + committed fixtures; an async/network loader is a `--live` convenience. Not enforced in code.
- **Scorer throws** → that scorer scores 0 with the error captured in `reason`; the eval continues (one bad scorer doesn't abort the run).
- **`llmJudge` unparseable verdict** → score 0 + reason; in replay this means a missing/mismatched judge fixture (surfaced clearly).
- **Empty dataset / no scorers** → `defineEval` throws at load.

## Testing

- **Unit (`@dawn-ai/evals`):** scorer normalization (bool/number/object/clamp); each built-in scorer; `custom` async; gate policies (`mean`/`passRate`/`everyCase`/`perScorer`/`all`/`any`/custom) over synthetic reports; `defineEval` validation; dataset resolution (array/path/function); aggregate math.
- **Integration (mocked, CI):** a real eval file run through the runner in **replay** with committed per-case fixtures (incl. an `llmJudge` whose verdict is a fixture) → asserts scores + gate outcome + exit code. Proves the deterministic path end-to-end.
- **CLI:** `dawn eval` discovery + reporting + exit-code on pass and fail (no real model).
- **Dogfood:** add one eval to `examples/chat` with committed fixtures; CI runs `dawn eval` (replay) as a new deterministic harness/validate lane.
- **Live smoke (gated, NOT in CI):** `--live` over a tiny dataset against the real model; loose assertions; documented local-only.

## Out of scope (explicit, deferred)

- LangSmith **dataset upload / result sync** (keep LangSmith as the trace layer only).
- Eval-result **history / trend tracking** over time.
- **Parallel / distributed** eval execution (v1 runs cases sequentially; concurrency is a later optimization).
- **Non-agent route kinds** (chain/graph/workflow) — v1 is agent-only (`AgentRunResult` is agent-shaped); generalizing is a follow-up.
- A `dawn eval --watch` / UI.
