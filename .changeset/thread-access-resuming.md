---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Add `resuming` to `ThreadAccessRequest`: a required boolean that is `true` when
the request carries a resume credential and will continue a parked turn. It is
additive — an existing policy compiles and behaves exactly as before.

A policy that wants resumes treated differently from ordinary turns — step-up
auth, a second approver, extra logging — should check `req.resuming` rather than
`req.operation`. Two endpoints resume, and only one of them says so in its
operation: `POST /threads/{thread_id}/resume` reports `run.resume`, but a
`POST /agui/{routeId}` carrying a `resume` array reports `run.agui`, exactly as
an ordinary AG-UI turn does. The request body is the only thing that separates
them, and a policy never sees it, so keying the rule on `operation` leaves every
AG-UI resume ungoverned.

`resuming` is `false` everywhere else and never absent, so no policy needs
`?? false`. An endpoint that gates more than once for one request — the gate
before its side effects, the mid-flight recheck, the implicit create's recheck —
reports the same value at every site.

`createThreadAccessHarness().check()` accepts an optional `resuming`, defaulting
to `false`.
