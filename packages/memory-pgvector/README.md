<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/memory-pgvector

Supported Postgres and pgvector storage for shared long-term memory across Dawn application instances.

**Use this when:** You need to share vector memory across multiple Dawn application instances.

## Install

```bash
pnpm add @dawn-ai/memory-pgvector pg
```

The adapter requires the `pg` client at runtime; the install command includes it explicitly.

## Example

```ts
import { pgvectorMemoryStore } from "@dawn-ai/memory-pgvector"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is required")

const store = pgvectorMemoryStore({
  connectionString,
  dimensions: 1536,
})

// During application shutdown:
await store.close()
```

## Runtime and stability

`@dawn-ai/memory-pgvector` is a supported node-only application surface. It initializes the pgvector extension and tables lazily, so the database role needs the corresponding DDL and extension privileges. Calling `close()` ends a store-created pool. For an injected caller-owned pool, `close()` is a no-op; the caller must end the pool separately. Stored memory is plaintext application data. Updating a record preserves its existing embedding; re-embed changed semantic content before relying on vector retrieval.

## Related

- [pgvector Memory API reference](https://dawnai.org/docs/api/memory-pgvector) — exact options and lifecycle.
- [Long-term Memory](https://dawnai.org/docs/memory/long-term) — application configuration.
- [Recall and Retrieval](https://dawnai.org/docs/memory/retrieval) — hybrid search behavior.
- [`@dawn-ai/memory`](https://www.npmjs.com/package/@dawn-ai/memory) — shared memory contracts and ranking primitives.

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [`@dawn-ai/memory-pgvector` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/memory-pgvector/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
