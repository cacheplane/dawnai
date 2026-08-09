---
"@dawn-ai/cli": patch
---

Raise `DAWN_E1005` at request time for gated features a runtime cannot serve,
instead of ignoring them silently. A runtime with no filesystem fallbacks — the
shape an edge deployment has — now reports a configured `sandbox` block, a
configured `toolOutput` block, and any route whose skills were recorded at build
time, naming each feature and its config key. Previously the build gate was the
only defense, so an entry composed by hand over `@dawn-ai/cli/fetch` never ran
it and those settings did nothing at all.

Node behavior is unchanged: the guard fires only when a runtime supplies no
filesystem fallbacks, and every Node path supplies them, so an app that
configures a sandbox, tool-output offloading or skills keeps working exactly as
before.

`dawn build` and `dawn check` now also reject `toolOutput` for the `hono`
target. Its keys are plain JSON, so they were inlined into the bundle and then
ignored — the only gated feature whose config crossed the build boundary
intact. An app on the `hono` target that sets `toolOutput` now fails the build
with `DAWN_E1005` instead of deploying a worker that silently never offloads;
remove the key, or drop `"hono"` from `build.targets`.

`dawn check` now also detects a stale `.dawn/build/modules.edge.mjs` when `hono`
is a configured target. An app building for `hono` alone emits no
`modules.mjs`, so the staleness pass previously did nothing for it and a
renamed or deleted route shipped in a stale bundle with no warning.
