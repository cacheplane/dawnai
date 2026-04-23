# Inferred Tool Types via Codegen

## Goal

Eliminate manually authored tool type aliases (e.g. `HelloTools`) from route files. Dawn generates tool types automatically from properly typed tool functions, so developers get full autocomplete and type safety on `context.tools` without restating input/output shapes.

## Background

Today a route author must manually define a tools type that duplicates information already present in tool files:

```typescript
// tools/greet.ts
export default async (input: unknown) => {
  const { tenant } = input as { readonly tenant: string }
  return { greeting: `Hello, ${tenant}!` }
}

// index.ts — manual duplication
type HelloTools = {
  readonly greet: RuntimeTool<
    { readonly tenant: string },
    { readonly greeting: string }
  >;
};

export async function workflow(
  state: HelloState,
  context: RuntimeContext<HelloTools>,
): Promise<HelloState> { ... }
```

This is error-prone (types drift from implementation), tedious, and unnecessary — Dawn already knows which tools belong to each route at discovery time. The vite plugin already uses the TypeScript compiler API to extract input parameter types for Zod schema generation. The same technique can extract both input and return types and render them into generated type declarations.

## Design

### Tool authoring convention

Tool files use plain typed functions. No `input: unknown`, no wrappers:

```typescript
// src/app/(public)/hello/[tenant]/tools/greet.ts
export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

TypeScript resolves both the input parameter type and the return type from this signature. This is the only supported convention for type extraction — tools with `input: unknown` will produce `unknown` input types in the generated output.

### Type extraction

A new module in `@dawnai.org/core` (`src/typegen/extract-tool-types.ts`) uses the TypeScript compiler API to extract input and return types from each tool file's default export function.

For each route in the manifest, the extractor scans:
- `{routeDir}/tools/*.ts` — route-local tools
- `{appRoot}/src/tools/*.ts` — shared tools

Route-local tools shadow shared tools of the same name, matching runtime behavior in `tool-discovery.ts`.

The extractor produces a per-route record of tool names mapped to their input/output type strings:

```typescript
interface ExtractedToolType {
  readonly name: string
  readonly inputType: string   // e.g. "{ readonly tenant: string }"
  readonly outputType: string  // e.g. "{ readonly greeting: string }"
}

interface RouteToolTypes {
  readonly pathname: string
  readonly tools: readonly ExtractedToolType[]
}
```

The `inputType` and `outputType` fields are TypeScript source text rendered from the compiler's type representation. The rendering walks the resolved type and emits type literal syntax — the same approach as `type-extractor.ts` in the vite plugin, but outputting TypeScript source strings instead of the intermediate `TypeInfo` IR.

When a tool's default export has no parameters, `inputType` is `void`. When the return type cannot be resolved, `outputType` is `unknown`. When there is no default export or it is not callable, the tool is skipped with a warning (not a hard error — this allows partially typed codebases to still get types for the tools that are properly typed).

### Generated output

The existing `dawn.generated.d.ts` is extended. A new `renderDawnTypes` function composes `renderRouteTypes` and `renderToolTypes` to produce both route param types and tool types in a single file:

```typescript
declare module "dawn:routes" {
  export type DawnRoutePath = "/hello/[tenant]";

  export interface DawnRouteParams {
    "/hello/[tenant]": { tenant: string };
  }

  export interface DawnRouteTools {
    "/hello/[tenant]": {
      readonly greet: (
        input: { readonly tenant: string },
      ) => Promise<{ readonly greeting: string }>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
}
```

The `RouteTools<P>` type alias provides the ergonomic lookup. Tool function signatures use the `(input: T) => Promise<O>` form rather than `RuntimeTool<T, O>` to avoid a dependency on `@dawnai.org/sdk` inside the generated declaration file.

### Developer consumption

```typescript
import type { RuntimeContext } from "@dawnai.org/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  context: RuntimeContext<RouteTools<"/hello/[tenant]">>,
): Promise<HelloState> {
  // context.tools.greet is fully typed:
  //   input: { readonly tenant: string }
  //   return: Promise<{ readonly greeting: string }>
  const result = await context.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
```

### Triggers

Three entry points call the same `@dawnai.org/core` generation logic:

**`dawn typegen` (CLI)**
The existing command at `packages/cli/src/commands/typegen.ts` calls the generation logic. No behavioral change other than the output now includes tool types alongside route types.

**`dawn dev` (vite plugin — startup + watch)**
The vite plugin gains a new `configureServer` hook that:
1. Runs typegen once on server start
2. Watches `**/tools/*.ts` and `**/tools/**/*.ts` files for changes
3. Re-runs typegen on change (debounced)

This ensures types stay fresh during development without manual intervention.

**`dawn build` (vite plugin — build)**
The vite plugin gains a `buildStart` hook that runs typegen before compilation, ensuring types are current for the typecheck step.

### Vite plugin changes

The `dawnToolSchemaPlugin` in `packages/vite-plugin/src/index.ts` is extended with two new hooks. The plugin needs access to the app root to call the generation logic, so it accepts an options parameter:

```typescript
export function dawnToolSchemaPlugin(options?: {
  readonly appRoot?: string
}): Plugin {
  return {
    name: "dawn-tool-schema",
    async configureServer(server) {
      // Run typegen on startup
      await runTypegen(appRoot)
      // Watch tools directories, re-run on change (debounced)
      server.watcher.on("change", (file) => { ... })
      server.watcher.on("add", (file) => { ... })
      server.watcher.on("unlink", (file) => { ... })
    },
    async buildStart() {
      await runTypegen(appRoot)
    },
    transform(code, id) {
      // Existing tool schema injection (unchanged)
    },
  }
}
```

The `runTypegen` helper calls `discoverRoutes` + `extractToolTypes` + `renderDawnTypes` from `@dawnai.org/core` and writes `dawn.generated.d.ts`.

### Template updates

**`packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`**

Before:
```typescript
export default async (input: unknown) => {
  const { tenant } = input as { readonly tenant: string }
  return { greeting: `Hello, ${tenant}!` }
}
```

After:
```typescript
export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

