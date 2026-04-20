# Inferred Tool Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate tool types automatically from properly typed tool functions so route files get full `context.tools` type safety without manual type aliases.

**Architecture:** A new `@dawn/core` module uses the TypeScript compiler API to extract input and return types from tool file default exports, then renders them into the existing `dawn.generated.d.ts` alongside route path/param types. The vite plugin triggers typegen on dev startup and file watch. The `dawn typegen` CLI command remains for standalone use.

**Tech Stack:** TypeScript compiler API (`typescript` package), Vitest, existing `@dawn/core` typegen pipeline

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/typegen/extract-tool-types.ts` | **New.** Uses TS compiler API to extract input + return types from tool default exports. Returns `RouteToolTypes[]`. |
| `packages/core/src/typegen/render-tool-types.ts` | **New.** Renders `DawnRouteTools` interface and `RouteTools` type alias as TypeScript source text. |
| `packages/core/src/typegen/render-route-types.ts` | **Modified.** Add `renderDawnTypes()` that composes route types + tool types into one `declare module`. |
| `packages/core/src/types.ts` | **Modified.** Add `ExtractedToolType` and `RouteToolTypes` interfaces. |
| `packages/core/src/index.ts` | **Modified.** Export new functions and types. |
| `packages/core/package.json` | **Modified.** Add `typescript` dependency. |
| `packages/cli/src/commands/typegen.ts` | **Modified.** Call `extractToolTypes` + `renderDawnTypes` instead of `renderRouteTypes`. |
| `packages/cli/src/commands/verify.ts` | **Modified.** Call updated rendering pipeline. |
| `packages/vite-plugin/src/index.ts` | **Modified.** Add `configureServer` and `buildStart` hooks to trigger typegen. |
| `packages/vite-plugin/package.json` | **Modified.** Add `@dawn/core` dependency. |
| `packages/devkit/templates/app-basic/.../tools/greet.ts` | **Modified.** Properly typed input parameter. |
| `packages/devkit/templates/app-basic/.../index.ts` | **Modified.** Use `RouteTools` instead of manual `HelloTools`. |
| `packages/devkit/templates/app-basic/src/app/dawn.generated.d.ts` | **New.** Pre-generated types for template. |
| `packages/core/test/extract-tool-types.test.ts` | **New.** Tests for tool type extraction. |
| `packages/core/test/render-tool-types.test.ts` | **New.** Tests for tool type rendering. |
| `test/generated/fixtures/basic.expected.json` | **Modified.** Updated `typegenOutput` and `renderedBytes`. |
| `test/generated/fixtures/custom-app-dir.expected.json` | **Modified.** Updated `typegenOutput` and `renderedBytes`. |

---

### Task 1: Add TypeScript dependency to `@dawn/core`

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add `typescript` to dependencies**

In `packages/core/package.json`, add `typescript` to the `dependencies` object:

```json
"dependencies": {
  "@dawn/sdk": "workspace:*",
  "tsx": "^4.8.1",
  "typescript": "5.8.3"
}
```

Use the same version as `packages/vite-plugin/package.json` (`5.8.3`).

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: lockfile updates, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore: add typescript dependency to @dawn/core for tool type extraction"
```

---

### Task 2: Add `ExtractedToolType` and `RouteToolTypes` types

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add types to `packages/core/src/types.ts`**

Add at the end of the file:

```typescript
export interface ExtractedToolType {
  readonly name: string
  readonly inputType: string
  readonly outputType: string
}

export interface RouteToolTypes {
  readonly pathname: string
  readonly tools: readonly ExtractedToolType[]
}
```

- [ ] **Step 2: Export from `packages/core/src/index.ts`**

Add `ExtractedToolType` and `RouteToolTypes` to the existing type export:

```typescript
export type {
  DawnConfig,
  DiscoveredDawnApp,
  DiscoverRoutesOptions,
  ExtractedToolType,
  FindDawnAppOptions,
  LoadDawnConfigOptions,
  LoadedDawnConfig,
  RouteDefinition,
  RouteKind,
  RouteManifest,
  RouteSegment,
  RouteToolTypes,
} from "./types.js"
```

- [ ] **Step 3: Verify build**

