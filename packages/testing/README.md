<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/testing

Testing utilities for Dawn apps — helpers for exercising routes, tools, and agent behavior in unit and scenario tests.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Testing your Dawn agent](https://dawnai.org/docs/testing-agents),
[Memory](https://dawnai.org/docs/memory#testing), and
[Evals](https://dawnai.org/docs/evals).

## Install

```bash
pnpm add -D @dawn-ai/testing vitest
```

```ts
import {
  createAgentHarness,
  expectFinalMessage,
  expectNoToolErrors,
  expectToolCalled,
  script,
} from "@dawn-ai/testing"
```

## Exported Groups

### Agent harness

- `createAgentHarness(options)` boots the deterministic in-process harness.
- `AgentHarness` and `AgentHarnessOptions` type the returned harness and its
  options.
- `collectRunResult()` and `deriveToolResults()` normalize a run into
  `AgentRunResult`, `ObservedToolCall`, and `ObservedToolResult`.

### Fixtures and aimock

- `script()` builds multi-turn aimock fixture scripts.
- `createAimock()` starts the local model mock directly.
- `loadFixtures()` and `writeFixtures()` read/write committed fixture files.
- `record(options)` records a live model interaction into fixtures for local
  authoring.
- Types include `Aimock`, `AimockFixture`, `AimockResponse`,
  `AimockToolCall`, `FixtureSet`, `ScriptBuilder`, and `RecordOptions`.

### Matchers

The matcher exports assert common agent behavior:

- `expectFinalMessage`
- `expectInterrupt` and `expectNoInterrupt`
- `expectNoToolErrors`
- `expectOffloaded`
- `expectPlan`
- `expectState`
- `expectStreamedTokens`
- `expectSubagent`
- `expectSystemPrompt`
- `expectToolCalled`
- `expectToolSequence`

Supporting types include `InterruptInfo`, `SubagentEvent`, `SubagentRun`, and
`Todo`.

### Harnesses and protocol helpers

- `createToolHarness()`
- `createWorkspaceHarness()`
- `createMiddlewareHarness()`
- `createAgentProtocolInjector()`
- `createSubprocessApp()`
- Types include `ToolHarness`, `WorkspaceHarness`, `MiddlewareHarness`,
  `AgentProtocolInjector`, `InjectResult`, and `SubprocessApp`.

The default `createAgentHarness` mode is in-process. The exported protocol and
subprocess helpers are available for custom orchestration; the harness mode
options for those paths are intentionally limited until their integrations are
fully wired.

### Memory

- `seedMemory()` seeds a `@dawn-ai/memory` store for deterministic route-memory
  tests.

## Common Examples

Test an agent without calling a live model:

```ts
import { fileURLToPath } from "node:url"
import { afterAll, it } from "vitest"
import {
  createAgentHarness,
  expectFinalMessage,
  expectNoToolErrors,
  expectToolCalled,
  script,
} from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("filters open items", async () => {
  const run = await h.run({
    input: "Filter open items",
    fixtures: script()
      .user("Filter open items")
      .callsTool("applyFilter", { status: "open" })
      .replies("Found 2 open items."),
  })

  expectToolCalled(run, "applyFilter").withArgs({ status: "open" })
  expectNoToolErrors(run)
  expectFinalMessage(run).toContain("Found 2")
})
```

Seed memory:

```ts
import { seedMemory } from "@dawn-ai/testing"

const store = await seedMemory(
  { path: ":memory:" },
  [
    {
      id: "memory_seed1",
      namespace: "workspace=app|route=/research",
      content: "acme prefers invoices net-30",
      status: "active",
    },
  ],
)
```

Use a workspace harness:

```ts
import { createWorkspaceHarness } from "@dawn-ai/testing"

const h = await createWorkspaceHarness()
await h.fs.writeFile("notes.md", "hello")
```

## Testing Notes

- Fixture replay is the default and is CI-safe. Do not assert against live model
  output in ordinary tests.
- Commit every `.fixture.json` file your tests load.
- Use `live: true` only in local smoke tests guarded by `OPENAI_API_KEY`.
- `expectNoToolErrors(run)` ignores permission interrupts and focuses on tool
  error results.

## License

MIT
