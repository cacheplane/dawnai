---
"@dawn-ai/cli": patch
---

Add `GET /threads/{thread_id}/pending_interrupts`, which returns the human-in-the-loop
interrupts parked on a thread together with each interrupt's payload, so a client that
reloaded can re-render a permission prompt from durable checkpoint state alone. Standard
Agent Protocol middleware gates the endpoint using the route that parked the interrupts,
falling back to the route last run on the thread when nothing is parked; a thread with no
resolvable route is refused with `thread_route_unknown`. Because the endpoint is a `GET`,
middleware can now observe a `req.method` of `"GET"`, and `req.params` is empty there —
middleware that assumed `"POST"` or read route params needs updating.

Parked turns now report thread status `"interrupted"` instead of `"idle"` on
`GET /threads/{thread_id}`, from the run stream and the resume endpoint. `/runs/wait` is
a blocking JSON call and still reports `"idle"` when its turn parks; use
`pending_interrupts` to detect a park there. The `"interrupted"` status is shared with
cancelled runs, and `pending_interrupts` is the discriminator — a non-empty list means
the agent is waiting on a human.

`PendingInterrupt` (exported from `@dawn-ai/cli/runtime`) gains an optional
`value?: unknown` carrying that payload. It is optional so existing code that constructs
the object keeps compiling; the parse always populates it.
