# @dawn-ai/langgraph

LangGraph.js adapters and route-module contracts for Dawn graphs and workflows.

**Use this when:** You are integrating raw graphs or workflows with Dawn route contracts. Agent and tool authors who do not need raw route modules should start with [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk).

## Install

```bash
pnpm add @dawn-ai/langgraph
```

## Example

```ts
import { defineEntry, graphAdapter } from "@dawn-ai/langgraph"

const route = defineEntry({
  graph: async (input: { name: string }) => ({ greeting: `Hello, ${input.name}` }),
})

const result = await graphAdapter.execute(route.graph, { name: "Dawn" }, {
  signal: new AbortController().signal,
})
```

## Runtime and stability

- `@dawn-ai/langgraph` is an edge-safe, supported integration surface for adapters and route contracts.
- `@dawn-ai/langgraph/define-entry` is an edge-safe, supported entry-validation subpath.
- `@dawn-ai/langgraph/route-module` is an edge-safe, supported normalization and route-type subpath.

These surfaces contain no third-party runtime dependencies or Node globals. That boundary does not classify graphs, workflows, or tools supplied by an application.

## Related

- [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk) — higher-level route, agent, and tool contracts.
- [`@dawn-ai/langchain`](https://www.npmjs.com/package/@dawn-ai/langchain) — LangChain agent and chain materialization.
- [LangGraph API reference](https://dawnai.org/docs/api/langgraph) — route-module exports and adapter behavior.
- [Routes guide](https://dawnai.org/docs/routes) — Dawn's filesystem route model.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/langgraph/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
