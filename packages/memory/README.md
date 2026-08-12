<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/memory

Supported long-term memory storage, ranking, browsing, namespace, and reconciliation primitives. Most route authors should declare memory with `defineMemory()` and use this package when they need direct store access.

## Install

```bash
pnpm add @dawn-ai/memory
```

```ts
import { sqliteMemoryStore } from "@dawn-ai/memory"
```

## Runtime and stability

- `@dawn-ai/memory` is a supported node-only application surface because it includes SQLite.
- `@dawn-ai/memory/browse` is a supported, dependency-free edge-safe integration surface.
- `@dawn-ai/memory/namespace` is a supported edge-safe integration surface.
- `@dawn-ai/memory/reconcile` is a supported edge-safe integration surface.

SQLite rows contain plaintext content, data, sources, and tags. Treat the database as sensitive application data and enforce tenant scope at the caller boundary.

Use the [Memory API reference](https://dawnai.org/docs/api/memory) for exact store and query contracts. Start with [Long-term Memory](https://dawnai.org/docs/memory/long-term), then see [Recall and Retrieval](https://dawnai.org/docs/memory/retrieval) and [Browse and Manage Memory](https://dawnai.org/docs/memory/browse).

## License

MIT
