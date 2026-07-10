---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
---

Add a production serve path. `dawn build` now emits a Node/Docker target (a
`server.mjs` over the Dawn runtime plus a hardened Dockerfile) alongside the existing
LangSmith `langgraph.json`, selectable via `build.targets`. The new `dawn start`
command serves the runtime on 0.0.0.0 (HOST/PORT configurable). This is the first
server that runs the Dawn runtime in production, so a deployed app engages the
execution sandbox and serves both Agent Protocol and AG-UI. The langgraphjs/LangSmith
path does not run the runtime and does not engage the sandbox.
