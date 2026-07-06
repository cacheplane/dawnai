<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/core

Filesystem-based route discovery, app config loading, state-field resolution, and typegen primitives that the Dawn CLI builds on.

This is part of [Dawn - the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai).
Use this package for CLI/runtime integration points; application routes usually
import author-facing helpers from `@dawn-ai/sdk`.

Conceptual docs: [Routes](https://dawnai.org/docs/routes),
[Configuration](https://dawnai.org/docs/configuration),
[Workspace Filesystem](https://dawnai.org/docs/workspace),
[Memory](https://dawnai.org/docs/memory), and
[API Reference](https://dawnai.org/docs/api#dawn-aicore).

## Install

```bash
pnpm add @dawn-ai/core
```

```ts
import {
  createCapabilityRegistry,
  createWorkspaceFs,
  discoverRoutes,
  loadDawnConfig,
  renderDawnTypes,
  type DawnConfig,
} from "@dawn-ai/core"
```

## Public Exports

### Capability markers

- `createAgentsMdMarker()`
- `createMemoryMarker()`
- `createMemoryMdMarker()`
- `createPlanningMarker()`
- `createSkillsMarker()`
- `createSubagentsMarker()`
- `createWorkspaceMarker()`
- `BUILT_IN_TOOL_NAMES`

These markers detect route/app files and contribute prompt fragments, tools, or
stream transformers. `createMemoryMarker()` activates only when route memory
context is supplied; `createWorkspaceMarker()` activates when a `workspace/`
directory exists or a runtime `workspaceRoot` is supplied.

### Capability registry and permission gating

- `createCapabilityRegistry()` and `applyCapabilities()` collect marker
  contributions for a route.
- `gateToolOp()` and `wrapToolWithApproval()` apply tool-level approval rules.
- Types include `CapabilityMarker`, `CapabilityMarkerContext`,
  `CapabilityContribution`, `DawnToolDefinition`, `PromptFragment`,
  `StreamTransformer`, `MemoryContext`, `MemoryStoreLike`, and registry result
  types.

### Workspace filesystem

- `createWorkspaceFs(options)` builds the `WorkspaceFs` handle used as `ctx.fs`.
- `CreateWorkspaceFsOptions` accepts `workspaceRoot`, a `FilesystemBackend`,
  permissions, an `AbortSignal`, and `interruptCapable`.

The helper resolves paths relative to `workspaceRoot`, canonicalizes them with
the backend's `realPath`, and applies the same permission gate used by
agent-facing workspace tools.

### Configuration and discovery

- `loadDawnConfig({ appRoot })` loads and normalizes `dawn.config.ts`.
- `config(value)` is the typed identity helper for config files.
- `discoverRoutes(options)` scans the Dawn app directory and returns a route
  manifest.
- `findDawnApp(options)` and `assertDawnRoutesDir(appRoot)` locate app roots.
- `toRouteSegments()`, `isPrivateSegment()`, and `isRouteGroupSegment()` parse
  file-system route segments.
- Types include `DawnConfig`, `LoadedDawnConfig`, `DiscoverRoutesOptions`,
  `DiscoveredDawnApp`, `RouteDefinition`, `RouteManifest`, `RouteSegment`,
  `RouteKind`, and `NormalizedRouteModule`.

### State and typegen

- `resolveStateFields()` resolves route state reducers and defaults.
- `extractToolSchemasForRoute()` and `extractToolTypesForRoute()` inspect route
  tools for schemas and generated type definitions.
- `renderDawnTypes()`, `renderRouteTypes()`, `renderStateTypes()`, and
  `renderToolTypes()` render the generated `dawn:routes` declaration. Some docs
  and audits refer to this group as `renderTypeDefinitions`; there is no single
  exported function by that name.
- Types include `ResolveStateFieldsOptions`, `RouteStateFields`,
  `ExtractToolSchemasOptions`, `ExtractToolTypesOptions`,
  `RouteToolSchemas`, `RouteToolTypes`, `ExtractedToolSchema`,
  `ExtractedToolType`, `ResolvedStateField`, and `StateFieldReducer`.

### Tool scope

- `resolveToolScope()` and `toolOrigin()` decide whether a discovered tool is
  visible to a route.
- Types include `ScopeInput` and `ToolOrigin`.

### Storage type re-export

- `ThreadsStore` is re-exported from `@dawn-ai/sqlite-storage` for config typing.

## Examples

Discover routes and render generated route types:

```ts
import {
  discoverRoutes,
  extractToolTypesForRoute,
  renderDawnTypes,
} from "@dawn-ai/core"

const manifest = await discoverRoutes({ appRoot: process.cwd() })
const toolTypes = await Promise.all(
  manifest.routes.map((route) => extractToolTypesForRoute(route)),
)

const dts = renderDawnTypes(manifest, toolTypes)
```

Create a gated `WorkspaceFs` handle:

```ts
import { createWorkspaceFs } from "@dawn-ai/core"
import { localFilesystem } from "@dawn-ai/workspace"

const fs = createWorkspaceFs({
  workspaceRoot: `${process.cwd()}/workspace`,
  backend: localFilesystem(),
  permissions: undefined,
  signal: new AbortController().signal,
  interruptCapable: false,
})
```

## Notes

`@dawn-ai/core` is intentionally lower level than `@dawn-ai/sdk`. Prefer the SDK
for route code (`agent`, `defineMemory`, `DawnToolContext`, `RuntimeContext`),
and use core when building CLIs, adapters, tests, or runtime integrations.

## License

MIT
