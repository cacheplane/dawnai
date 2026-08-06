---
"@dawn-ai/cli": patch
---

Add `POST /threads/:thread_id/cancel` to stop an in-flight Agent Protocol run, and enforce one run per thread.

Runs previously had no way to be stopped short of killing the process — the only `AbortSignal` reaching a route was the server shutdown signal. Cancellation now works across `/runs/stream`, `/runs/wait`, and `/resume`, and keeps checkpointed state (LangGraph's `action=interrupt` semantics; there is no rollback). The endpoint returns `200 {thread_id, status:"interrupted"}`, `404` for an unknown thread, or `409` when no run is in flight. A cancelled SSE run ends with `done` carrying `{"cancelled":true}`, distinguishing it from a failure; a cancelled `runs/wait` returns `409` with code `run_cancelled`, since it has not committed to a response body yet.

**Behaviour change:** a second concurrent run on a thread that is already running now returns `409` with code `run_in_flight` instead of being admitted. Concurrent runs previously drove the same LangGraph checkpoint thread and interleaved their writes last-writer-wins, silently corrupting thread state, so this converts data loss into a clear error. The gate is keyed on in-memory state rather than the persisted thread status, so a process that crashes mid-run does not leave the thread permanently unusable.

Client-disconnect behaviour is unchanged and now documented rather than incidental: Agent Protocol runs continue (matching LangGraph Platform's `on_disconnect: "continue"` default for a durable, resumable surface), while AG-UI keeps aborting because it is ephemeral with nothing to reattach to.

Also fixes an unbounded memory leak in the AG-UI handler, which composed `AbortSignal.any([shutdownSignal, requestController.signal])` once per request. A composed signal is retained for the lifetime of its source, and the shutdown signal lives as long as the process, so memory grew with total historical request count and was never freed — roughly 92 MB per 200k requests on Node 24. Both the AG-UI handler and the new run registry use a manual listener with explicit removal instead.

Run tracking is process-local, so the concurrency gate and `/cancel` assume a single replica — a constraint that already applied to Dawn's pod-local threads database and checkpoints, and is now documented in the `dawn-app` chart README.
