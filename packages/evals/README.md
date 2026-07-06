<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/evals

Evaluation harness for Dawn agents — running and scoring agent behavior against datasets and scenarios.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Evaluating your Dawn agent](https://dawnai.org/docs/evals) and
[Testing your Dawn agent](https://dawnai.org/docs/testing-agents).

## Install

```bash
pnpm add -D @dawn-ai/evals @dawn-ai/testing
```

```ts
import {
  contains,
  defineEval,
  gate,
  memoryFresh,
  memoryIsolated,
  memoryRecalled,
  runEval,
  toolCalled,
} from "@dawn-ai/evals"
```

## Exported Groups

### Eval definition and execution

- `defineEval(def)` types an eval definition.
- `resolveDataset(dataset, baseDir)` normalizes inline, JSON, JSONL, or function
  datasets.
- `runEval(def, options)` executes cases with a caller-provided `runCase`
  function and returns an `EvalReport`.
- Types include `Dataset`, `EvalCase`, `EvalDefinition`, `RunEvalOptions`,
  `EvalReport`, `CaseResult`, and `ScoredReport`.

### Scores and gates

- `normalizeScore(value)` converts numbers, booleans, and rich verdicts into a
  `NormalizedScore`.
- `gate` and `resolveGate()` implement dataset-wide pass/fail policies.
- Types include `Score`, `CaseScore`, `Scorer`, `ScorerAggregate`,
  `GatePolicy`, and `GateResult`.

### Built-in scorers

- `exactMatch()`
- `contains(substring)`
- `regex(re)`
- `jsonEquals(options?)`
- `toolCalled(name, options?)`
- `tokensUnder(budget)`
- `custom(fn, options?)`
- `llmJudge(options)`

`llmJudge()` calls a real model and should be reserved for local live runs or
explicitly provisioned evaluation jobs.

### Memory scorers

- `memoryRecalled(expectedIds)` checks that `recall` tool output contains every
  expected memory id.
- `memoryFresh(expectedValue)` checks that the final message surfaced the newer
  value.
- `memoryIsolated(forbidden)` checks that a value did not leak through recall
  output or the final message.

These scorers are useful with `seedMemory()` from `@dawn-ai/testing`.

## Common Examples

Define a route eval:

```ts
import { contains, defineEval, gate, toolCalled } from "@dawn-ai/evals"
import { script } from "@dawn-ai/testing"

export default defineEval({
  name: "chat quality",
  dataset: [
    {
      name: "filters open items",
      input: "Filter open items",
      fixtures: script()
        .user("Filter open items")
        .callsTool("applyFilter", { status: "open" })
        .replies("Found 2 open items."),
    },
  ],
  scorers: [
    contains("Found", { threshold: 1 }),
    toolCalled("applyFilter", { threshold: 1 }),
  ],
  gate: gate.perScorer(),
})
```

Run an eval programmatically:

```ts
import { contains, defineEval, runEval } from "@dawn-ai/evals"
import { createAgentHarness, script } from "@dawn-ai/testing"

const h = await createAgentHarness({ appRoot: process.cwd(), route: "/chat#agent" })

const def = defineEval({
  name: "hello",
  dataset: [{ input: "hello", fixtures: script().user("hello").replies("Hi!") }],
  scorers: [contains("Hi", { threshold: 1 })],
  threshold: 1,
})

const report = await runEval(def, {
  runCase: (testCase) => h.run({ input: testCase.input, fixtures: testCase.fixtures }),
})
```

Use memory scorers:

```ts
import { defineEval, memoryFresh, memoryIsolated, memoryRecalled } from "@dawn-ai/evals"

export default defineEval({
  name: "memory behavior",
  dataset: [{ input: "What does Acme prefer?" }],
  scorers: [
    memoryRecalled(["memory_acme_terms"]),
    memoryFresh("net-30"),
    memoryIsolated("other-tenant-secret"),
  ],
})
```

## Testing Notes

- Evals replay aimock fixtures by default and are CI-safe when fixtures are
  committed.
- `dawn eval --live` ignores fixtures and calls the real model locally.
- `dawn eval --record` records live model responses into sibling fixture files.
- `llmJudge()` requires a live model key; keep it out of offline CI unless your
  CI job is intentionally provisioned for model calls.

## License

MIT
