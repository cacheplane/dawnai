---
"@dawn-ai/cli": patch
---

Authorize a thread's row before claiming its run slot on `POST /agui/:routeId`.
The AG-UI handler previously ran `runRegistry.begin` before rechecking the
concrete row, so on the create-race path a caller the recheck ultimately denies
held the victim thread's run slot for the width of that recheck — a client-chosen
thread id let a denied caller brick a concurrent authorized run on the same
thread with a transient `run_in_flight` 409. The row authorization (and the
implicit create, when the turn makes one) now runs before the slot is claimed,
mirroring the Agent Protocol run handlers. Behavior is unchanged for authorized
callers and for hook-less apps.
