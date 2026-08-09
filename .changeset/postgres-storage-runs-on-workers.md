---
"@dawn-ai/postgres-storage": patch
---

**`@dawn-ai/postgres-storage` runs on Cloudflare Workers.** That was an open
question when the package shipped in `0.8.19`, and its README said so: workerd
provides no raw TCP socket, so `pg` is unusable there.

What changed is the main entry's typing. The pool is now structural —
`SqlPool = { query, connect, end }` — which both `pg.Pool` and a
`@neondatabase/serverless` WebSocket `Pool` satisfy with no driver abstraction in
between. Injecting the latter runs the full contract, transactions included. The
narrowness is itself the guard: `neon()`'s transaction-incapable HTTP query
function fails to satisfy `SqlPool` at compile time, correctly, because the
checkpointer needs real `BEGIN`/`COMMIT`. `dawn build`'s `hono` target generates
that wiring for you. Hyperdrive should also work but is untested — it needs a
Cloudflare account.

Three separate pieces of evidence back this, and they are worth keeping apart:

- **A throwaway spike** ran this package's built `dist` inside real workerd
  against `postgres:16-alpine` plus a `wsproxy`. It is the only thing that has
  checked the driver's transaction semantics there: `BEGIN`/`COMMIT`/`ROLLBACK`
  are genuine session transactions, `pg_advisory_xact_lock` really blocks a
  second session, and eight concurrent cold-start migrations converged. The spike
  was not retained; its findings are recorded in
  `docs/superpowers/specs/2026-08-05-edge-targets-design.md`.
- **The package's own suite** is the standing regression guard for the migration
  behavior — concurrent cold starts against a virgin database, for all three
  stores — but it runs on Node with `pg` and Testcontainers, gated on
  `DAWN_TEST_PGSTORAGE`, not inside workerd.
- **The gated `edge-workerd` CI lane** is what runs continuously inside workerd,
  and it asserts at the application level rather than the SQL level: four
  sequential AG-UI turns each carrying the model's reply, identical event shapes
  across turns, `/healthz`, and out-of-band `psql` checks that the thread,
  checkpoint, and pending-write rows are really in Postgres. It exercises the
  stores through the runtime; it does not assert on transactions, the advisory
  lock, or concurrent cold starts.

One rule that lane settled the hard way: on workerd, **build the pool and the
stores per request**. A connection is bound to the I/O context of the request
that opened it, so a module-scope pool hands the next request a dead socket and
hangs rather than erroring. `assumeMigrated` exists for exactly that lifetime —
it lets a per-request store skip the migration pass that a module-scope boolean
has already completed for the isolate.

Correcting one line of `0.8.19`'s entry while it is fresh: migrations are
memoized **on the store instance**, not per process. That distinction did not
matter when a process built its stores once; it is the whole reason
`assumeMigrated` had to exist once stores are per request.
