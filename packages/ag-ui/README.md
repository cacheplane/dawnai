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

## Runtime and stability

- `@dawn-ai/ag-ui` is a supported, edge-safe integration surface.
- `@dawn-ai/ag-ui/sse` is a supported, edge-safe integration surface.

They translate protocol data; they do not authenticate callers or make client-provided state authoritative.

Use the [AG-UI API reference](https://dawnai.org/docs/api/ag-ui) for exact contracts. See [AG-UI and Web Clients](https://dawnai.org/docs/ag-ui) for setup and [Agent Protocol](https://dawnai.org/docs/dev-server/agent-protocol) for the underlying runtime endpoints.

## License

MIT
