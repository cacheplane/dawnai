---
"@dawn-ai/cli": patch
---

Add `dawn threads tail <thread-id>` — reattach to a thread from the terminal.
It consumes `GET /threads/:thread_id/runs/stream`, printing a snapshot (the
committed transcript, the in-flight turn's output so far, and any parked
human-in-the-loop prompts) and then following live frames until the turn ends.
When no turn is live in the target process it prints the durable
checkpoint-backed snapshot and exits, so it works across restarts and replicas.

`--url` points at a server other than `http://127.0.0.1:3000`, `--header` is
repeatable for middleware that authenticates the thread's route, and `--json`
prints raw SSE frames for scripting. Attaching takes no run slot and cancels
nothing.

This is Dawn's first first-party Agent Protocol stream client: it parses the
documented wire defensively rather than importing the server's frame types, so
the published contract now has a consumer that exercises it.
