---
"@dawn-ai/cli": patch
---

`close()` now drains in-flight runs, not just in-flight HTTP requests, before releasing sandboxes.

A cancelled `/runs/wait` answers with plain JSON, and the fetch wrapper only holds an in-flight slot for `text/event-stream` bodies — so `activeRequests` had already dropped to zero while the abandoned route was still executing against its sandbox. A routine `close()` (a rolling deploy, say) could therefore call `releaseAll()` mid-tool-call. The same applied to a cancelled stream whose route ignores `ctx.signal`.

The run registry already tracks exactly this — a run holds its slot for as long as its route may still be running, including after the response was sent — so `close()` now waits on both counters. The wait stays bounded by the existing drain deadline, and cancelling a run can now delay shutdown by up to that deadline rather than returning immediately.
