---
"@dawn-ai/postgres-storage": patch
"@dawn-ai/cli": patch
---

**`@dawn-ai/postgres-storage`: `assumeMigrated`** — a new opt-out on every store
option type. `ready()` resolves immediately instead of opening a transaction,
taking `pg_advisory_xact_lock` and re-running the `CREATE … IF NOT EXISTS` pass.
Set it only when the same process has already migrated that database to the
store's current version. It exists for per-request store lifetimes: a store
memoizes its migration on the instance, so a factory that rebuilds stores every
request paid three migration transactions per request — and the three advisory
locks serialized concurrent requests on the same component key. The lock itself
is unchanged; what is skipped is a pass already known to have completed.

**`hono` build target fixes.**

- The generated `stores.mjs` now migrates once per isolate behind a module-scope
  flag and passes `assumeMigrated` thereafter.
- `wrangler.toml`: the generated marker is read back, so a rebuild recognizes
  its own scaffold instead of warning about it, writing a duplicate into
  `.dawn/build/`, and reporting that duplicate as the artifact. A marked file is
  still never overwritten.
- The build now fails, naming the config key, when `checkpointer`,
  `threadsStore`, `permissions.store` or `memory.store` is configured: the
  handle cannot cross the build boundary, and the emitted Postgres store was
  taking its place with nothing said.
- The provider import map is exhaustive or the build fails. A route that cannot
  be imported, or an agent whose provider cannot be inferred, is an error rather
  than a silently narrower map; `summarization.model` is included, so an app
  with openai routes and an anthropic summarization model no longer builds green
  and fails at request time on a package that was never bundled.
- All validation now runs before the first artifact is written.
- The emitted entry throws, naming the cause, when no Workers env is bound to a
  request or `DATABASE_URL` is unset, rather than building a pool with no
  connection string.
- Worker names generated from a package name now start with a letter, which
  Cloudflare requires.
- `hono` is no longer a dependency of `@dawn-ai/cli`, which does not import it.
  The generated app does, and the build's dependency notice names it along with
  `@dawn-ai/postgres-storage` and `@neondatabase/serverless`.
