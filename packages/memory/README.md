<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/memory

Deterministic long-term memory storage and recall utilities for Dawn's typed
`memory.ts` capability. The package is the storage/ranking layer used by
`@dawn-ai/core`; application routes usually declare memory with
`defineMemory()` from `@dawn-ai/sdk`.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Conceptual docs: [Memory](https://dawnai.org/docs/memory) and
[Configuration](https://dawnai.org/docs/configuration#memory).

## Install

```bash
pnpm add @dawn-ai/memory
```

```ts
import {
  classifyWrite,
  scoreMemory,
  serializeNamespace,
  sqliteMemoryStore,
  tokenize,
  type MemoryRecord,
  type MemoryStore,
} from "@dawn-ai/memory"
```

## Public API

### Store

- `sqliteMemoryStore({ path, recall? })` creates the default `MemoryStore`.
  Use `path: ":memory:"` for tests or `<appRoot>/.dawn/memory.sqlite` for a
  file-backed store. The implementation uses `node:sqlite`, runs its own
  migrations, tokenizes stored records, and returns deterministic search
  results.
- `MemoryStore` is the storage contract:
  `put`, `get`, `search`, `update`, `supersede`, `delete`, and
  `listCandidates`.
- `MemoryRecord`, `MemoryQuery`, `MemoryKind`, `MemoryStatus`, and
  `MemorySource` describe the rows the runtime reads and writes.

### Namespaces and reconciliation

- `serializeNamespace(tuple)` converts a `MemoryScopeTuple` into the stable
  namespace string used by route memory.
- `classifyWrite(incoming, candidates, identityKeys)` returns a `WriteOp` for
  idempotent writes, supersession, or insertion by comparing one incoming record
  against a list of candidate records. Dawn's `auto` write mode uses the same
  identity-key concept.

### Ranking

- `scoreMemory(args)` scores a candidate row with relevance, recency, and
  confidence.
- `DEFAULT_RECALL_WEIGHTS`, `DEFAULT_RECENCY_HALF_LIFE_MS`, and
  `DEFAULT_CANDIDATE_POOL` match the defaults documented in
  [Memory](https://dawnai.org/docs/memory#how-recall-ranks).
- `RecallWeights` and `RecallRankingOptions` configure the default SQLite
  store's ranked recall.
- `idf(df, corpusSize)` and `tokenize(text)` expose the deterministic tokenizer
  and scoring primitives for tests and custom stores.

## Configuration

Most apps configure memory through `dawn.config.ts`, not by constructing this
package directly:

```ts
export default {
  memory: {
    writes: "candidate",
    indexMaxEntries: 20,
    recall: {
      weights: { relevance: 0.6, recency: 0.3, confidence: 0.1 },
      recencyHalfLifeMs: 14 * 24 * 60 * 60 * 1000,
      candidatePool: 256,
    },
  },
} satisfies import("@dawn-ai/core").DawnConfig
```

See [Memory configuration](https://dawnai.org/docs/memory#configuration) for
write modes, namespace scope, and recall tuning.

## Testing Notes

For route-level tests, prefer `seedMemory` from `@dawn-ai/testing`; it accepts a
store instance or a `{ path }` and fills sensible defaults for partial records.
Use `sqliteMemoryStore({ path: ":memory:" })` when testing storage behavior
directly.

The recall implementation is deterministic and does not call the network,
embedding services, FTS5, or the system clock. Ranked searches use the supplied
`MemoryQuery.now` timestamp, or the newest candidate timestamp when `now` is
omitted.

## Limitations and Security

- Only the semantic memory path is wired end-to-end in Dawn today. Episodic,
  procedural, and reflection kinds are typed for future use.
- `sqliteMemoryStore` is an embedded local store. It is not a multi-process
  database service or a tenant isolation boundary by itself.
- Candidate review, approval, and route scoping live in Dawn's runtime and CLI;
  this package stores records and ranks search results.
- Data is stored as plaintext SQLite rows. Treat the database path as sensitive
  application data.

## License

MIT
