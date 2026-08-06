---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
"@dawn-ai/memory": patch
"@dawn-ai/langchain": patch
---

Runtime edge-readiness (deploy-anywhere B3, PR 1 of 3).

New `@dawn-ai/cli/fetch` entry exposes the web-standard runtime with a module
graph that contains none of Dawn's own filesystem, SQLite, or CLI code —
enforced by an esbuild-metafile test that also pins the remaining upstream
`node:` edges so the set can only shrink.

`serveRuntime`/`startRuntimeServer`/`createRuntimeFetchHandler` now accept an
injected checkpointer, threads store, permissions store, memory store,
middleware, and a `DawnConfig` object (`seedDawnConfig`). With everything
supplied, nothing reads `dawn.config.ts` or opens SQLite — including subagent
turns, which previously rebuilt their own stores. On the injected path a
missing store fails loudly at boot instead of silently falling back.

Capability markers read through a new sync `MarkerFs` facade (node
implementation behind `@dawn-ai/core/node`), the subagents descriptor map is
derived from the static module manifest with no dynamic imports, the manifest
now carries `src/middleware.ts`, and `@dawn-ai/memory` gained pure
`./namespace` and `./reconcile` subpaths. Behavior with nothing injected is
unchanged.
