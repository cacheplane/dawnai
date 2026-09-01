<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/evals

Supported evaluation definitions, datasets, scorers, reports, and release gates for Dawn application behavior.

**Use this when:** You are defining repeatable evaluations, scorers, or release gates for a Dawn application.

## Install

```bash
pnpm add -D @dawn-ai/evals @dawn-ai/testing
```

## Example

```ts
import { contains, defineEval, gate, runEval } from "@dawn-ai/evals"
import { createAgentHarness, script } from "@dawn-ai/testing"

const evaluation = defineEval({
  name: "support replies",
  route: "/support#agent",
  dataset: [
    {
      input: "Where is my order?",
      fixtures: script()
        .user("Where is my order?")
        .replies("Your order is in transit."),
    },
  ],
  scorers: [contains("order", { threshold: 1 })],
  gate: gate.perScorer(),
})

await using harness = await createAgentHarness({
  appRoot: process.cwd(),
  route: "/support#agent",
})
const report = await runEval(evaluation, {
  runCase: async (testCase) => {
    if (typeof testCase.input !== "string") throw new TypeError("Expected string input")
    return harness.run({
      input: testCase.input,
      ...(testCase.fixtures !== undefined ? { fixtures: testCase.fixtures } : {}),
    })
  },
})
```

## Runtime and stability

`@dawn-ai/evals` is a supported node-only testing surface because it resolves JSON and JSONL datasets from disk. Deterministic agent runs come from `@dawn-ai/testing`; scorer code still executes in replay, record, and live modes. `llmJudge()` needs a fixture, model credentials, or an injected fetch implementation.

## Related

- [Evals API reference](https://dawnai.org/docs/api/evals) — exact scorer, runner, and gate semantics.
- [Evals](https://dawnai.org/docs/evals) — the application evaluation workflow.
- [`@dawn-ai/testing`](https://www.npmjs.com/package/@dawn-ai/testing) and [Fixtures and Recording](https://dawnai.org/docs/testing-agents/fixtures) — deterministic model calls.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/evals` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/evals/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
