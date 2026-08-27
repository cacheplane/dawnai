---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
---

**Correction: the edge quickstart named the wrong module manifest, and
`providerPackages` is not exported from `@dawn-ai/cli/fetch`.**

Two errata against the docs and changelog that shipped with the `hono` build
target. `dawn docs` carries the fixes.

- **The `@dawn-ai/cli/fetch` snippet under *Edge runtimes* imported
  `./.dawn/build/modules.mjs`.** That is the `node` target's manifest: it reaches
  `node:path`, `node:url` and `@dawn-ai/cli/runtime`, which pulls in tsx and
  esbuild. Bundled the way `wrangler` bundles — browser platform, Workers export
  conditions — it fails on fourteen unresolved builtins, several of them bare
  (`fs`, `child_process`), so `nodejs_compat` would not have rescued it either.
  The snippet now names `modules.edge.mjs`, which is what the generated
  `app.mjs` already imported. A new ungated test reads that snippet out of the
  docs page and bundles it under those exact conditions, so the two cannot drift
  again; a negative control bundles the `node` manifest and requires it to fail.

- **The same section said the fetch entry and the `hono` target could each be
  used "on its own".** `modules.edge.mjs` is emitted only by the `hono` target,
  so the fetch entry alone leaves you with no edge-safe manifest. The two are
  layered, not alternatives: enable `hono`, then compose the pieces it writes
  however you like. Hand-building the manifest remains possible via the exported
  `buildStaticRouteModule` and `DawnStaticModules`, and the docs now say so
  instead of implying the target is optional.

- **The `0.8.21` changelog entry said `seedModelImporter` and `providerPackages`
  are re-exported from `@dawn-ai/cli/fetch`.** Only `seedModelImporter` is.
  `providerPackages` maps a provider id to its package name — a build-time
  lookup the `hono` target uses to generate the static import switch, and of no
  use to a runtime that needs real static imports rather than package names. It
  is staying where it is rather than being added to the edge entry to make the
  sentence true; it remains public from `@dawn-ai/langchain` for anyone writing
  an import map by hand. Published changelogs are not being rewritten — this is
  the correction.