**`packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`**

Before:
```typescript
import type { RuntimeContext, RuntimeTool } from "@dawnai.org/sdk"
import type { HelloState } from "./state.js"

type HelloTools = {
  readonly greet: RuntimeTool<
    { readonly tenant: string },
    { readonly greeting: string }
  >;
};

export async function workflow(
  state: HelloState,
  context: RuntimeContext<HelloTools>,
): Promise<HelloState> {
  const result = await context.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
```

After:
```typescript
import type { RuntimeContext } from "@dawnai.org/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  context: RuntimeContext<RouteTools<"/hello/[tenant]">>,
): Promise<HelloState> {
  const result = await context.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
```

**`packages/devkit/templates/app-basic/src/app/dawn.generated.d.ts`**

A pre-generated declaration file ships with the template so types work immediately after scaffold without running typegen first:

```typescript
declare module "dawn:routes" {
  export type DawnRoutePath = "/hello/[tenant]";

  export interface DawnRouteParams {
    "/hello/[tenant]": { tenant: string };
  }

  export interface DawnRouteTools {
    "/hello/[tenant]": {
      readonly greet: (
        input: { readonly tenant: string },
      ) => Promise<{ readonly greeting: string }>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
}
```

### Files modified

**New:**
- `packages/core/src/typegen/extract-tool-types.ts` — TypeScript compiler-based tool type extraction
- `packages/core/src/typegen/render-tool-types.ts` — renders `DawnRouteTools` interface and `RouteTools` type alias
- `packages/devkit/templates/app-basic/src/app/dawn.generated.d.ts` — pre-generated types for template

**Modified:**
- `packages/core/src/typegen/render-route-types.ts` — add `renderDawnTypes` that composes `renderRouteTypes` + `renderToolTypes` into unified output
- `packages/core/src/index.ts` — export new extraction and rendering functions
- `packages/core/src/types.ts` — add `RouteToolTypes` and `ExtractedToolType` interfaces
- `packages/cli/src/commands/typegen.ts` — call updated generation pipeline (tool extraction + unified render)
- `packages/vite-plugin/src/index.ts` — add `configureServer` and `buildStart` hooks for typegen triggering
- `packages/devkit/templates/app-basic/.../tools/greet.ts` — properly typed input parameter
- `packages/devkit/templates/app-basic/.../index.ts` — use `RouteTools` instead of manual `HelloTools`

**Tests:**
- `packages/core/test/typegen/extract-tool-types.test.ts` — extraction from properly typed tools, `unknown` input fallback, return type resolution, shared vs route-local shadowing
- `packages/core/test/typegen/render-tool-types.test.ts` — rendering tool types into declaration source text
- Update existing `render-route-types.test.ts` — verify unified output includes both sections
- Update harness tests and fixtures that assert on generated template output

### What does not change

- `RuntimeContext`, `RuntimeTool`, `ToolRegistry` types in `@dawnai.org/sdk` — unchanged
- Runtime tool discovery (`tool-discovery.ts`) — unchanged, still loads tools dynamically
- Vite plugin's existing `transform` hook for Zod schema injection — unchanged
- Route discovery (`discover-routes.ts`) — unchanged, tool extraction is a separate pass
- `DawnRoutePath` and `DawnRouteParams` generation — unchanged, just composed into the same output
