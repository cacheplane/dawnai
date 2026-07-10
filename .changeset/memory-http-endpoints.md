---
"@dawn-ai/cli": patch
---

Add dev-server HTTP endpoints for memory candidates so a web client can review
durable-memory proposals without the CLI: `GET /memory/candidates`,
`POST /memory/candidates/:id/approve` (candidate → active, 404/409 guarded), and
`POST /memory/candidates/:id/reject`. Backed by the same store methods as
`dawn memory list/approve/reject`.
