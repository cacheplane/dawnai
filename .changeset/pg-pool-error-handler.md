---
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/postgres-storage": patch
---

Handle `pg` pool errors instead of crashing the process.

Both Postgres-backed packages created their `pg` `Pool` with no `'error'` listener.
`pg` emits that event on the **pool** when an **idle** client fails, and an
EventEmitter `'error'` with no listener is an uncaught exception — so the process
exits. Idle connections are dropped as a matter of course: a server restart, a
failover, `idle_session_timeout`, a container stopping. Any of those took the whole
app down instead of the pool quietly replacing one connection.

This surfaced as a CI flake — the `pgvector-docker` lane failing *after* all 50 tests
passed, because stopping the test container terminates idle clients with `57P01` — but
the flake was the symptom. The same defect applied in production, and most sharply in
`@dawn-ai/postgres-storage`, whose checkpointer, threads and permissions stores hold
durable agent state for exactly the long-running and edge deployments where connection
drops are routine.

Pools these packages own now log a warning and carry on; `pg` has already discarded the
broken client, and the next query transparently opens a new one. A caller-supplied
`pool` is left untouched — its owner controls its lifecycle and error handling. In
`@dawn-ai/postgres-storage` the three stores now share one `resolvePool` helper, so the
rule cannot drift between them.

Both packages gained a test that terminates a live idle connection with
`pg_terminate_backend` and asserts no uncaught exception, that the drop was logged, and
that the store still serves the next query. Both fail without the fix.
