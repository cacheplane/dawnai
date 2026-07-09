<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/memory-pgvector

Postgres + pgvector backend for Dawn's typed long-term memory store. Use it when
the default SQLite store is too local for your deployment: multiple app
instances, a shared production database, or enough embedded memories that
Postgres HNSW retrieval is a better fit than in-process cosine scans.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Memory](https://dawnai.org/docs/memory) and
[Configuration](https://dawnai.org/docs/configuration#memory).

## Install

```bash
pnpm add @dawn-ai/memory-pgvector @dawn-ai/memory
```

For hybrid semantic recall with OpenAI embeddings, also use
`openaiEmbedder()` from `@dawn-ai/langchain`:

```bash
pnpm add @dawn-ai/langchain
```

## Configure Dawn

```ts
import { config } from "@dawn-ai/core"
import { openaiEmbedder } from "@dawn-ai/langchain"
import { pgvectorMemoryStore } from "@dawn-ai/memory-pgvector"

export default config({
  memory: {
    store: pgvectorMemoryStore({
      connectionString: process.env.DATABASE_URL,
      dimensions: 1536,
    }),
    vector: { embedder: openaiEmbedder() },
  },
})
```

`dimensions` must match the embedder's output length. `openaiEmbedder()` defaults
to `text-embedding-3-small`, which is 1536 dimensions.

## Postgres Requirements

The database must have pgvector available. The store runs
`CREATE EXTENSION IF NOT EXISTS vector` during lazy schema initialization, so the
connected role needs permission to create the extension or the extension must
already exist.

For local development:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres"
```

## Public API

```ts
import {
  assertIdentifier,
  initSchema,
  pgvectorMemoryStore,
  vectorColumnDef,
  type PgvectorMemoryStore,
} from "@dawn-ai/memory-pgvector"
```

### `pgvectorMemoryStore(options)`

```ts
const store = pgvectorMemoryStore({
  connectionString: process.env.DATABASE_URL,
  dimensions: 1536,
  schema: "public",
  tablePrefix: "dawn_memory",
  index: { m: 16, efConstruction: 64, efSearch: 40 },
})
```

Options:

- `connectionString?` - Postgres connection string. Used when the store owns its
  own `pg.Pool`.
- `pool?` - Existing `pg.Pool`. When supplied, the caller owns pool lifecycle.
- `dimensions` - Required embedding dimension count. Values up to 2000 use
  `vector(n)`; values from 2001 through 4000 use `halfvec(n)`.
- `index?` - HNSW tuning: `m`, `efConstruction`, and `efSearch`.
- `schema?` - Postgres schema. Defaults to `public`.
- `tablePrefix?` - Table/index prefix. Defaults to `dawn_memory`.
- `recall?` - Keyword ranked-recall tuning from `@dawn-ai/memory`.
- `vector?` - Store-level hybrid RRF tuning used when a query omits its own
  `vector` options.

`schema` and `tablePrefix` are interpolated into DDL, so they must be simple SQL
identifiers matching `/^[a-z_][a-z0-9_]*$/i`.

### Store Methods

`PgvectorMemoryStore` implements `MemoryStore` from `@dawn-ai/memory` and adds
`close()`:

```ts
await store.put(record, {
  embedding: Float32Array.from([...]),
  embeddingModel: "openai:text-embedding-3-small",
})

const row = await store.get("memory_abc")
const hits = await store.search({
  namespace: "workspace=app|route=/notes|",
  query: "expedite delivery options",
  queryEmbedding,
  embedderId: "openai:text-embedding-3-small",
})

await store.update("memory_abc", { content: "updated content" })
await store.supersede("old_id", "new_id")
await store.delete("memory_abc")
await store.listCandidates("workspace=app|")
await store.close()
```

Behavior notes:

- Schema initialization is lazy, memoized, and idempotent. Every method waits for
  it before touching tables.
- `put()` upserts the memory row and refreshes token rows used by keyword
  search.
- `search()` defaults to `status: "active"` and `limit: 8`.
- Query-less `search()` returns newest rows first.
- Query searches use the same deterministic keyword ranking core as SQLite.
- When `queryEmbedding` and `embedderId` are present, search runs the hybrid
  path: keyword candidates plus pgvector HNSW nearest-neighbor candidates,
  fused by the shared RRF/recency/confidence ranking core.
- `update()` preserves an existing stored embedding.
- `close()` ends only a pool created by `pgvectorMemoryStore()`. It is a no-op
  for an injected pool.

### `vectorColumnDef(dimensions)`

Returns the pgvector column type and cosine operator class:

- `1..2000` -> `vector(n)` with `vector_cosine_ops`
- `2001..4000` -> `halfvec(n)` with `halfvec_cosine_ops`
- `>4000` throws an error naming the 4000 halfvec index ceiling

`pgvectorMemoryStore()` calls this during construction, so invalid dimensions
fail before a pool is opened or schema initialization starts.

### `initSchema(client, options)`

Low-level helper that creates the extension, schema, tables, token indexes, and
HNSW embedding index. Most apps should let `pgvectorMemoryStore()` call it.

### `assertIdentifier(name, value)`

Validates schema/table-prefix identifiers used by DDL helpers.

## Published-Package Smoke

The high-value local smoke for this package installs the published tarballs from
the real npm registry outside the monorepo, starts `pgvector/pgvector:pg16`, and
uses a real OpenAI embedding run. The regression guard is:

- `openaiEmbedder().dims === 1536`
- `embed(["probe"])` returns a 1536-length `Float32Array`
- a zero-shared-token paraphrase such as "expedite delivery options" recalls a
  stored "faster shipping" fact through `queryEmbedding + embedderId`

That smoke specifically protects the `encodingFormat: "float"` path in
`openaiEmbedder()` and the published pgvector store's real `vector(1536)` path.

Do not commit API keys. Load `OPENAI_API_KEY` only into the local smoke shell.

## Limitations

- The backend requires Postgres with pgvector. It does not fall back to SQLite.
- HNSW retrieval happens in SQL, but final hybrid fusion still runs in the
  shared JavaScript ranking core.
- `halfvec` enables larger embedding models up to 4000 dimensions with reduced
  precision.
- Data is stored as plaintext Postgres rows. Treat the database as sensitive
  application data.

## License

MIT
