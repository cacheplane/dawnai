---
"@dawn-ai/cli": patch
---

`dawn build`'s node target now emits `.dawn/build/modules.mjs` — a generated
static module manifest that imports every route, tool, state definition, and
route memory module and inlines their schemas. The built `server.mjs` boots
from it, so production startup performs no route-tree scanning or per-file
discovery. The runtime accepts the manifest via a new optional
`modules` field on `serveRuntime`/`startRuntimeServer` (absent = dynamic
discovery, unchanged), and `dawn check` fails on a manifest that has drifted
from the routes on disk. Static and dynamic serving are verified
response-equivalent end to end. This is the mechanism the upcoming edge build
targets consume.
