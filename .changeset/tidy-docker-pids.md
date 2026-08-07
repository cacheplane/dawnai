---
"@dawn-ai/sandbox": patch
---

Docker sandboxes now prove an OCI exec never started before recovering, coordinate a per-thread keeper recycle that preserves the named workspace volume, and retry once. Lifecycle mutations are ordered, and persisted keeper identities prevent cleanup failures or provider restarts from adopting stale container policy.
