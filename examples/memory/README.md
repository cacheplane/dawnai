# `@dawn-example/memory` — long-term memory, backend-switchable

A one-route Dawn app (`notes`) with a note-taking agent that has durable,
cross-session memory. It ships with a **zero-setup SQLite backend** and switches
to **Postgres + [pgvector]** with a single environment variable — the same app
code, a different store.

## The route

- `src/app/notes/index.ts` — the agent (`gpt-5-mini`) with a `remember`/`recall`
  system prompt.
- `src/app/notes/memory.ts` — a `semantic` memory schema (`subject` /
  `predicate` / `value`), route-scoped.

The `remember` and `recall` tools are generated from `memory.ts`.

## Backends

The backend is chosen at load time from the environment (see `dawn.config.ts`):

| Env                                | Store            | Recall                       |
| ---------------------------------- | ---------------- | ---------------------------- |
| _(none)_                           | SQLite (default) | keyword-only                 |
| `OPENAI_API_KEY`                   | SQLite           | hybrid keyword **+ vector**  |
| `DATABASE_URL`                     | Postgres/pgvector | keyword-only                |
| `DATABASE_URL` + `OPENAI_API_KEY`  | Postgres/pgvector | hybrid keyword **+ vector**  |

The two toggles are independent. `DATABASE_URL` swaps the store; `OPENAI_API_KEY`
lights up vector/semantic recall (`text-embedding-3-small`, 1536 dims). Both the
store and the embedder connect lazily, so nothing touches the network until the
first `remember`/`recall`.

## Run it (SQLite, zero setup)

```sh
pnpm --filter @dawn-example/memory dev
```

Memory persists to `.dawn/memory.sqlite`. That's it — no key, no database.

## Run it against Postgres + pgvector

Start a pgvector-enabled Postgres:

```sh
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16
```

Point the app at it (and, optionally, add a key for vector recall):

```sh
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres"
export OPENAI_API_KEY="sk-..."   # optional — enables hybrid keyword+vector recall
pnpm --filter @dawn-example/memory dev
```

The app creates its tables + HNSW index on first write.

## Distillation

Once the app has accumulated some history, the two distillation passes compact it
— consolidation summarizes old episodes per (namespace, ISO week); reflection
derives durable insights:

```sh
# See the plan without spending a token (no model call, no key needed):
pnpm --filter @dawn-example/memory exec dawn memory consolidate --dry-run
pnpm --filter @dawn-example/memory exec dawn memory reflect --dry-run

# Run them for real (needs OPENAI_API_KEY — the default model is gpt-5-mini):
pnpm --filter @dawn-example/memory exec dawn memory consolidate
pnpm --filter @dawn-example/memory exec dawn memory reflect
```

Both are threshold-aware no-ops, so running them before there is anything to
distill just prints `nothing to consolidate` / `nothing to reflect on` and exits
`0` without constructing a model. Reflection writes its insights as **candidates**
by default — review them with `dawn memory list` and promote with
`dawn memory approve <id>`. See the [distillation docs][distill] for every flag
and the `memory.distill` config block.

## Continuous dogfood

`packages/testing/test/memory-example-dogfood.test.ts` drives this **real
example app** through a scripted remember → recall flow:

- **Always (CI-safe, no key, no Docker):** the default SQLite backend, proving
  the memory route works end-to-end.
- **Gated (`DAWN_TEST_PGVECTOR=1`, Docker):** the same flow against a
  [Testcontainers] Postgres, proving recall works through pgvector.

```sh
# CI-safe (SQLite) — gated block auto-skips:
pnpm --filter @dawn-ai/testing exec vitest run test/memory-example-dogfood.test.ts

# Local hands-on pgvector dogfood (needs Docker):
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/testing exec vitest run test/memory-example-dogfood.test.ts
```

[distill]: https://dawnai.org/docs/memory#distillation
[pgvector]: https://github.com/pgvector/pgvector
[Testcontainers]: https://testcontainers.com/
