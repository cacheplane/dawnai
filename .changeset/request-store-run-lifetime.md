---
"@dawn-ai/cli": patch
"@dawn-ai/sdk": patch
---

Per-request stores are now disposed only after BOTH the response body has
settled and the run that request started has released its slot. Route work
outlives its response on three paths — an aborted AG-UI stream, an abandoned
`/runs/wait`, a cancelled AP stream — and all three keep writing through the
stores a response-triggered teardown would have closed. `close()` also waits
for in-flight disposals, so a host awaiting shutdown knows the pools are shut.

A runtime that reaches a store no layer supplied now answers with a 500 that
names the missing store and carries the new `DAWN_E5301` code, instead of a
generic failure with nothing to diagnose.
