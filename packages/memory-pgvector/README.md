<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/memory-pgvector

Supported Postgres and pgvector storage for shared long-term memory across Dawn application instances.

## Install

```bash
pnpm add @dawn-ai/memory-pgvector pg
```

```ts
import { pgvectorMemoryStore } from "@dawn-ai/memory-pgvector"
```

## Runtime and stability

`@dawn-ai/memory-pgvector` is a supported node-only application surface. It initializes the pgvector extension and tables lazily, so the database role needs the corresponding DDL and extension privileges. Stored memory is plaintext application data. Updating a record preserves its existing embedding; re-embed changed semantic content before relying on vector retrieval.

Use the [pgvector Memory API reference](https://dawnai.org/docs/api/memory-pgvector) for exact options and lifecycle. See [Long-term Memory](https://dawnai.org/docs/memory/long-term) for configuration and [Recall and Retrieval](https://dawnai.org/docs/memory/retrieval) for hybrid search behavior.

## License

MIT
