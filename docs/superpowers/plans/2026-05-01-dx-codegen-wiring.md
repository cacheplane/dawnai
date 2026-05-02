# Dawn Codegen Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire existing codegen functions into `dawn dev` and `dawn build` so tool schemas, state manifests, and type declarations are produced automatically.

**Architecture:** Extract a reusable `runTypegen()` orchestrator called by the CLI command, dev session, and build command. Dev mode uses path-based watch routing to selectively re-run typegen without restarting the server. `renderDawnTypes` is extended to include state types.

**Tech Stack:** TypeScript, Node.js fs, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/cli/src/lib/typegen/run-typegen.ts` | Reusable orchestrator: runs all extraction, writes all `.dawn/` output |
| `packages/cli/src/lib/typegen/run-typegen.test.ts` | Tests for orchestrator |
| `packages/cli/src/lib/dev/classify-change.ts` | Path classification: "typegen" vs "restart" |
| `packages/cli/src/lib/dev/classify-change.test.ts` | Tests for classification |
| `packages/cli/src/commands/typegen.ts` | Refactored to thin wrapper |
| `packages/cli/src/lib/dev/dev-session.ts` | Add typegen on start + selective watch routing |
| `packages/cli/src/commands/build.ts` | Add typegen as pre-step |
| `packages/core/src/typegen/render-route-types.ts` | Extend `renderDawnTypes` to accept + render state types |

---

### Task 1: Extend `renderDawnTypes` to Include State Types

**Files:**
- Modify: `packages/core/src/typegen/render-route-types.ts`
- Modify: `packages/core/test/render-route-types.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/render-route-types.test.ts`:

```typescript
test("renderDawnTypes includes state types when provided", () => {
  const manifest: RouteManifest = {
    appRoot: "/app",
    routes: [
      {
        id: "/hello/[tenant]",
        pathname: "/hello/:tenant",
        kind: "agent",
        entryFile: "/app/src/app/hello/[tenant]/index.ts",
        routeDir: "/app/src/app/hello/[tenant]",
        segments: [
          { kind: "static", raw: "hello" },
          { kind: "dynamic", name: "tenant", raw: "[tenant]" },
        ],
      },
    ],
  }

  const toolTypes: RouteToolTypes[] = []
  const stateTypes: RouteStateFields[] = [
    {
      pathname: "/hello/:tenant",
      fields: [
        { name: "context", type: "string" },
        { name: "results", type: "string[]" },
      ],
    },
  ]

  const output = renderDawnTypes(manifest, toolTypes, stateTypes)

  expect(output).toContain("DawnRouteState")
  expect(output).toContain("context")
  expect(output).toContain("results")
  expect(output).toContain("RouteState")
})

