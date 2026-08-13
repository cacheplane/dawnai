---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Thread endpoints can now be authorized with a `src/thread-access.ts` policy.

`defineThreadAccess` answers a different question from route middleware — may
this caller create, read, mutate or destroy this thread — and is keyed on the
thread object rather than on route identity, because a thread has no owning
route. Five endpoints that previously ran no middleware at all are gated by it:
`POST /threads`, `GET /threads/:thread_id`, `GET /threads/:thread_id/state`,
`POST /threads/:thread_id/cancel` and `DELETE /threads/:thread_id`. A read
denial answers the same 404 a genuine miss answers, so a policy cannot be used
to enumerate thread ids, and a `delete` is authorized even when the row is
missing so a 403 cannot confirm that a thread exists.

The policy loader is fail-closed, unlike the middleware probe: a
`thread-access.ts` that exists but cannot be imported or binds no usable policy
fails the boot with `DAWN_E3003` rather than degrading to "no gate". An app with
no policy file behaves exactly as before, and every boot logs which layer the
policy came from, or that there is none.

`dawn build` now fails with `DAWN_E1005` for the `langsmith` target while a
policy file exists, because that runtime cannot carry the hook. The `node`,
`hono` and `vercel` targets are unaffected: `node`'s emitted server probes the
policy at boot, and the bundled web targets carry it in their static manifest.

One behavior change applies with or without a policy: `POST /threads` drops the
reserved `dawn:access` key from client-supplied `metadata`. That key holds the
server-issued access stamp, so a client can never write one — including in an
app that adopts a policy later.

`POST /threads/:thread_id/cancel` now binds its cancel to the run the caller
observed, so a cancel can no longer land on a later run of the same thread; when
the observed run has already finished it answers the existing
`409 no_run_in_flight`.

`@dawn-ai/testing` gains `createThreadAccessHarness` for unit-testing a policy
without booting a server, and `createAgentProtocolInjector` accepts a
`threadAccess` policy.

The run endpoints — `/runs/stream`, `/runs/wait`, `/resume` and `/agui` — plus
`GET /threads/:thread_id/pending_interrupts` are gated on this policy too; see
the entry covering them for the ordering consequences and the `ThreadOperation`
addition.
