---
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Internal refactor: the runtime server now runs on a transport-agnostic
`(Request) => Promise<Response>` core (`createRuntimeFetchHandler`, exported from
`@dawn-ai/cli/runtime`), with the Node listener reimplemented as a thin adapter
over it. No behavior change — routes, status codes, headers, JSON error bodies,
SSE framing, streaming incrementality, and shutdown/drain semantics are
preserved (verified against the full suite unchanged plus new wire-parity
tests). The `@dawn-ai/testing` Agent-Protocol harness now drives the fetch core
directly (dropping `light-my-request`). This is the first step of the
deploy-anywhere epic: edge build targets (Cloudflare Workers / Vercel / Hono)
build on this core.
