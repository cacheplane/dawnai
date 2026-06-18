---
---

Non-shipping: adds an env-guarded `DAWN_DEV_CHILD_BIND_GATE_PATH` test hook to the dev child to de-flake the port-rebinding test. No consumer-facing behavior change (the env var is never set in production).
