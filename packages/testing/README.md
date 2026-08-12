<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/testing

Supported harnesses, fixtures, matchers, deterministic embedders, and runtime helpers for testing Dawn applications.

## Install

```bash
pnpm add -D @dawn-ai/testing vitest
```

```ts
import { createAgentHarness, expectFinalMessage, script } from "@dawn-ai/testing"
```

## Runtime and stability

`@dawn-ai/testing` is a supported node-only testing surface. `createAgentHarness()` temporarily changes process-wide model environment variables and runtime caches; await `close()` and do not run concurrent harnesses in one process. Fixture replay is deterministic and CI-safe; live recording requires model credentials.

Use the [Testing API reference](https://dawnai.org/docs/api/testing) for exact harness and lifecycle contracts. See [Agent Test Harness](https://dawnai.org/docs/testing-agents) and [Fixtures and Recording](https://dawnai.org/docs/testing-agents/fixtures) for copyable workflows.

## License

MIT
