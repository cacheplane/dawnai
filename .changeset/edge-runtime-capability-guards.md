---
"@dawn-ai/cli": patch
"@dawn-ai/sdk": patch
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

**Action may be required:** `dawn build` and `dawn check` now also reject
`toolOutput` for the `hono` target, so a build that passed before can now fail.
If your `dawn.config.ts` sets `toolOutput` and your `build.targets` includes
`"hono"`, that build stops with `DAWN_E1005` naming the key; remove
`toolOutput`, or drop `"hono"` from `build.targets` and deploy with the `node`
target, which serves offloading normally. An empty `toolOutput: {}` configures
nothing and is not rejected. Nothing is lost by removing it: offloading spills
oversized tool results to a file under `workspace/`, and the edge has no
filesystem, so it never ran there. It was the only gated feature whose config is
plain JSON, which is why it slipped through — the other gated keys are live
objects that get stripped at the build boundary, while these were inlined into
the bundle intact and then ignored at runtime. Node deployments are unaffected.
See the upgrade note at https://dawnai.org/docs/upgrading.

`dawn check` now also detects a stale `.dawn/build/modules.edge.mjs` when `hono`
is a configured target. An app building for `hono` alone emits no
`modules.mjs`, so the staleness pass previously did nothing for it and a
renamed or deleted route shipped in a stale bundle with no warning.

`DAWN_E1005`'s registry title broadens from "Feature unsupported by the build
target" to "Feature unsupported by the build target or runtime", since the code
now has a request-time producer.