test("renderDawnTypes works without state types (backward compatible)", () => {
  const manifest: RouteManifest = {
    appRoot: "/app",
    routes: [
      {
        id: "/ping",
        pathname: "/ping",
        kind: "agent",
        entryFile: "/app/src/app/ping/index.ts",
        routeDir: "/app/src/app/ping",
        segments: [{ kind: "static", raw: "ping" }],
      },
    ],
  }

  const toolTypes: RouteToolTypes[] = []

  const output = renderDawnTypes(manifest, toolTypes)

  expect(output).toContain("DawnRoutePath")
  expect(output).toContain("DawnRouteTools")
  expect(output).not.toContain("DawnRouteState")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run test/render-route-types.test.ts`
Expected: FAIL — `renderDawnTypes` doesn't accept a third argument

- [ ] **Step 3: Implement — extend `renderDawnTypes` signature**

Modify `packages/core/src/typegen/render-route-types.ts`:

```typescript
import type { RouteManifest, RouteSegment, RouteToolTypes } from "../types.js"
import { type RouteStateFields, renderStateTypes } from "./render-state-types.js"
import { renderToolTypes } from "./render-tool-types.js"

export function renderDawnTypes(
  manifest: RouteManifest,
  toolTypes: readonly RouteToolTypes[],
  stateTypes?: readonly RouteStateFields[],
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

  const toolBlock = renderToolTypes(toolTypes).trimEnd()

  const blocks = [
    'declare module "dawn:routes" {',
    `  export type DawnRoutePath = ${pathUnion};`,
    "",
    paramBlock,
    "",
    toolBlock,
  ]

  if (stateTypes && stateTypes.length > 0) {
    blocks.push("")
    blocks.push(renderStateTypes(stateTypes).trimEnd())
  }

  blocks.push("}")
  blocks.push("")

  return blocks.join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run test/render-route-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/typegen/render-route-types.ts packages/core/test/render-route-types.test.ts
git commit -m "feat(core): extend renderDawnTypes to include state types"
```

---

### Task 2: Create `classify-change` Helper

**Files:**
- Create: `packages/cli/src/lib/dev/classify-change.ts`
- Create: `packages/cli/test/classify-change.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/classify-change.test.ts`:

```typescript
import { describe, expect, test } from "vitest"
import { classifyChange } from "../src/lib/dev/classify-change.js"

describe("classifyChange", () => {
  test("tool file change returns typegen", () => {
    expect(classifyChange("src/app/hello/[tenant]/tools/greet.ts")).toBe("typegen")
  })

  test("state.ts change returns typegen", () => {
    expect(classifyChange("src/app/hello/[tenant]/state.ts")).toBe("typegen")
  })

  test("reducer file change returns typegen", () => {
    expect(classifyChange("src/app/hello/[tenant]/reducers/results.ts")).toBe("typegen")
  })

  test("route index.ts change returns restart", () => {
    expect(classifyChange("src/app/hello/[tenant]/index.ts")).toBe("restart")
  })

  test("dawn.config.ts change returns restart", () => {
    expect(classifyChange("dawn.config.ts")).toBe("restart")
  })

  test("random source file returns restart", () => {
    expect(classifyChange("src/lib/utils.ts")).toBe("restart")
  })

  test("nested tool file returns typegen", () => {
    expect(classifyChange("src/app/(public)/hello/[tenant]/tools/search.ts")).toBe("typegen")
  })

  test(".d.ts file in tools returns restart (not a real tool)", () => {
    expect(classifyChange("src/app/hello/[tenant]/tools/greet.d.ts")).toBe("restart")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run test/classify-change.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `classify-change.ts`**

Create `packages/cli/src/lib/dev/classify-change.ts`:

```typescript
export type ChangeClassification = "typegen" | "restart"

export function classifyChange(relativePath: string): ChangeClassification {
  // Tool files: any path containing /tools/<name>.ts (not .d.ts)
  if (/\/tools\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return "typegen"
  }

  // State definition: any path ending in /state.ts
  if (/\/state\.ts$/.test(relativePath)) {
    return "typegen"
  }

  // Reducer overrides: any path containing /reducers/<name>.ts
  if (/\/reducers\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return "typegen"
  }

  return "restart"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && npx vitest run test/classify-change.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/classify-change.ts packages/cli/test/classify-change.test.ts
git commit -m "feat(cli): add path classification for dev watch routing"
```

---

### Task 3: Create `runTypegen` Orchestrator

**Files:**
- Create: `packages/cli/src/lib/typegen/run-typegen.ts`
- Create: `packages/cli/test/run-typegen.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/run-typegen.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { discoverRoutes } from "@dawn-ai/core"
import { runTypegen } from "../src/lib/typegen/run-typegen.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-typegen-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function setupApp(options?: { withState?: boolean }) {
  const appRoot = tempDir
  const routeDir = join(appRoot, "src/app/hello/[tenant]")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })

  writeFileSync(
    join(routeDir, "index.ts"),
    `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-4o", systemPrompt: "hi" })\n`,
  )

  writeFileSync(
    join(toolsDir, "greet.ts"),
    `/** Greets the tenant. */\nexport default async (input: { name: string }) => ({ message: "hi" })\n`,
  )

  if (options?.withState) {
    writeFileSync(
      join(routeDir, "state.ts"),
      `import { z } from "zod"\nexport default z.object({ context: z.string().default("") })\n`,
    )
  }

  writeFileSync(join(appRoot, "dawn.config.ts"), `export default {}\n`)

  return { appRoot, routeDir }
}

describe("runTypegen", () => {
  test("writes dawn.generated.d.ts with tool types", async () => {
    const { appRoot } = setupApp()
    const manifest = await discoverRoutes({ appRoot })

    const result = await runTypegen({ appRoot, manifest })

    expect(result.routeCount).toBe(1)
    expect(result.toolSchemaCount).toBe(1)

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    expect(existsSync(dtsPath)).toBe(true)

    const content = readFileSync(dtsPath, "utf8")
    expect(content).toContain("DawnRoutePath")
    expect(content).toContain("greet")
  })

  test("writes tools.json for each route", async () => {
    const { appRoot } = setupApp()
    const manifest = await discoverRoutes({ appRoot })

    await runTypegen({ appRoot, manifest })

    const toolsJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "tools.json")
    expect(existsSync(toolsJsonPath)).toBe(true)

    const toolsJson = JSON.parse(readFileSync(toolsJsonPath, "utf8"))
    expect(toolsJson.greet).toBeDefined()
    expect(toolsJson.greet.description).toBe("Greets the tenant.")
    expect(toolsJson.greet.parameters.properties.name.type).toBe("string")
  })

  test("writes state.json when state.ts is present", async () => {
    const { appRoot } = setupApp({ withState: true })
    const manifest = await discoverRoutes({ appRoot })

    const result = await runTypegen({ appRoot, manifest })

    expect(result.stateRouteCount).toBe(1)

    const stateJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "state.json")
    expect(existsSync(stateJsonPath)).toBe(true)

    const stateJson = JSON.parse(readFileSync(stateJsonPath, "utf8"))
    expect(stateJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "context", reducer: "replace" }),
      ]),
    )
  })

  test("skips state.json when no state.ts", async () => {
    const { appRoot } = setupApp({ withState: false })
    const manifest = await discoverRoutes({ appRoot })

    const result = await runTypegen({ appRoot, manifest })

    expect(result.stateRouteCount).toBe(0)

    const stateJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "state.json")
    expect(existsSync(stateJsonPath)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run test/run-typegen.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `run-typegen.ts`**

Create `packages/cli/src/lib/typegen/run-typegen.ts`:

```typescript
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type {
  ExtractedToolSchema,
  ResolvedStateField,
  RouteManifest,
  RouteToolTypes,
} from "@dawn-ai/core"
import {
  extractToolSchemasForRoute,
  extractToolTypesForRoute,
  renderDawnTypes,
  resolveStateFields,
} from "@dawn-ai/core"
import type { RouteStateFields } from "@dawn-ai/core"

import { discoverStateDefinition } from "../runtime/state-discovery.js"

export interface TypegenResult {
  readonly routeCount: number
  readonly toolSchemaCount: number
  readonly stateRouteCount: number
}

export async function runTypegen(options: {
  readonly appRoot: string
  readonly manifest: RouteManifest
}): Promise<TypegenResult> {
  const { appRoot, manifest } = options
  const dawnDir = join(appRoot, ".dawn")
  const sharedToolsDir = join(appRoot, "src")

  const routeToolTypes: RouteToolTypes[] = []
  const routeStateFields: RouteStateFields[] = []
  let toolSchemaCount = 0

  for (const route of manifest.routes) {
    // Extract tool types for .d.ts
    const tools = await extractToolTypesForRoute({
      routeDir: route.routeDir,
      sharedToolsDir,
    })
    routeToolTypes.push({ pathname: route.pathname, tools })

    // Extract tool schemas for JSON
    const schemas = await extractToolSchemasForRoute({
      routeDir: route.routeDir,
      sharedToolsDir,
    })

    if (schemas.length > 0) {
      toolSchemaCount += schemas.length
      await writeToolSchemas(dawnDir, route.id, schemas)
    }

    // Discover state
    const stateDefinition = await discoverStateDefinition({ routeDir: route.routeDir })
    if (stateDefinition) {
      const fields = resolveStateFields({
        defaults: stateDefinition.defaults,
        reducerOverrides: stateDefinition.reducerOverrides,
      })

      await writeStateManifest(dawnDir, route.id, fields)

      routeStateFields.push({
        pathname: route.pathname,
        fields: fields.map((f) => ({
          name: f.name,
          type: inferTypeFromDefault(f.default),
        })),
      })
    }
  }

  // Write .dawn/dawn.generated.d.ts
  const dtsContent = renderDawnTypes(manifest, routeToolTypes, routeStateFields)
  const dtsPath = join(dawnDir, "dawn.generated.d.ts")
  await mkdir(dawnDir, { recursive: true })
  await writeFile(dtsPath, dtsContent, "utf8")

  return {
    routeCount: manifest.routes.length,
    toolSchemaCount,
    stateRouteCount: routeStateFields.length,
  }
}

async function writeToolSchemas(
  dawnDir: string,
  routeId: string,
  schemas: readonly ExtractedToolSchema[],
): Promise<void> {
  const routeSlug = routeIdToSlug(routeId)
  const dir = join(dawnDir, "routes", routeSlug)
  await mkdir(dir, { recursive: true })

  const output: Record<string, unknown> = {}
  for (const schema of schemas) {
    output[schema.name] = {
      description: schema.description,
      parameters: schema.parameters,
    }
  }

  await writeFile(join(dir, "tools.json"), JSON.stringify(output, null, 2) + "\n", "utf8")
}

async function writeStateManifest(
  dawnDir: string,
  routeId: string,
  fields: readonly ResolvedStateField[],
): Promise<void> {
  const routeSlug = routeIdToSlug(routeId)
  const dir = join(dawnDir, "routes", routeSlug)
  await mkdir(dir, { recursive: true })

  const output = fields.map((f) => ({
    name: f.name,
    reducer: typeof f.reducer === "function" ? "custom" : f.reducer,
    default: f.default,
  }))

  await writeFile(join(dir, "state.json"), JSON.stringify(output, null, 2) + "\n", "utf8")
}

function routeIdToSlug(routeId: string): string {
  return routeId
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/\[/g, "")
    .replace(/\]/g, "")
}

function inferTypeFromDefault(value: unknown): string {
  if (Array.isArray(value)) return "string[]"
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  return "string"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && npx vitest run test/run-typegen.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/typegen/run-typegen.ts packages/cli/test/run-typegen.test.ts
git commit -m "feat(cli): add reusable runTypegen orchestrator"
```

---

### Task 4: Refactor `typegen` Command to Use `runTypegen`

**Files:**
- Modify: `packages/cli/src/commands/typegen.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/typegen-command.test.ts` (or create if it doesn't exist):

```typescript
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import type { CommandIo } from "../src/lib/output.js"
import { runTypegenCommand } from "../src/commands/typegen.js"

function createTestIo(): CommandIo {
  return { stdout: () => {}, stderr: () => {} }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-typegen-cmd-"))
  const routeDir = join(tempDir, "src/app/ping")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })

  writeFileSync(join(routeDir, "index.ts"), `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-4o", systemPrompt: "hi" })\n`)
  writeFileSync(join(toolsDir, "ping.ts"), `/** Pings. */\nexport default async () => ({ pong: true })\n`)
  writeFileSync(join(tempDir, "dawn.config.ts"), `export default {}\n`)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("typegen command", () => {
  test("produces tools.json alongside dawn.generated.d.ts", async () => {
    const io = createTestIo()
    await runTypegenCommand({ cwd: tempDir }, io)

    expect(existsSync(join(tempDir, ".dawn", "dawn.generated.d.ts"))).toBe(true)
    expect(existsSync(join(tempDir, ".dawn", "routes", "ping", "tools.json"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run test/typegen-command.test.ts`
Expected: FAIL — `tools.json` not produced (current implementation doesn't call `runTypegen`)

- [ ] **Step 3: Refactor `typegen.ts` to use `runTypegen`**

Replace `packages/cli/src/commands/typegen.ts`:

```typescript
import { discoverRoutes, findDawnApp } from "@dawn-ai/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { runTypegen } from "../lib/typegen/run-typegen.js"

interface TypegenOptions {
  readonly cwd?: string
}

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
    const result = await runTypegen({ appRoot: app.appRoot, manifest })

    writeLine(
      io.stdout,
      `Wrote types for ${result.routeCount} route(s), ${result.toolSchemaCount} tool schema(s), ${result.stateRouteCount} stateful route(s)`,
    )
  } catch (error) {
    throw new CliError(`Failed to generate route types: ${formatErrorMessage(error)}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && npx vitest run test/typegen-command.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `cd packages/cli && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/typegen.ts packages/cli/test/typegen-command.test.ts
git commit -m "refactor(cli): typegen command uses runTypegen orchestrator"
```

---

### Task 5: Wire Typegen into `dawn build`

**Files:**
- Modify: `packages/cli/src/commands/build.ts`
- Modify: `packages/cli/test/build-command.test.ts` (if exists, or create)

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/build-command.test.ts` (create if needed):

```typescript
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import type { CommandIo } from "../src/lib/output.js"
import { runBuildCommand } from "../src/commands/build.js"

function createTestIo(): CommandIo {
  return { stdout: () => {}, stderr: () => {} }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-build-"))
  const routeDir = join(tempDir, "src/app/ping")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })

  writeFileSync(join(routeDir, "index.ts"), `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-4o", systemPrompt: "hi" })\n`)
  writeFileSync(join(toolsDir, "ping.ts"), `/** Pings. */\nexport default async () => ({ pong: true })\n`)
  writeFileSync(join(tempDir, "dawn.config.ts"), `export default {}\n`)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("build command typegen integration", () => {
  test("produces tools.json in .dawn/routes/ during build", async () => {
    const io = createTestIo()
    await runBuildCommand({ cwd: tempDir }, io)

    expect(existsSync(join(tempDir, ".dawn", "routes", "ping", "tools.json"))).toBe(true)
    expect(existsSync(join(tempDir, ".dawn", "dawn.generated.d.ts"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run test/build-command.test.ts`
Expected: FAIL — `tools.json` not produced

- [ ] **Step 3: Add typegen to build command**

Modify `packages/cli/src/commands/build.ts` — add import and call at the top of `runBuildCommand`:

Add this import at the top:

```typescript
import { runTypegen } from "../lib/typegen/run-typegen.js"
```

Add this as the first line inside `runBuildCommand`, after `discoverRoutes`:

```typescript
export async function runBuildCommand(options: BuildOptions, io: CommandIo): Promise<void> {
  const manifest = await discoverRoutes({
    ...(options.cwd ? { appRoot: options.cwd } : {}),
  })

  // Run typegen as pre-step — produces .dawn/routes/<id>/tools.json and .dawn/dawn.generated.d.ts
  await runTypegen({ appRoot: manifest.appRoot, manifest })

  const buildDir = resolve(manifest.appRoot, ".dawn", "build")
  // ... rest remains unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && npx vitest run test/build-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/build.ts packages/cli/test/build-command.test.ts
git commit -m "feat(cli): run typegen as build pre-step"
```

---

### Task 6: Wire Typegen into Dev Session with Watch Routing

**Files:**
- Modify: `packages/cli/src/lib/dev/dev-session.ts`
- Modify: `packages/cli/test/dev-command.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/dev-typegen.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { startDevSession } from "../src/lib/dev/dev-session.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-dev-typegen-"))
  const routeDir = join(tempDir, "src/app/hello/[tenant]")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })

  writeFileSync(join(routeDir, "index.ts"), `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-4o", systemPrompt: "hi" })\n`)
  writeFileSync(join(toolsDir, "greet.ts"), `/** Greets. */\nexport default async (input: { name: string }) => ({ message: "hi" })\n`)
  writeFileSync(join(tempDir, "dawn.config.ts"), `export default {}\n`)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("dev session typegen", () => {
  test("runs typegen on start and produces .dawn output", async () => {
    const session = await startDevSession({
      cwd: tempDir,
      io: { stdout: () => {}, stderr: () => {} },
    })

    try {
      const dtsPath = join(tempDir, ".dawn", "dawn.generated.d.ts")
      expect(existsSync(dtsPath)).toBe(true)

      const toolsJsonPath = join(tempDir, ".dawn", "routes", "hello-tenant", "tools.json")
      expect(existsSync(toolsJsonPath)).toBe(true)
    } finally {
      await session.close()
    }
  })
})
```
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run test/dev-typegen.test.ts`
Expected: FAIL — `.dawn/routes/` not created

- [ ] **Step 3: Implement dev session typegen integration**

Modify `packages/cli/src/lib/dev/dev-session.ts`:

Add imports at the top:

```typescript
import { discoverRoutes } from "@dawn-ai/core"
import { classifyChange } from "./classify-change.js"
import { runTypegen } from "../typegen/run-typegen.js"
```

Add a typegen debounce field to `InternalDevSession`:

```typescript
private typegenTimeout: ReturnType<typeof setTimeout> | null = null
```

Modify the `start()` method to run typegen before spawning:

```typescript
async start(): Promise<void> {
  // Run typegen before starting dev server
  await this.runTypegenSafe()

  this.watcher = watchApp({
    appRoot: this.appRoot,
    onChange: (path) => {
      this.handleChange(path)
    },
  })

  await this.startOrRestart()
  writeLine(this.io.stdout, `Dawn dev ready at ${this.url}`)
}
```

Add the `handleChange` and `runTypegenSafe` methods:

```typescript
private handleChange(absolutePath: string): void {
  if (this.closed) return

  const relative = absolutePath.startsWith(this.appRoot)
    ? absolutePath.slice(this.appRoot.length + 1)
    : absolutePath

  const classification = classifyChange(relative)

  if (classification === "typegen") {
    this.scheduleTypegen()
  } else {
    void this.requestRestart()
  }
}

private scheduleTypegen(): void {
  if (this.typegenTimeout) {
    clearTimeout(this.typegenTimeout)
  }

  this.typegenTimeout = setTimeout(() => {
    this.typegenTimeout = null
    void this.runTypegenSafe()
  }, 100)
}

private async runTypegenSafe(): Promise<void> {
  try {
    const manifest = await discoverRoutes({ appRoot: this.appRoot })
    await runTypegen({ appRoot: this.appRoot, manifest })
  } catch (error) {
    writeLine(this.io.stderr, `Typegen failed: ${formatErrorMessage(error)}`)
  }
}
```

Update the `close()` method to clear the typegen timeout:

```typescript
async close(): Promise<void> {
  if (this.closed) return

  this.closed = true

  if (this.typegenTimeout) {
    clearTimeout(this.typegenTimeout)
    this.typegenTimeout = null
  }

  this.watcher?.close()
  this.watcher = null

  if (this.currentChild) {
    const child = this.currentChild
    this.currentChild = null
    await child.stop(readShutdownTimeoutMs())
  }

  this.resolveClosed()
}
```

Also update the watcher setup — change from the inline `onChange` to use `handleChange`:

In `start()`, replace the previous watcher creation. The onChange was `(_path) => { void this.requestRestart() }` — now it calls `this.handleChange(path)` as shown above.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && npx vitest run test/dev-typegen.test.ts`
Expected: PASS

- [ ] **Step 5: Run full CLI test suite**

Run: `cd packages/cli && npx vitest run`
Expected: ALL PASS (the flaky timeout test may still flake — that's pre-existing)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/dev-session.ts packages/cli/src/lib/dev/classify-change.ts packages/cli/test/dev-typegen.test.ts
git commit -m "feat(cli): run typegen on dev start with path-based watch routing"
```

---

### Task 7: Full Integration Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS (except the pre-existing flaky dev-command timeout)

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run pack-check**

Run: `node scripts/pack-check.mjs`
Expected: PASS

- [ ] **Step 4: Manual verification with test app**

If `/Users/blove/tmp/dawn-app` exists:

```bash
cd /Users/blove/tmp/dawn-app
npx dawn typegen
ls .dawn/
ls .dawn/routes/
cat .dawn/dawn.generated.d.ts
```

Expected: `.dawn/routes/hello-tenant/tools.json` exists with proper schema, `.dawn/dawn.generated.d.ts` includes both tool types and (if state.ts exists) state types.

- [ ] **Step 5: Commit any fixes (if needed)**

Only commit if Step 1-3 surfaced issues that needed fixing.