Run: `cd packages/core && pnpm build`
Expected: Builds successfully.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts
git commit -m "feat: add ExtractedToolType and RouteToolTypes interfaces"
```

---

### Task 3: Implement tool type extraction

**Files:**
- Create: `packages/core/src/typegen/extract-tool-types.ts`
- Create: `packages/core/test/extract-tool-types.test.ts`
- Modify: `packages/core/src/index.ts`

This is the core of the feature. The extractor uses the TypeScript compiler API to resolve input parameter and return types from tool file default exports, then renders them as TypeScript source strings.

- [ ] **Step 1: Write the failing test for basic extraction**

Create `packages/core/test/extract-tool-types.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { extractToolTypesForRoute } from "../src/typegen/extract-tool-types"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true })
    tempDir = undefined
  }
})

async function createTempToolDir(tools: Record<string, string>): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "dawn-tool-extract-"))
  const toolsDir = join(tempDir, "tools")
  await mkdir(toolsDir, { recursive: true })

  for (const [name, source] of Object.entries(tools)) {
    await writeFile(join(toolsDir, `${name}.ts`), source, "utf8")
  }

  return tempDir
}

describe("extractToolTypesForRoute", () => {
  test("extracts input and return types from a properly typed tool", async () => {
    const routeDir = await createTempToolDir({
      greet: `export default async (input: { readonly tenant: string }) => {
  return { greeting: \`Hello, \${input.tenant}!\` }
}`,
    })

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        name: "greet",
        inputType: "{ readonly tenant: string; }",
        outputType: "{ greeting: string; }",
      },
    ])
  })

  test("extracts multiple tools sorted by name", async () => {
    const routeDir = await createTempToolDir({
      beta: `export default async (input: { id: number }) => {
  return { found: true }
}`,
      alpha: `export default async (input: { name: string }) => {
  return { ok: true }
}`,
    })

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe("alpha")
    expect(result[1]!.name).toBe("beta")
  })

  test("returns empty array when no tools directory exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dawn-tool-extract-"))

    const result = await extractToolTypesForRoute({
      routeDir: tempDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([])
  })

  test("uses unknown for untyped input parameter", async () => {
    const routeDir = await createTempToolDir({
      greet: `export default async (input: unknown) => {
  return { greeting: "hello" }
}`,
    })

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        name: "greet",
        inputType: "unknown",
        outputType: "{ greeting: string; }",
      },
    ])
  })

  test("extracts void input when tool has no parameters", async () => {
    const routeDir = await createTempToolDir({
      ping: `export default async () => {
  return { pong: true }
}`,
    })

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        name: "ping",
        inputType: "void",
        outputType: "{ pong: boolean; }",
      },
    ])
  })

  test("route-local tools shadow shared tools of the same name", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dawn-tool-extract-"))

    const sharedDir = join(tempDir, "shared")
    const sharedToolsDir = join(sharedDir, "tools")
    await mkdir(sharedToolsDir, { recursive: true })
    await writeFile(
      join(sharedToolsDir, "greet.ts"),
      `export default async (input: { name: string }) => {
  return { greeting: "shared" }
}`,
      "utf8",
    )

    const routeDir = join(tempDir, "route")
    const routeToolsDir = join(routeDir, "tools")
    await mkdir(routeToolsDir, { recursive: true })
    await writeFile(
      join(routeToolsDir, "greet.ts"),
      `export default async (input: { tenant: string }) => {
  return { greeting: "local" }
}`,
      "utf8",
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: sharedDir,
    })

    expect(result).toEqual([
      {
        name: "greet",
        inputType: "{ tenant: string; }",
        outputType: "{ greeting: string; }",
      },
    ])
  })

  test("merges shared and route-local tools", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dawn-tool-extract-"))

    const sharedDir = join(tempDir, "shared")
    const sharedToolsDir = join(sharedDir, "tools")
    await mkdir(sharedToolsDir, { recursive: true })
    await writeFile(
      join(sharedToolsDir, "shared-tool.ts"),
      `export default async (input: { x: number }) => {
  return { result: 1 }
}`,
      "utf8",
    )

    const routeDir = join(tempDir, "route")
    const routeToolsDir = join(routeDir, "tools")
    await mkdir(routeToolsDir, { recursive: true })
    await writeFile(
      join(routeToolsDir, "local-tool.ts"),
      `export default async (input: { y: string }) => {
  return { result: "ok" }
}`,
      "utf8",
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: sharedDir,
    })

    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe("local-tool")
    expect(result[1]!.name).toBe("shared-tool")
  })

  test("skips .d.ts files", async () => {
    const routeDir = await createTempToolDir({
      greet: `export default async (input: { tenant: string }) => {
  return { greeting: "hello" }
}`,
    })
    await writeFile(
      join(routeDir, "tools", "types.d.ts"),
      `export type Foo = string`,
      "utf8",
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("greet")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- extract-tool-types`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extractToolTypesForRoute`**

Create `packages/core/src/typegen/extract-tool-types.ts`:

```typescript
import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"

import ts from "typescript"

import type { ExtractedToolType } from "../types.js"

interface ExtractToolTypesOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
}

export async function extractToolTypesForRoute(
  options: ExtractToolTypesOptions,
): Promise<readonly ExtractedToolType[]> {
  const sharedTools = options.sharedToolsDir
    ? await discoverToolFiles(join(options.sharedToolsDir, "tools"))
    : []
  const routeLocalTools = await discoverToolFiles(join(options.routeDir, "tools"))

  const toolFiles = new Map<string, string>()

  for (const file of sharedTools) {
    toolFiles.set(basename(file, ".ts"), file)
  }

  for (const file of routeLocalTools) {
    toolFiles.set(basename(file, ".ts"), file)
  }

  if (toolFiles.size === 0) {
    return []
  }

  const filePaths = [...toolFiles.values()]
  const program = createProgram(filePaths)
  const checker = program.getTypeChecker()

  const extracted: ExtractedToolType[] = []

  for (const [name, filePath] of [...toolFiles.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sourceFile = program.getSourceFile(filePath)
    if (!sourceFile) continue

    const tool = extractFromSourceFile(sourceFile, checker)
    if (!tool) continue

    extracted.push({ name, ...tool })
  }

  return extracted
}

async function discoverToolFiles(toolsDir: string): Promise<readonly string[]> {
  const entries = await readdir(toolsDir, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return []
  }

  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => join(toolsDir, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

function createProgram(filePaths: readonly string[]): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts"],
  }

  return ts.createProgram([...filePaths], options)
}

function extractFromSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): { readonly inputType: string; readonly outputType: string } | null {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) return null

  const exports = checker.getExportsOfModule(moduleSymbol)
  const defaultExport = exports.find((e) => e.escapedName === "default")
  if (!defaultExport) return null

  const exportType = checker.getTypeOfSymbolAtLocation(defaultExport, sourceFile)
  const signatures = checker.getSignaturesOfType(exportType, ts.SignatureKind.Call)
  if (signatures.length === 0) return null

  const signature = signatures[0]!
  const params = signature.getParameters()

  let inputType: string
  if (params.length === 0) {
    inputType = "void"
  } else {
    const firstParam = params[0]!
    const paramType = checker.getTypeOfSymbolAtLocation(firstParam, sourceFile)
    inputType = checker.typeToString(
      paramType,
      sourceFile,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType,
    )
  }

  const returnType = checker.getReturnTypeOfSignature(signature)
  const unwrappedReturn = unwrapPromise(returnType, checker)
  const outputType = checker.typeToString(
    unwrappedReturn,
    sourceFile,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType,
  )

  return { inputType, outputType }
}

function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  const symbol = type.getSymbol()
  if (symbol?.getName() === "Promise") {
    const typeArgs = (type as ts.TypeReference).typeArguments
    if (typeArgs && typeArgs.length === 1 && typeArgs[0]) {
      return typeArgs[0]
    }
  }
  return type
}
```

- [ ] **Step 4: Export from index**

Add to `packages/core/src/index.ts`:

```typescript
export { extractToolTypesForRoute } from "./typegen/extract-tool-types.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm test -- extract-tool-types`
Expected: All tests pass. If `checker.typeToString` produces slightly different formatting (e.g. `{ readonly tenant: string; }` vs `{ readonly tenant: string }`), update test expectations to match the actual compiler output.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/typegen/extract-tool-types.ts packages/core/test/extract-tool-types.test.ts packages/core/src/index.ts
git commit -m "feat: implement tool type extraction using TypeScript compiler API"
```

---

### Task 4: Implement tool type rendering

**Files:**
- Create: `packages/core/src/typegen/render-tool-types.ts`
- Create: `packages/core/test/render-tool-types.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/render-tool-types.test.ts`:

```typescript
import { describe, expect, test } from "vitest"

import { renderToolTypes } from "../src/typegen/render-tool-types"
import type { RouteToolTypes } from "../src/types"

describe("renderToolTypes", () => {
  test("renders tool types for a single route with one tool", () => {
    const routeTools: readonly RouteToolTypes[] = [
      {
        pathname: "/hello/[tenant]",
        tools: [
          {
            name: "greet",
            inputType: "{ readonly tenant: string; }",
            outputType: "{ greeting: string; }",
          },
        ],
      },
    ]

    expect(renderToolTypes(routeTools)).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {
        "/hello/[tenant]": {
          readonly greet: (input: { readonly tenant: string; }) => Promise<{ greeting: string; }>;
        };
      }

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];"
    `)
  })

  test("renders multiple tools for a route sorted by name", () => {
    const routeTools: readonly RouteToolTypes[] = [
      {
        pathname: "/hello/[tenant]",
        tools: [
          {
            name: "farewell",
            inputType: "{ name: string; }",
            outputType: "{ message: string; }",
          },
          {
            name: "greet",
            inputType: "{ tenant: string; }",
            outputType: "{ greeting: string; }",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).toContain("readonly farewell:")
    expect(result).toContain("readonly greet:")
  })

  test("renders empty interface when no routes have tools", () => {
    const routeTools: readonly RouteToolTypes[] = []

    expect(renderToolTypes(routeTools)).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {}

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];"
    `)
  })

  test("renders void input as no-arg function", () => {
    const routeTools: readonly RouteToolTypes[] = [
      {
        pathname: "/ping",
        tools: [
          {
            name: "ping",
            inputType: "void",
            outputType: "{ pong: boolean; }",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).toContain("readonly ping: () => Promise<{ pong: boolean; }>;")
  })

  test("skips routes with no tools", () => {
    const routeTools: readonly RouteToolTypes[] = [
      {
        pathname: "/no-tools",
        tools: [],
      },
      {
        pathname: "/has-tools",
        tools: [
          {
            name: "action",
            inputType: "{ x: number; }",
            outputType: "{ ok: boolean; }",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).not.toContain("/no-tools")
    expect(result).toContain("/has-tools")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- render-tool-types`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `renderToolTypes`**

Create `packages/core/src/typegen/render-tool-types.ts`:

```typescript
import type { RouteToolTypes } from "../types.js"

export function renderToolTypes(routeTools: readonly RouteToolTypes[]): string {
  const routesWithTools = routeTools.filter((route) => route.tools.length > 0)

  if (routesWithTools.length === 0) {
    return [
      "  export interface DawnRouteTools {}",
      "",
      "  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];",
    ].join("\n")
  }

  const entries = routesWithTools.map((route) => {
    const toolLines = route.tools.map((tool) => {
      const signature =
        tool.inputType === "void"
          ? `() => Promise<${tool.outputType}>`
          : `(input: ${tool.inputType}) => Promise<${tool.outputType}>`
      return `      readonly ${tool.name}: ${signature};`
    })
    return [`    ${JSON.stringify(route.pathname)}: {`, ...toolLines, "    };"].join("\n")
  })

  return [
    "  export interface DawnRouteTools {",
    ...entries,
    "  }",
    "",
    "  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];",
  ].join("\n")
}
```

- [ ] **Step 4: Export from index**

Add to `packages/core/src/index.ts`:

```typescript
export { renderToolTypes } from "./typegen/render-tool-types.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm test -- render-tool-types`
Expected: All tests pass. Adjust inline snapshots if whitespace differs.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/typegen/render-tool-types.ts packages/core/test/render-tool-types.test.ts packages/core/src/index.ts
git commit -m "feat: implement tool type rendering for dawn.generated.d.ts"
```

---

### Task 5: Compose unified `renderDawnTypes` function

**Files:**
- Modify: `packages/core/src/typegen/render-route-types.ts`
- Modify: `packages/core/test/render-route-types.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Add a new test to `packages/core/test/render-route-types.test.ts`:

```typescript
import { renderDawnTypes } from "../src/typegen/render-route-types"
import type { RouteToolTypes } from "../src/types"

// ... inside existing describe block, add:

describe("renderDawnTypes", () => {
  test("composes route types and tool types into single declare module", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello/[tenant]",
          pathname: "/hello/[tenant]",
          kind: "workflow",
          entryFile: "/tmp/example-app/src/app/(public)/hello/[tenant]/index.ts",
          routeDir: "/tmp/example-app/src/app/(public)/hello/[tenant]",
          segments: [
            { kind: "static", raw: "hello" },
            { kind: "dynamic", name: "tenant", raw: "[tenant]" },
          ],
        },
      ],
    }

    const toolTypes: readonly RouteToolTypes[] = [
      {
        pathname: "/hello/[tenant]",
        tools: [
          {
            name: "greet",
            inputType: "{ readonly tenant: string; }",
            outputType: "{ greeting: string; }",
          },
        ],
      },
    ]

    const result = renderDawnTypes(manifest, toolTypes)

    expect(result).toContain('declare module "dawn:routes"')
    expect(result).toContain("export type DawnRoutePath")
    expect(result).toContain("export interface DawnRouteParams")
    expect(result).toContain("export interface DawnRouteTools")
    expect(result).toContain("export type RouteTools<P extends DawnRoutePath>")
    // Should be a single declare module block, not two
    expect(result.match(/declare module/g)).toHaveLength(1)
  })

  test("renders empty tool interface when no tools exist", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [],
    }

    const result = renderDawnTypes(manifest, [])
    expect(result).toContain("export interface DawnRouteTools {}")
    expect(result).toContain("export type RouteTools<P extends DawnRoutePath>")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- render-route-types`
Expected: FAIL — `renderDawnTypes` not exported.

- [ ] **Step 3: Add `renderDawnTypes` to `render-route-types.ts`**

Add to the end of `packages/core/src/typegen/render-route-types.ts`:

```typescript
import type { RouteToolTypes } from "../types.js"
import { renderToolTypes } from "./render-tool-types.js"

export function renderDawnTypes(
  manifest: RouteManifest,
  toolTypes: readonly RouteToolTypes[],
): string {
  const pathUnion =
    manifest.routes.length > 0
      ? manifest.routes.map((route) => JSON.stringify(route.pathname)).join(" | ")
      : "never"

  const paramLines = manifest.routes.map((route) => {
    const params = renderParamsForSegments(route.segments)
    return `  ${JSON.stringify(route.pathname)}: ${params};`
  })

  const paramBlock =
    paramLines.length === 0
      ? "  export interface DawnRouteParams {}"
      : ["  export interface DawnRouteParams {", ...paramLines, "  }"].join("\n")

  const toolBlock = renderToolTypes(toolTypes)

  return [
    'declare module "dawn:routes" {',
    `  export type DawnRoutePath = ${pathUnion};`,
    "",
    paramBlock,
    "",
    toolBlock,
    "}",
    "",
  ].join("\n")
}
```

Note: the import for `RouteManifest` and `RouteSegment` is already present via the existing `import type { RouteManifest, RouteSegment } from "../types.js"` at the top of the file.

- [ ] **Step 4: Export from index**

Update `packages/core/src/index.ts` to also export `renderDawnTypes`:

```typescript
export { renderDawnTypes, renderRouteTypes } from "./typegen/render-route-types.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm test -- render-route-types`
Expected: All tests pass (both old and new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/typegen/render-route-types.ts packages/core/test/render-route-types.test.ts packages/core/src/index.ts
git commit -m "feat: add renderDawnTypes composing route + tool types"
```

---

### Task 6: Update `dawn typegen` CLI command

**Files:**
- Modify: `packages/cli/src/commands/typegen.ts`

- [ ] **Step 1: Update the typegen command to extract tool types and use `renderDawnTypes`**

Replace the content of `runTypegenCommand` in `packages/cli/src/commands/typegen.ts`:

```typescript
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  discoverRoutes,
  extractToolTypesForRoute,
  findDawnApp,
  renderDawnTypes,
} from "@dawn/core"
import type { RouteToolTypes } from "@dawn/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"

interface TypegenOptions {
  readonly cwd?: string
}

const OUTPUT_FILE = "dawn.generated.d.ts"

export function registerTypegenCommand(program: Command, io: CommandIo): void {
  program
    .command("typegen")
    .description("Generate Dawn route and tool types")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .action(async (options: TypegenOptions) => {
      await runTypegenCommand(options, io)
    })
}

export async function runTypegenCommand(options: TypegenOptions, io: CommandIo): Promise<void> {
  try {
    const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
    const manifest = await discoverRoutes({ appRoot: app.appRoot })

    const sharedToolsDir = join(app.appRoot, "src")

    const routeToolTypes: RouteToolTypes[] = []
    for (const route of manifest.routes) {
      const tools = await extractToolTypesForRoute({
        routeDir: route.routeDir,
        sharedToolsDir,
      })
      routeToolTypes.push({ pathname: route.pathname, tools })
    }

    const outputPath = join(app.routesDir, OUTPUT_FILE)

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, renderDawnTypes(manifest, routeToolTypes), "utf8")

    writeLine(io.stdout, `Wrote route types to ${outputPath}`)
  } catch (error) {
    throw new CliError(`Failed to generate route types: ${formatErrorMessage(error)}`)
  }
}
```

- [ ] **Step 2: Run existing typegen tests**

Run: `cd packages/cli && pnpm test -- typegen-command`
Expected: Tests pass. The `Wrote route types` message is unchanged.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/typegen.ts
git commit -m "feat: update dawn typegen to include tool types"
```

---

### Task 7: Update `dawn verify` command

**Files:**
- Modify: `packages/cli/src/commands/verify.ts`

- [ ] **Step 1: Update verify to use `renderDawnTypes`**

In `packages/cli/src/commands/verify.ts`, update the typegen section (around lines 153–165). Change the import to include `extractToolTypesForRoute` and `renderDawnTypes`, and replace the `renderRouteTypes` call:

Update the import at the top:
```typescript
import {
  discoverRoutes,
  extractToolTypesForRoute,
  findDawnApp,
  renderDawnTypes,
} from "@dawn/core"
import type { RouteToolTypes } from "@dawn/core"
```

Replace the typegen section:
```typescript
  let renderedTypes: string

  try {
    const sharedToolsDir = join(app.appRoot, "src")
    const routeToolTypes: RouteToolTypes[] = []
    for (const route of manifest.routes) {
      const tools = await extractToolTypesForRoute({
        routeDir: route.routeDir,
        sharedToolsDir,
      })
      routeToolTypes.push({ pathname: route.pathname, tools })
    }
    renderedTypes = renderDawnTypes(manifest, routeToolTypes)
  } catch (error) {
    return createVerifyFailureResult(app.appRoot, checks, "typegen", error)
  }
```

Add the `join` import from `node:path` if not already present.

- [ ] **Step 2: Run existing verify tests**

Run: `cd packages/cli && pnpm test -- verify-command`
Expected: Tests pass. The `renderedBytes` value may change — that's expected and will be addressed in the fixture update task.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/verify.ts
git commit -m "feat: update dawn verify to include tool types in typegen check"
```

---

### Task 8: Update template tool and route files

**Files:**
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`
- Create: `packages/devkit/templates/app-basic/src/app/dawn.generated.d.ts`

- [ ] **Step 1: Update `greet.ts` to use proper types**

Replace the content of `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/tools/greet.ts`:

```typescript
export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

- [ ] **Step 2: Update route `index.ts` to use `RouteTools`**

Replace the content of `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts`:

```typescript
import type { RuntimeContext } from "@dawn/sdk"
import type { RouteTools } from "dawn:routes"

import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  context: RuntimeContext<RouteTools<"/hello/[tenant]">>,
): Promise<HelloState> {
  const result = await context.tools.greet({ tenant: state.tenant })

  return {
    ...state,
    greeting: result.greeting,
  }
}
```

- [ ] **Step 3: Generate the pre-baked `dawn.generated.d.ts`**

Run typegen against the template to produce the exact output, then create the file. First, determine the exact output by running:

```bash
cd /Users/blove/repos/dawn && pnpm build
```

Then manually construct the file based on the template's route structure. Create `packages/devkit/templates/app-basic/src/app/dawn.generated.d.ts`:

```typescript
declare module "dawn:routes" {
  export type DawnRoutePath = "/hello/[tenant]";

  export interface DawnRouteParams {
  "/hello/[tenant]": { tenant: string };
  }

  export interface DawnRouteTools {
    "/hello/[tenant]": {
      readonly greet: (input: { readonly tenant: string; }) => Promise<{ greeting: string; }>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
}
```

Note: The exact formatting of the generated type strings (e.g. semicolons after properties) must match what the TypeScript compiler's `typeToString` produces. Run `dawn typegen` on a test app with the updated tool to see the exact output, then use that.

- [ ] **Step 4: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/tools/greet.ts packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/index.ts packages/devkit/templates/app-basic/src/app/dawn.generated.d.ts
git commit -m "feat: update template to use inferred tool types via RouteTools"
```

---

### Task 9: Wire vite plugin to trigger typegen

**Files:**
- Modify: `packages/vite-plugin/src/index.ts`
- Modify: `packages/vite-plugin/package.json`

- [ ] **Step 1: Add `@dawn/core` dependency to vite-plugin**

In `packages/vite-plugin/package.json`, add `@dawn/core` to dependencies:

```json
"dependencies": {
  "@dawn/core": "workspace:*",
  "typescript": "5.8.3"
}
```

Run: `pnpm install`

- [ ] **Step 2: Update the plugin to accept options and add typegen hooks**

Update `packages/vite-plugin/src/index.ts`. Add the typegen triggering logic alongside the existing `dawnToolSchemaPlugin`:

```typescript
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  discoverRoutes,
  extractToolTypesForRoute,
  findDawnApp,
  renderDawnTypes,
} from "@dawn/core"
import type { RouteToolTypes } from "@dawn/core"

import { extractJsDoc } from "./jsdoc-extractor.js"
import { extractParameterType } from "./type-extractor.js"
import { generateZodSchema } from "./zod-generator.js"

// Keep all existing re-exports
export { extractJsDoc, type JsDocInfo } from "./jsdoc-extractor.js"
export { extractParameterType } from "./type-extractor.js"
export { generateZodSchema } from "./zod-generator.js"

const TOOLS_DIR_PATTERN = /\/tools\/[^/]+\.ts$/
const OUTPUT_FILE = "dawn.generated.d.ts"

interface DawnPluginOptions {
  readonly appRoot?: string
}

export function dawnToolSchemaPlugin(options?: DawnPluginOptions): {
  name: string
  configureServer?(server: {
    readonly watcher: {
      on(event: string, callback: (path: string) => void): void
    }
  }): void | Promise<void>
  buildStart?(): void | Promise<void>
  transform(code: string, id: string): { code: string } | null
} {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  return {
    name: "dawn-tool-schema",

    async configureServer(server) {
      await runTypegen(options?.appRoot)

      const debouncedTypegen = () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          void runTypegen(options?.appRoot)
        }, 300)
      }

      const isToolFile = (path: string) => TOOLS_DIR_PATTERN.test(path)

      server.watcher.on("change", (path) => {
        if (isToolFile(path)) debouncedTypegen()
      })
      server.watcher.on("add", (path) => {
        if (isToolFile(path)) debouncedTypegen()
      })
      server.watcher.on("unlink", (path) => {
        if (isToolFile(path)) debouncedTypegen()
      })
    },

    async buildStart() {
      await runTypegen(options?.appRoot)
    },

    transform(code: string, id: string): { code: string } | null {
      if (!TOOLS_DIR_PATTERN.test(id)) {
        return null
      }

      const transformed = transformToolSource(code, id)

      if (!transformed) {
        return null
      }

      return { code: transformed }
    },
  }
}

async function runTypegen(appRoot?: string): Promise<void> {
  try {
    const app = await findDawnApp(appRoot ? { appRoot } : {})
    const manifest = await discoverRoutes({ appRoot: app.appRoot })

    const sharedToolsDir = join(app.appRoot, "src")
    const routeToolTypes: RouteToolTypes[] = []

    for (const route of manifest.routes) {
      const tools = await extractToolTypesForRoute({
        routeDir: route.routeDir,
        sharedToolsDir,
      })
      routeToolTypes.push({ pathname: route.pathname, tools })
    }

    const outputPath = join(app.routesDir, OUTPUT_FILE)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, renderDawnTypes(manifest, routeToolTypes), "utf8")
  } catch {
    // Silently ignore typegen errors during dev — the CLI command gives explicit errors
  }
}

export function transformToolSource(source: string, fileName: string): string | null {
  const hasExistingDescription = /export\s+const\s+description\s*=/.test(source)
  const hasExistingSchema = /export\s+const\s+schema\s*=/.test(source)

  if (hasExistingDescription && hasExistingSchema) {
    return null
  }

  const jsDoc = extractJsDoc(source, fileName)
  const typeInfo = extractParameterType(source, fileName)

  const needsDescription = !hasExistingDescription && jsDoc.description !== undefined
  const needsSchema = !hasExistingSchema && typeInfo !== null && typeInfo.kind !== "unknown"

  if (!needsDescription && !needsSchema) {
    return null
  }

  const injections: string[] = []

  if (needsDescription) {
    injections.push(`export const description = ${JSON.stringify(jsDoc.description)}`)
  }

  if (needsSchema && typeInfo) {
    const paramDescriptions = new Map(Object.entries(jsDoc.params))
    if (typeInfo.kind === "object") {
      for (const prop of typeInfo.properties) {
        const desc = paramDescriptions.get(prop.name)
        if (desc && !prop.description) {
          ;(prop as { description?: string }).description = desc
        }
      }
    }
    const zodCode = generateZodSchema(typeInfo, paramDescriptions)
    injections.push(`import { z } from "zod"`)
    injections.push(`export const schema = ${zodCode}`)
  }

  return `${injections.join("\n")}\n${source}`
}
```

- [ ] **Step 3: Run existing vite-plugin tests**

Run: `cd packages/vite-plugin && pnpm test`
Expected: All existing tests pass. The `transformToolSource` function is unchanged; only the plugin wrapper gained new hooks.

- [ ] **Step 4: Commit**

```bash
git add packages/vite-plugin/src/index.ts packages/vite-plugin/package.json pnpm-lock.yaml
git commit -m "feat: wire vite plugin to trigger typegen on dev start and file watch"
```

---

### Task 10: Update harness test fixtures

**Files:**
- Modify: `test/generated/fixtures/basic.expected.json`
- Modify: `test/generated/fixtures/custom-app-dir.expected.json`

The typegen output now includes tool types, which changes both the `typegenOutput` string and the `renderedBytes` count in the expected fixtures.

- [ ] **Step 1: Build the project**

Run: `pnpm build`
Expected: Builds successfully.

- [ ] **Step 2: Run the generated app tests to see the new expected values**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run test/generated/run-generated-app.test.ts`

This will likely fail with a diff showing the new `typegenOutput` and `renderedBytes`. Copy the actual values from the test output.

- [ ] **Step 3: Update `basic.expected.json`**

Update the `typegenOutput` field in `test/generated/fixtures/basic.expected.json` to include the tool types. The value will be the full `dawn.generated.d.ts` content as a JSON-escaped string. Also update `renderedBytes` to match the new byte count.

The `typegenOutput` will look something like (exact formatting depends on compiler output):

```
"typegenOutput": "declare module \"dawn:routes\" {\n  export type DawnRoutePath = \"/hello/[tenant]\";\n\n  export interface DawnRouteParams {\n  \"/hello/[tenant]\": { tenant: string };\n  }\n\n  export interface DawnRouteTools {\n    \"/hello/[tenant]\": {\n      readonly greet: (input: { readonly tenant: string; }) => Promise<{ greeting: string; }>;\n    };\n  }\n\n  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];\n}\n"
```

And update `renderedBytes` to the byte length of that string.

- [ ] **Step 4: Update `custom-app-dir.expected.json`**

Update `test/generated/fixtures/custom-app-dir.expected.json` similarly. The custom-app-dir route has no tools, so its `DawnRouteTools` will be empty:

```
"typegenOutput": "declare module \"dawn:routes\" {\n  export type DawnRoutePath = \"/support/[tenant]\";\n\n  export interface DawnRouteParams {\n  \"/support/[tenant]\": { tenant: string };\n  }\n\n  export interface DawnRouteTools {}\n\n  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];\n}\n"
```

Update `renderedBytes` accordingly.

- [ ] **Step 5: Re-run the generated app tests**

Run: `cd /Users/blove/repos/dawn && pnpm vitest --run test/generated/run-generated-app.test.ts`
Expected: Tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/generated/fixtures/basic.expected.json test/generated/fixtures/custom-app-dir.expected.json
git commit -m "test: update harness fixtures for tool type generation"
```

---

### Task 11: Run full CI validation

**Files:**
- None (verification only)

- [ ] **Step 1: Run full CI validation**

Run: `pnpm ci:validate`
Expected: All steps pass — lint, build, typecheck, source tests, harness tests.

- [ ] **Step 2: Fix any failures**

If tests fail, check:
- `renderedBytes` values in fixtures match actual output
- `typegenOutput` strings match exactly (watch for trailing newlines, indentation)
- TypeScript `typeToString` formatting differences between the plan's examples and actual output
- Verify that `@dawn/core`'s `typescript` dependency doesn't cause version conflicts

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address CI failures in tool type generation"
```
