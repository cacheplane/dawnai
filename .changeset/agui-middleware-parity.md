---
"@dawn-ai/cli": patch
---

Run app middleware for the `POST /agui/{routeId}` endpoint, matching
`runs/stream` / `runs/wait` / `resume`. A middleware that rejects now blocks an
AG-UI run (returning its status/body), and a middleware that returns `context`
has it threaded into the run — so auth, rate-limiting, and context injection
apply to AG-UI clients too, not just the Agent-Protocol endpoints.
