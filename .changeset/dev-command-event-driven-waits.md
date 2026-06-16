---
---

Test-only: replace the dev-command test harness's poll-with-nested-timeouts readiness detection with event-driven waits (resolve the instant the dev process emits its `Dawn dev ready at` / `Restarting Dawn dev server` markers, with a single generous backstop and fast reject-on-exit). Eliminates the chronic dev-server-restart timeout flake. No package or runtime changes.
