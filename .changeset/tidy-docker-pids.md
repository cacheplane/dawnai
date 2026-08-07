---
"@dawn-ai/sandbox": patch
---

Docker sandboxes now detect OCI PID-exhaustion startup failures, coordinate a per-thread keeper recycle that preserves the named workspace volume, and retry once. Lifecycle mutations are ordered to prevent cleanup and reacquire races.
