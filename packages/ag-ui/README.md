<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/ag-ui

Supported AG-UI protocol translation for Dawn runtime streams, client inputs, interrupts, activities, and SSE responses.

## Install

```bash
pnpm add @dawn-ai/ag-ui
```

```ts
import { fromRunAgentInput, toAguiEvents } from "@dawn-ai/ag-ui"
import { encodeAgUiSse } from "@dawn-ai/ag-ui/sse"
```

Plan and subagent activity snapshots are translated on the root surface; use the focused API reference for their exact identifiers and payload contracts.

Built-in orchestration is presented once. A `writeTodos` or `task` call whose activity was emitted produces no `TOOL_CALL_*` events, correlated by the model's tool-call id; every other tool is unchanged. The rule fails open, so the ordinary tool events are preserved whenever the activity cannot be produced. A client that registers no activity renderer therefore sees less for those two tools: activity snapshots are the canonical surface for them.

## React renderers

`@dawn-ai/ag-ui/react` renders those activity snapshots. The drop-in is one prop:

```tsx
import { dawnActivityRenderers } from "@dawn-ai/ag-ui/react"

<CopilotKit runtimeUrl="/api/copilotkit" renderActivityMessages={dawnActivityRenderers}>
```

The subpath exports three layers, from drop-in to build-your-own:

- `dawnActivityRenderers` — both renderers, ready to pass to CopilotKit's `renderActivityMessages`.
- `dawnPlanActivityRenderer` and `dawnSubagentActivityRenderer` — the individual renderers, for a client that wants one of them or mixes them with its own.
- `PlanActivityCard`, `SubagentActivityCard`, and `ActivityChecklist` — plain React components taking `content`, plus `planActivityContentSchema` and `subagentActivityContentSchema`, the strict validators behind the renderers, for presenting the same activities another way.

`react` and `@copilotkit/react-core` are optional peer dependencies used only by this subpath. Importing the root or `./sse` entry never loads it, so a server-only consumer installs nothing extra.

## Runtime and stability

- `@dawn-ai/ag-ui` is a supported, edge-safe integration surface.
- `@dawn-ai/ag-ui/sse` is a supported, edge-safe integration surface.
- `@dawn-ai/ag-ui/react` is a supported React application surface, built for browser bundles. Dawn records its runtime as `node-only`, which means only that it does not pass Dawn's edge-safety guard — not that it requires Node: React's own JSX runtime reads `process.env.NODE_ENV`, which an application bundler substitutes as usual but the stricter edge guard rejects. The other two entries never load it.
- `@dawn-ai/ag-ui/react/styles.css` is a supported integration surface carrying the cards' default appearance. It is a stylesheet asset, so it has no runtime classification at all: a bundler resolves it and nothing evaluates it as JavaScript. Import it once alongside your global CSS; it is optional, and every selector is scoped to the `dawn-activity` prefix.

They translate protocol data; they do not authenticate callers or make client-provided state authoritative.

Use the [AG-UI API reference](https://dawnai.org/docs/api/ag-ui) for exact contracts. See [AG-UI and Web Clients](https://dawnai.org/docs/ag-ui) for setup and [Agent Protocol](https://dawnai.org/docs/dev-server/agent-protocol) for the underlying runtime endpoints.

## License

MIT
