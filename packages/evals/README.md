<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/evals

Supported evaluation definitions, datasets, scorers, reports, and release gates for Dawn application behavior.

## Install

```bash
pnpm add -D @dawn-ai/evals @dawn-ai/testing
```

```ts
import { contains, defineEval, gate, runEval } from "@dawn-ai/evals"
```

## Runtime and stability

`@dawn-ai/evals` is a supported node-only testing surface because it resolves JSON and JSONL datasets from disk. Deterministic agent runs come from `@dawn-ai/testing`; scorer code still executes in replay, record, and live modes. `llmJudge()` needs a fixture, model credentials, or an injected fetch implementation.

Use the [Evals API reference](https://dawnai.org/docs/api/evals) for exact scorer and gate semantics. See [Evals](https://dawnai.org/docs/evals) for the application workflow and [Fixtures and Recording](https://dawnai.org/docs/testing-agents/fixtures) for deterministic model calls.

## License

MIT
