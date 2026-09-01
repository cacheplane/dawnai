<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/testing

Supported harnesses, fixtures, matchers, deterministic embedders, and runtime helpers for testing Dawn applications.

**Use this when:** You want to test Dawn agent behavior without making live model calls.

## Install

```bash
pnpm add -D @dawn-ai/testing vitest
```

## Example

```ts
import { createAgentHarness, expectFinalMessage, script } from "@dawn-ai/testing"

await using harness = await createAgentHarness({
  appRoot: process.cwd(),
  route: "/support#agent",
})
const result = await harness.run({
  input: "Say hello",
  fixtures: script().user("Say hello").replies("Hello!"),
})

expectFinalMessage(result).toContain("Hello")
```

## Runtime and stability

`@dawn-ai/testing` is a supported node-only testing surface. `createAgentHarness()` temporarily changes process-wide model environment variables and runtime caches; await `close()` and do not run concurrent harnesses in one process. Fixture replay is deterministic and CI-safe; live recording requires model credentials.

## Related

- [Testing API reference](https://dawnai.org/docs/api/testing) — exact harness and lifecycle contracts.
- [Agent Test Harness](https://dawnai.org/docs/testing-agents) — end-to-end agent testing.
- [Fixtures and Recording](https://dawnai.org/docs/testing-agents/fixtures) — deterministic replay and optional live recording.
- [`@dawn-ai/evals`](https://www.npmjs.com/package/@dawn-ai/evals) — repeatable datasets, scorers, and release gates.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/testing` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/testing/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
