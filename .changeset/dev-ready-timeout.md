---
"@dawn-ai/cli": patch
---

`dawn dev` startup readiness timeout is now configurable via `DAWN_DEV_READY_TIMEOUT_MS` (default unchanged at 5s). Also de-flakes the dev-command disposal test that raced child startup against the readiness window in CI.
