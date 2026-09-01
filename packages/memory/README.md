<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/memory

Supported long-term memory storage, ranking, browsing, namespace, and reconciliation primitives. Most route authors should declare memory with `defineMemory()` and use this package when they need direct store access.

**Use this when:** You need to access memory stores or ranking primitives directly instead of using only `defineMemory()`.

## Install

```bash
pnpm add @dawn-ai/memory
```

## Example

```ts
import { sqliteMemoryStore } from "@dawn-ai/memory"

const store = sqliteMemoryStore({ path: ".dawn/memory.sqlite" })
```

Supported focused entry points are `@dawn-ai/memory/browse`, `@dawn-ai/memory/namespace`, and `@dawn-ai/memory/reconcile`.

## Runtime and stability

- `@dawn-ai/memory` is a supported node-only application surface because it includes SQLite.
- `@dawn-ai/memory/browse` is a supported, dependency-free edge-safe integration surface.
- `@dawn-ai/memory/namespace` is a supported edge-safe integration surface.
- `@dawn-ai/memory/reconcile` is a supported edge-safe integration surface.

SQLite rows contain plaintext content, data, sources, and tags. Treat the database as sensitive application data and enforce tenant scope at the caller boundary.

## Related

- [Memory API reference](https://dawnai.org/docs/api/memory) — exact store, query, and subpath contracts.
- [Long-term Memory](https://dawnai.org/docs/memory/long-term) — application configuration.
- [Recall and Retrieval](https://dawnai.org/docs/memory/retrieval) and [Browse and Manage Memory](https://dawnai.org/docs/memory/browse) — retrieval and administration workflows.
- [`@dawn-ai/memory-pgvector`](https://www.npmjs.com/package/@dawn-ai/memory-pgvector) — shared Postgres-backed vector memory.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/memory` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/memory/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
