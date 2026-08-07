---
"@dawn-ai/sandbox": patch
---

Docker sandboxes now prove an OCI exec never started before recovering, drain admitted container operations before a per-thread keeper recycle, preserve the named workspace volume, and retry once. Fair shared/exclusive lifecycle coordination prevents replacement from killing peer commands, while persisted keeper identities prevent cleanup failures or provider restarts from adopting stale container policy.
