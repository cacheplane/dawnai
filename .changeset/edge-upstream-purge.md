---
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
"@dawn-ai/sdk": patch
"@dawn-ai/permissions": patch
"@dawn-ai/workspace": patch
"@dawn-ai/langchain": patch
---

Purge `node:` imports from the edge module graph (deploy-anywhere B3, PR 2a).

A bundle built from `@dawn-ai/cli/fetch` now links **zero** `node:` specifiers —
previously it linked 33 of them (including `node:fs` and `node:child_process`)
via Dawn's own supporting packages. Because static imports resolve when a module
graph is instantiated, those edges made the bundle require a `node:` shim layer
(Cloudflare Workers with `nodejs_compat`) even though the injected request path
never called them. The artifact is now runtime-agnostic, verified by an esbuild
purity test that bundles on the `neutral` and `browser` platforms with no `node:`
externals and asserts an empty graph, plus a negative control proving the check
still fails against the CLI entry.

**Node-only exports moved to `/node` subpaths.** They are unchanged in behavior;
only the import specifier differs:

- `@dawn-ai/core` → `@dawn-ai/core/node`: `discoverRoutes`, `findDawnApp`,
  `assertDawnRoutesDir`, `extractToolSchemasForRoute`, `extractToolTypesForRoute`,
  `registerTsxLoader`
- `@dawn-ai/permissions` → `@dawn-ai/permissions/node`: `createPermissionsStore`
- `@dawn-ai/workspace` → `@dawn-ai/workspace/node`: `localFilesystem`, `localExec`

**New:** `@dawn-ai/sdk/pure` (pure path/hash helpers, parity-tested against
`node:path`/`node:crypto`); `@dawn-ai/core` gains `registerConfigLoader` and the
`DawnConfigLoader` type; `@dawn-ai/core/node` gains `registerNodeConfigLoader`,
`loadDawnConfigUncached`, and `nodeLoadRouteDescription`. `CapabilityMarkerContext`
gains optional `backendFactories` and `loadRouteDescription` — capability markers
no longer reach for node implementations by static import, and throw a named error
when a runtime supplies neither an instance nor a factory.

**Behavior change:** `createWorkspaceFs` now requires an absolute, POSIX-normalized
`workspaceRoot` and throws a named error otherwise. Previously a relative root
silently resolved against `process.cwd()`. Every in-repo caller already passes an
absolute path; the host lane canonicalizes before calling core. This is
fail-closed — it cannot widen the workspace path jail, only reject earlier and
more loudly.
