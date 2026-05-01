# Dawn TypeScript DX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Dawn's TypeScript DX with per-provider model IDs, auto-generated JSON Schema for tools (so LLMs know what args to pass), type manifests for IDE visibility, convention-based agent state, and utility type exports.

**Architecture:** Expand the existing typegen pipeline in `@dawn-ai/core` to emit JSON Schema + JSDoc descriptions alongside the current type strings. Add state discovery convention (`state.ts` + `reducers/` folder) wired through the LangChain adapter. SDK stays zero-dep with only types and interfaces.

**Tech Stack:** TypeScript compiler API (existing), Standard Schema v1 interface, zod (consumer-side), LangChain `@langchain/langgraph` (adapter layer)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/sdk/src/known-model-ids.ts` | Per-provider model ID types |
| `packages/sdk/src/types.ts` | `Prettify<T>` utility type |
| `packages/sdk/src/route-types.ts` | Empty `RouteToolMap` / `RouteStateMap` interfaces for augmentation |
| `packages/core/src/typegen/extract-tool-schema.ts` | Generate JSON Schema from TS types + JSDoc |
| `packages/core/src/typegen/render-state-types.ts` | Render state type manifest |
| `packages/core/src/state/resolve-state-fields.ts` | Resolve state schema defaults → infer reducers |
| `packages/cli/src/lib/runtime/state-discovery.ts` | Discover `state.ts` + `reducers/` folder |
| `packages/langchain/src/state-adapter.ts` | Map resolved fields → LangChain AnnotationRoot |
| `packages/sdk/test/known-model-ids.test.ts` | Model ID type tests |
| `packages/core/test/extract-tool-schema.test.ts` | JSON Schema generation tests |
| `packages/core/test/resolve-state-fields.test.ts` | State field resolution tests |
| `packages/core/test/render-state-types.test.ts` | State type manifest rendering tests |
| `packages/cli/test/state-discovery.test.ts` | State discovery tests |
| `packages/langchain/test/state-adapter.test.ts` | State adapter tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/sdk/src/agent.ts` | Remove `KnownModelId`, import from `known-model-ids.ts` |
| `packages/sdk/src/index.ts` | Add new exports |
| `packages/core/src/types.ts` | Add `ExtractedToolSchema`, `ResolvedStateField` interfaces |
| `packages/core/src/typegen/extract-tool-types.ts` | Add JSDoc extraction |
| `packages/core/src/index.ts` | Export new modules |
| `packages/langchain/src/agent-adapter.ts` | Accept optional state, pass to `createReactAgent` |
| `packages/cli/src/lib/runtime/execute-route.ts` | Discover state, pass to agent adapter |
| `packages/cli/src/lib/runtime/tool-discovery.ts` | Inject generated schema when available |
| `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts` | Add state types |

---

### Task 1: Per-Provider Model IDs

**Files:**
- Create: `packages/sdk/src/known-model-ids.ts`
- Modify: `packages/sdk/src/agent.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/known-model-ids.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/known-model-ids.test.ts`:

```typescript
import type { AnthropicModelId, GoogleModelId, KnownModelId, OpenAiModelId } from "@dawn-ai/sdk"
import { agent } from "@dawn-ai/sdk"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("KnownModelId", () => {
  test("accepts OpenAI model IDs", () => {
    const descriptor = agent({ model: "gpt-5.5", systemPrompt: "test" })
    expect(descriptor.model).toBe("gpt-5.5")
  })

  test("accepts Anthropic model IDs", () => {
    const descriptor = agent({ model: "claude-opus-4-7", systemPrompt: "test" })
    expect(descriptor.model).toBe("claude-opus-4-7")
  })

  test("accepts Google model IDs", () => {
    const descriptor = agent({ model: "gemini-2.5-pro", systemPrompt: "test" })
    expect(descriptor.model).toBe("gemini-2.5-pro")
  })

  test("accepts arbitrary string via (string & {})", () => {
    const descriptor = agent({ model: "my-custom-model", systemPrompt: "test" })
    expect(descriptor.model).toBe("my-custom-model")
  })

  test("per-provider types are subtypes of KnownModelId", () => {
    expectTypeOf<OpenAiModelId>().toMatchTypeOf<KnownModelId>()
    expectTypeOf<AnthropicModelId>().toMatchTypeOf<KnownModelId>()
    expectTypeOf<GoogleModelId>().toMatchTypeOf<KnownModelId>()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && npx vitest run test/known-model-ids.test.ts`
Expected: FAIL — `OpenAiModelId`, `AnthropicModelId`, `GoogleModelId` not exported

- [ ] **Step 3: Create `known-model-ids.ts`**

Create `packages/sdk/src/known-model-ids.ts`:

```typescript
export type OpenAiModelId =
  // GPT-5.x series
  | "gpt-5.5"
  | "gpt-5.5-pro"
  | "gpt-5.4"
  | "gpt-5.4-pro"
  | "gpt-5-mini"
  // GPT-4.1 series
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  // GPT-4o series
  | "gpt-4o"
  | "gpt-4o-mini"
  // Reasoning
  | "o3"
  | "o3-mini"
  | "o4-mini"

export type AnthropicModelId =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"

export type GoogleModelId =
  | "gemini-3-pro-preview"
  | "gemini-3-flash-preview"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"

export type KnownModelId =
  | OpenAiModelId
  | AnthropicModelId
  | GoogleModelId
  | (string & {})
```

- [ ] **Step 4: Update `agent.ts` to import from new file**

Modify `packages/sdk/src/agent.ts` — remove lines 11-19 (the inline `KnownModelId` type) and add import:

```typescript
import type { KnownModelId } from "./known-model-ids.js"
```

Keep the rest of the file unchanged.

- [ ] **Step 5: Update barrel exports**

Modify `packages/sdk/src/index.ts` — add the new exports:

```typescript
export type { AgentConfig, DawnAgent } from "./agent.js"
export { agent, isDawnAgent } from "./agent.js"
export type { BackendAdapter } from "./backend-adapter.js"
export type {
  AnthropicModelId,
  GoogleModelId,
  KnownModelId,
  OpenAiModelId,
} from "./known-model-ids.js"
export type { RouteConfig, RouteKind } from "./route-config.js"
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "./runtime-context.js"
```

Note: `KnownModelId` moves from `./agent.js` to `./known-model-ids.js` export.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/sdk && npx vitest run`
Expected: ALL PASS (both existing `agent.test.ts` and new `known-model-ids.test.ts`)

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/known-model-ids.ts packages/sdk/src/agent.ts packages/sdk/src/index.ts packages/sdk/test/known-model-ids.test.ts
git commit -m "feat(sdk): per-provider model IDs with updated models"
```

---

### Task 2: Utility Types and Export Cleanup

**Files:**
- Create: `packages/sdk/src/types.ts`
- Create: `packages/sdk/src/route-types.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/types.test.ts`:

```typescript
import type { Prettify, RouteStateMap, RouteToolMap } from "@dawn-ai/sdk"
import { describe, expectTypeOf, test } from "vitest"

describe("Prettify<T>", () => {
  test("resolves intersection types into flat object", () => {
    type A = { a: string } & { b: number }
    type Result = Prettify<A>
    expectTypeOf<Result>().toEqualTypeOf<{ a: string; b: number }>()
  })

  test("preserves optional properties", () => {
    type A = { a: string; b?: number }
    type Result = Prettify<A>
    expectTypeOf<Result>().toEqualTypeOf<{ a: string; b?: number }>()
  })
})

describe("RouteToolMap", () => {
  test("is an empty interface by default", () => {
    expectTypeOf<RouteToolMap>().toEqualTypeOf<{}>()
  })
})

describe("RouteStateMap", () => {
  test("is an empty interface by default", () => {
    expectTypeOf<RouteStateMap>().toEqualTypeOf<{}>()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && npx vitest run test/types.test.ts`
Expected: FAIL — `Prettify`, `RouteToolMap`, `RouteStateMap` not exported

- [ ] **Step 3: Create `types.ts`**

Create `packages/sdk/src/types.ts`:

```typescript
/**
 * Resolves complex intersection/mapped types into a flat object shape.
 * Makes IDE hovers show the actual resolved type instead of type algebra.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {}
```

- [ ] **Step 4: Create `route-types.ts`**

Create `packages/sdk/src/route-types.ts`:

```typescript
/**
 * Open interface for codegen to augment with per-route tool type information.
 * Populated by `.dawn/generated/route-tools.d.ts` at build time.
 */
export interface RouteToolMap {}

/**
 * Open interface for codegen to augment with per-route state type information.
 * Populated by `.dawn/generated/route-state.d.ts` at build time.
 */
export interface RouteStateMap {}
```

- [ ] **Step 5: Update barrel exports**

Modify `packages/sdk/src/index.ts` — add new exports (maintaining biome alphabetical order):

```typescript
export type { AgentConfig, DawnAgent } from "./agent.js"
export { agent, isDawnAgent } from "./agent.js"
export type { BackendAdapter } from "./backend-adapter.js"
export type {
  AnthropicModelId,
  GoogleModelId,
  KnownModelId,
  OpenAiModelId,
} from "./known-model-ids.js"
export type { RouteConfig, RouteKind } from "./route-config.js"
export type { RouteStateMap, RouteToolMap } from "./route-types.js"
export type { RuntimeContext, RuntimeTool, ToolRegistry } from "./runtime-context.js"
export type { Prettify } from "./types.js"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/sdk && npx vitest run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/route-types.ts packages/sdk/src/index.ts packages/sdk/test/types.test.ts
git commit -m "feat(sdk): add Prettify utility type and RouteToolMap/RouteStateMap interfaces"
```

---

### Task 3: Extract Tool JSON Schema from TypeScript Types

**Files:**
- Create: `packages/core/src/typegen/extract-tool-schema.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/extract-tool-schema.test.ts`

- [ ] **Step 1: Add `ExtractedToolSchema` interface to types**

Modify `packages/core/src/types.ts` — add after `ExtractedToolType`:

```typescript
export interface JsonSchemaProperty {
  readonly type: string
  readonly description?: string
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly enum?: readonly string[]
}

export interface ExtractedToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: "object"
    readonly properties: Record<string, JsonSchemaProperty>
    readonly required: readonly string[]
    readonly additionalProperties: false
  }
}

export interface RouteToolSchemas {
  readonly pathname: string
  readonly tools: readonly ExtractedToolSchema[]
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/extract-tool-schema.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractToolSchemasForRoute } from "../src/typegen/extract-tool-schema"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-tool-schema-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeToolFile(dir: string, name: string, content: string): void {
  const toolsDir = join(dir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, `${name}.ts`), content)
}

describe("extractToolSchemasForRoute", () => {
  test("extracts JSON Schema from typed tool with JSDoc", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "greet",
      `
/**
 * Greets the tenant and returns their plan info.
 */
export default async (input: {
  /** The tenant organization ID */
  readonly tenant: string
}) => {
  return { name: input.tenant, plan: "starter" }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        name: "greet",
        description: "Greets the tenant and returns their plan info.",
        parameters: {
          type: "object",
          properties: {
            tenant: { type: "string", description: "The tenant organization ID" },
          },
          required: ["tenant"],
          additionalProperties: false,
        },
      },
    ])
  })

  test("maps number, boolean, and array types", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "search",
      `
/**
 * Searches for items.
 */
export default async (input: {
  /** Search query */
  query: string
  /** Max results to return */
  limit: number
  /** Include archived items */
  includeArchived: boolean
  /** Tags to filter by */
  tags: string[]
}) => {
  return { results: [] }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.parameters.properties).toEqual({
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results to return" },
      includeArchived: { type: "boolean", description: "Include archived items" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags to filter by",
      },
    })
    expect(result[0]?.parameters.required).toEqual([
      "query",
      "limit",
      "includeArchived",
      "tags",
    ])
  })

  test("handles optional properties", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "fetch",
      `
/** Fetches data. */
export default async (input: {
  url: string
  timeout?: number
}) => {
  return {}
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.parameters.required).toEqual(["url"])
    expect(result[0]?.parameters.properties.timeout).toEqual({ type: "number" })
  })

  test("handles string literal unions as enum", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "sort",
      `
/** Sorts items. */
export default async (input: {
  /** Sort direction */
  order: "asc" | "desc"
}) => {
  return {}
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.parameters.properties.order).toEqual({
      type: "string",
      enum: ["asc", "desc"],
      description: "Sort direction",
    })
  })

  test("returns empty description when no JSDoc present", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "ping",
      `
export default async (input: { host: string }) => {
  return { ok: true }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.description).toBe("")
    expect(result[0]?.parameters.properties.host).toEqual({ type: "string" })
  })

  test("handles no-parameter tools", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "health",
      `
/** Returns health status. */
export default async () => {
  return { ok: true }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]).toEqual({
      name: "health",
      description: "Returns health status.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && npx vitest run test/extract-tool-schema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `extract-tool-schema.ts`**

Create `packages/core/src/typegen/extract-tool-schema.ts`:

```typescript
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

import type { ExtractedToolSchema, JsonSchemaProperty } from "../types.js"

export interface ExtractToolSchemasOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
}

export async function extractToolSchemasForRoute(
  options: ExtractToolSchemasOptions,
): Promise<readonly ExtractedToolSchema[]> {
  const routeToolFiles = discoverToolFiles(join(options.routeDir, "tools"))
  const sharedToolFiles = options.sharedToolsDir
    ? discoverToolFiles(join(options.sharedToolsDir, "tools"))
    : new Map<string, string>()

  const merged = new Map<string, string>(sharedToolFiles)
  for (const [name, filePath] of routeToolFiles) {
    merged.set(name, filePath)
  }

  if (merged.size === 0) return []

  const allFilePaths = [...merged.values()]
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts"],
  }

  const program = ts.createProgram(allFilePaths, compilerOptions)
  const checker = program.getTypeChecker()

  const results: ExtractedToolSchema[] = []

  for (const [name, filePath] of merged) {
    const sourceFile = program.getSourceFile(filePath)
    if (!sourceFile) continue

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (!moduleSymbol) continue

    const exports = checker.getExportsOfModule(moduleSymbol)
    const defaultExport = exports.find((e) => e.escapedName === "default")
    if (!defaultExport) continue

    const description = extractJsDoc(defaultExport, checker)
    const exportType = checker.getTypeOfSymbolAtLocation(defaultExport, sourceFile)
    const signatures = checker.getSignaturesOfType(exportType, ts.SignatureKind.Call)
    if (signatures.length === 0) continue

    const signature = signatures[0]
    if (!signature) continue
    const params = signature.getParameters()

    if (params.length === 0) {
      results.push({
        name,
        description,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      })
      continue
    }

    const firstParam = params[0]
    if (!firstParam) continue
    const paramType = checker.getTypeOfSymbolAtLocation(firstParam, sourceFile)
    const { properties, required } = extractObjectSchema(paramType, checker)

    results.push({
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    })
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

function extractJsDoc(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const docs = symbol.getDocumentationComment(checker)
  return docs.map((d) => d.text).join("").trim()
}

function extractObjectSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
): { properties: Record<string, JsonSchemaProperty>; required: string[] } {
  const properties: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []

  for (const prop of type.getProperties()) {
    const propType = checker.getTypeOfSymbolAtLocation(
      prop,
      prop.valueDeclaration ?? prop.declarations?.[0] ?? ({} as ts.Node),
    )

    const description = extractJsDoc(prop, checker)
    const schema = typeToJsonSchema(propType, checker)

    if (description) {
      schema.description = description
    }

    properties[prop.getName()] = schema

    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0
    if (!isOptional) {
      required.push(prop.getName())
    }
  }

  return { properties, required }
}

function typeToJsonSchema(type: ts.Type, checker: ts.TypeChecker): JsonSchemaProperty {
  // String literal union → enum
  if (type.isUnion()) {
    const allStringLiterals = type.types.every((t) => t.isStringLiteral())
    if (allStringLiterals) {
      return {
        type: "string",
        enum: type.types.map((t) => (t as ts.StringLiteralType).value),
      }
    }
  }

  // Primitive types
  if (type.flags & ts.TypeFlags.String) return { type: "string" }
  if (type.flags & ts.TypeFlags.Number) return { type: "number" }
  if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" }
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: "boolean" }

  // Array type
  if (checker.isArrayType(type)) {
    const typeArgs = (type as ts.TypeReference).typeArguments
    const itemType = typeArgs?.[0]
    return {
      type: "array",
      items: itemType ? typeToJsonSchema(itemType, checker) : { type: "string" },
    }
  }

  // Object type (nested)
  if (type.flags & ts.TypeFlags.Object && type.getProperties().length > 0) {
    const { properties, required } = extractObjectSchema(type, checker)
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    }
  }

  // Fallback
  return { type: "string" }
}

function discoverToolFiles(toolsDir: string): Map<string, string> {
  const files = new Map<string, string>()
  if (!existsSync(toolsDir)) return files

  const entries = readdirSync(toolsDir)
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue
    if (entry.endsWith(".d.ts")) continue
    const name = entry.replace(/\.ts$/, "")
    files.set(name, join(toolsDir, entry))
  }

  return files
}
```

- [ ] **Step 5: Export from core barrel**

Modify `packages/core/src/index.ts` — add:

```typescript
export type { ExtractToolSchemasOptions } from "./typegen/extract-tool-schema.js"
export { extractToolSchemasForRoute } from "./typegen/extract-tool-schema.js"
```

Also add to the type exports block:

```typescript
export type {
  // ... existing types ...
  ExtractedToolSchema,
  JsonSchemaProperty,
  RouteToolSchemas,
} from "./types.js"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/extract-tool-schema.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Run full core test suite**

Run: `cd packages/core && npx vitest run`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/typegen/extract-tool-schema.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/test/extract-tool-schema.test.ts
git commit -m "feat(core): extract JSON Schema from tool function signatures and JSDoc"
```

---

### Task 4: Extract JSDoc from Existing Tool Type Extractor

**Files:**
- Modify: `packages/core/src/typegen/extract-tool-types.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/test/extract-tool-types.test.ts`

- [ ] **Step 1: Add `description` field to `ExtractedToolType`**

Modify `packages/core/src/types.ts` — update `ExtractedToolType`:

```typescript
export interface ExtractedToolType {
  readonly name: string
  readonly description: string
  readonly inputType: string
  readonly outputType: string
}
```

- [ ] **Step 2: Write the failing test**

Add to `packages/core/test/extract-tool-types.test.ts`:

```typescript
test("extracts JSDoc description from tool function", async () => {
  const routeDir = join(tempDir, "route")
  writeToolFile(
    routeDir,
    "greet",
    `
/**
 * Greets the user by name.
 */
export default async function greet(input: { name: string }): Promise<{ message: string }> {
  return { message: "hello " + input.name }
}
`,
  )

  const result = await extractToolTypesForRoute({
    routeDir,
    sharedToolsDir: undefined,
  })

  expect(result[0]?.description).toBe("Greets the user by name.")
})

test("returns empty description when no JSDoc", async () => {
  const routeDir = join(tempDir, "route")
  writeToolFile(
    routeDir,
    "ping",
    `
export default async function ping(): Promise<{ pong: boolean }> {
  return { pong: true }
}
`,
  )

  const result = await extractToolTypesForRoute({
    routeDir,
    sharedToolsDir: undefined,
  })

  expect(result[0]?.description).toBe("")
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && npx vitest run test/extract-tool-types.test.ts`
Expected: FAIL — `description` is `undefined`, not a string

- [ ] **Step 4: Add JSDoc extraction to `extract-tool-types.ts`**

Modify `packages/core/src/typegen/extract-tool-types.ts` — add helper and update result:

After the `unwrapPromise` function, add:

```typescript
function extractJsDoc(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const docs = symbol.getDocumentationComment(checker)
  return docs.map((d) => d.text).join("").trim()
}
```

In the main loop, after `if (!defaultExport) continue`, add:

```typescript
const description = extractJsDoc(defaultExport, checker)
```

Update the `results.push` call to include `description`:

```typescript
results.push({
  name,
  description,
  inputType,
  outputType: checker.typeToString(outputType),
})
```

- [ ] **Step 5: Update existing test expectations**

The existing tests in `extract-tool-types.test.ts` now need to include `description: ""` in their expected values. Update each `expect(result).toEqual(...)` to include the `description` field:

```typescript
// Example — update the first test:
expect(result).toEqual([
  {
    name: "greet",
    description: "",
    inputType: "{ name: string; }",
    outputType: "{ message: string; }",
  },
])
```

Apply the same pattern to all existing test expectations (add `description: ""` to each).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/extract-tool-types.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/typegen/extract-tool-types.ts packages/core/src/types.ts packages/core/test/extract-tool-types.test.ts
git commit -m "feat(core): extract JSDoc description from tool functions"
```

---

### Task 5: State Field Resolution (Standard Schema Interface)

**Files:**
- Create: `packages/core/src/state/resolve-state-fields.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/resolve-state-fields.test.ts`

- [ ] **Step 1: Add state types to `types.ts`**

Modify `packages/core/src/types.ts` — add:

```typescript
export type StateFieldReducer = "append" | "replace"

export interface ResolvedStateField {
  readonly name: string
  readonly reducer: StateFieldReducer | ((current: unknown, incoming: unknown) => unknown)
  readonly default: unknown
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/resolve-state-fields.test.ts`:

```typescript
import { describe, expect, test } from "vitest"

import { resolveStateFields } from "../src/state/resolve-state-fields"

describe("resolveStateFields", () => {
  test("infers append reducer for array defaults", () => {
    const defaults = new Map<string, unknown>([
      ["results", []],
      ["tags", ["initial"]],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result).toEqual([
      { name: "results", reducer: "append", default: [] },
      { name: "tags", reducer: "append", default: ["initial"] },
    ])
  })

  test("infers replace reducer for scalar defaults", () => {
    const defaults = new Map<string, unknown>([
      ["context", ""],
      ["confidence", 0],
      ["active", true],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result).toEqual([
      { name: "active", reducer: "replace", default: true },
      { name: "confidence", reducer: "replace", default: 0 },
      { name: "context", reducer: "replace", default: "" },
    ])
  })

  test("reducer overrides take precedence", () => {
    const customReducer = (current: string[], incoming: string[]) => incoming
    const defaults = new Map<string, unknown>([["results", []]])
    const reducerOverrides = new Map<string, (current: unknown, incoming: unknown) => unknown>([
      ["results", customReducer],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides })

    expect(result).toEqual([{ name: "results", reducer: customReducer, default: [] }])
  })

  test("infers replace for null and undefined defaults", () => {
    const defaults = new Map<string, unknown>([
      ["data", null],
      ["meta", undefined],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result).toEqual([
      { name: "data", reducer: "replace", default: null },
      { name: "meta", reducer: "replace", default: undefined },
    ])
  })

  test("sorts fields alphabetically by name", () => {
    const defaults = new Map<string, unknown>([
      ["zeta", "z"],
      ["alpha", "a"],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result[0]?.name).toBe("alpha")
    expect(result[1]?.name).toBe("zeta")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && npx vitest run test/resolve-state-fields.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `resolve-state-fields.ts`**

Create `packages/core/src/state/resolve-state-fields.ts`:

```typescript
import type { ResolvedStateField } from "../types.js"

export interface ResolveStateFieldsOptions {
  readonly defaults: ReadonlyMap<string, unknown>
  readonly reducerOverrides: ReadonlyMap<
    string,
    (current: unknown, incoming: unknown) => unknown
  >
}

export function resolveStateFields(options: ResolveStateFieldsOptions): readonly ResolvedStateField[] {
  const results: ResolvedStateField[] = []

  for (const [name, defaultValue] of options.defaults) {
    const override = options.reducerOverrides.get(name)

    if (override) {
      results.push({ name, reducer: override, default: defaultValue })
    } else {
      const reducer = Array.isArray(defaultValue) ? "append" : "replace"
      results.push({ name, reducer, default: defaultValue })
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}
```

- [ ] **Step 5: Export from core barrel**

Modify `packages/core/src/index.ts` — add:

```typescript
export { resolveStateFields } from "./state/resolve-state-fields.js"
export type { ResolveStateFieldsOptions } from "./state/resolve-state-fields.js"
```

Add to type exports:

```typescript
export type {
  // ... existing ...
  ResolvedStateField,
  StateFieldReducer,
} from "./types.js"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/resolve-state-fields.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/state/resolve-state-fields.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/test/resolve-state-fields.test.ts
git commit -m "feat(core): resolve state field reducers from defaults via convention"
```

---

### Task 6: State Discovery (CLI Runtime)

**Files:**
- Create: `packages/cli/src/lib/runtime/state-discovery.ts`
- Test: `packages/cli/test/state-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/state-discovery.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { discoverStateDefinition } from "../src/lib/runtime/state-discovery"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-state-disc-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("discoverStateDefinition", () => {
  test("returns null when no state.ts exists", async () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })

    const result = await discoverStateDefinition({ routeDir })
    expect(result).toBeNull()
  })

  test("discovers state.ts and extracts defaults", async () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(
      join(routeDir, "state.ts"),
      `
import { z } from "zod"
export default z.object({
  context: z.string().default(""),
  results: z.array(z.string()).default([]),
})
`,
    )

    const result = await discoverStateDefinition({ routeDir })

    expect(result).not.toBeNull()
    expect(result!.defaults.get("context")).toBe("")
    expect(result!.defaults.get("results")).toEqual([])
  })

  test("discovers reducer overrides from reducers/ folder", async () => {
    const routeDir = join(tempDir, "route")
    const reducersDir = join(routeDir, "reducers")
    mkdirSync(reducersDir, { recursive: true })
    writeFileSync(
      join(routeDir, "state.ts"),
      `
import { z } from "zod"
export default z.object({
  tags: z.array(z.string()).default([]),
})
`,
    )
    writeFileSync(
      join(reducersDir, "tags.ts"),
      `
export default (current: string[], incoming: string[]) => incoming
`,
    )

    const result = await discoverStateDefinition({ routeDir })

    expect(result).not.toBeNull()
    expect(result!.reducerOverrides.has("tags")).toBe(true)
    const reducer = result!.reducerOverrides.get("tags")!
    expect(reducer(["a"], ["b"])).toEqual(["b"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run test/state-discovery.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `state-discovery.ts`**

Create `packages/cli/src/lib/runtime/state-discovery.ts`:

```typescript
import { existsSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

import { registerTsxLoader } from "./register-tsx-loader.js"

export interface DiscoveredStateDefinition {
  readonly defaults: Map<string, unknown>
  readonly reducerOverrides: Map<string, (current: unknown, incoming: unknown) => unknown>
}

export async function discoverStateDefinition(options: {
  readonly routeDir: string
}): Promise<DiscoveredStateDefinition | null> {
  const stateFile = join(options.routeDir, "state.ts")
  if (!existsSync(stateFile)) return null

  await registerTsxLoader()

  const stateModule = (await import(pathToFileURL(stateFile).href)) as {
    readonly default?: unknown
  }
  const schema = stateModule.default
  if (!schema || typeof schema !== "object") return null

  const defaults = extractDefaults(schema)
  if (!defaults) return null

  const reducerOverrides = await discoverReducerOverrides(options.routeDir)

  return { defaults, reducerOverrides }
}

function extractDefaults(schema: unknown): Map<string, unknown> | null {
  // Standard Schema v1 check: schema has ~standard property
  if (!isStandardSchema(schema)) {
    // Fallback: try to get defaults via zod-compatible .parse({}) pattern
    if (hasParseMethod(schema)) {
      try {
        const parsed = schema.parse({})
        if (typeof parsed === "object" && parsed !== null) {
          return new Map(Object.entries(parsed))
        }
      } catch {
        return null
      }
    }
    return null
  }

  // Use Standard Schema validate with empty object to extract defaults
  const result = schema["~standard"].validate({})
  if ("issues" in result) return null
  if (typeof result.value !== "object" || result.value === null) return null

  return new Map(Object.entries(result.value as Record<string, unknown>))
}

function isStandardSchema(
  value: unknown,
): value is { "~standard": { validate: (input: unknown) => { value?: unknown; issues?: unknown } } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    typeof (value as Record<string, unknown>)["~standard"] === "object"
  )
}

function hasParseMethod(value: unknown): value is { parse: (input: unknown) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "parse" in value &&
    typeof (value as Record<string, unknown>).parse === "function"
  )
}

async function discoverReducerOverrides(
  routeDir: string,
): Promise<Map<string, (current: unknown, incoming: unknown) => unknown>> {
  const reducersDir = join(routeDir, "reducers")
  const overrides = new Map<string, (current: unknown, incoming: unknown) => unknown>()

  if (!existsSync(reducersDir)) return overrides

  const entries = readdirSync(reducersDir)
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue
    if (entry.endsWith(".d.ts")) continue

    const fieldName = basename(entry, ".ts")
    const filePath = join(reducersDir, entry)
    const mod = (await import(pathToFileURL(filePath).href)) as { readonly default?: unknown }

    if (typeof mod.default === "function") {
      overrides.set(fieldName, mod.default as (current: unknown, incoming: unknown) => unknown)
    }
  }

  return overrides
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run test/state-discovery.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/state-discovery.ts packages/cli/test/state-discovery.test.ts
git commit -m "feat(cli): discover state.ts and reducers/ folder conventions"
```

---

### Task 7: State Adapter (LangChain)

**Files:**
- Create: `packages/langchain/src/state-adapter.ts`
- Modify: `packages/langchain/src/index.ts`
- Test: `packages/langchain/test/state-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/langchain/test/state-adapter.test.ts`:

```typescript
import type { ResolvedStateField } from "@dawn-ai/core"
import { describe, expect, test } from "vitest"

import { materializeStateSchema } from "../src/state-adapter"

describe("materializeStateSchema", () => {
  test("produces an annotation root with messages + custom fields", () => {
    const fields: ResolvedStateField[] = [
      { name: "context", reducer: "replace", default: "" },
      { name: "results", reducer: "append", default: [] },
    ]

    const annotation = materializeStateSchema(fields)

    // AnnotationRoot has a .spec property
    expect(annotation).toBeDefined()
    expect(annotation.spec).toBeDefined()
    // Messages are always included
    expect("messages" in annotation.spec).toBe(true)
    // Custom fields are included
    expect("context" in annotation.spec).toBe(true)
    expect("results" in annotation.spec).toBe(true)
  })

  test("replace reducer uses last-write-wins semantics", () => {
    const fields: ResolvedStateField[] = [
      { name: "status", reducer: "replace", default: "idle" },
    ]

    const annotation = materializeStateSchema(fields)
    const statusSpec = annotation.spec.status

    // Access the reducer via the annotation's internal structure
    expect(statusSpec).toBeDefined()
  })

  test("append reducer accumulates arrays", () => {
    const fields: ResolvedStateField[] = [
      { name: "items", reducer: "append", default: [] },
    ]

    const annotation = materializeStateSchema(fields)
    expect(annotation.spec.items).toBeDefined()
  })

  test("custom function reducer is passed through", () => {
    const customReducer = (current: unknown, incoming: unknown) => incoming
    const fields: ResolvedStateField[] = [
      { name: "data", reducer: customReducer, default: null },
    ]

    const annotation = materializeStateSchema(fields)
    expect(annotation.spec.data).toBeDefined()
  })

  test("returns annotation with empty fields when no custom state", () => {
    const annotation = materializeStateSchema([])

    expect(annotation.spec).toBeDefined()
    expect("messages" in annotation.spec).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/langchain && npx vitest run test/state-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `state-adapter.ts`**

Create `packages/langchain/src/state-adapter.ts`:

```typescript
import type { ResolvedStateField } from "@dawn-ai/core"
import { Annotation, MessagesAnnotation } from "@langchain/langgraph"
import type { AnnotationRoot } from "@langchain/langgraph"

export function materializeStateSchema(
  fields: readonly ResolvedStateField[],
): AnnotationRoot<any> {
  const spec: Record<string, any> = {
    ...MessagesAnnotation.spec,
  }

  for (const field of fields) {
    if (typeof field.reducer === "function") {
      spec[field.name] = Annotation({
        reducer: field.reducer as (left: unknown, right: unknown) => unknown,
        default: () => field.default,
      })
    } else if (field.reducer === "append") {
      spec[field.name] = Annotation({
        reducer: (prev: unknown[], next: unknown[]) => [
          ...(prev ?? []),
          ...(Array.isArray(next) ? next : [next]),
        ],
        default: () => (field.default ?? []) as unknown[],
      })
    } else {
      spec[field.name] = Annotation({
        reducer: (_: unknown, next: unknown) => next,
        default: () => field.default,
      })
    }
  }

  return Annotation.Root(spec)
}
```

- [ ] **Step 4: Export from langchain barrel**

Modify `packages/langchain/src/index.ts` — add:

```typescript
export { materializeStateSchema } from "./state-adapter.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/langchain && npx vitest run test/state-adapter.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/state-adapter.ts packages/langchain/src/index.ts packages/langchain/test/state-adapter.test.ts
git commit -m "feat(langchain): materialize Dawn state fields into LangChain AnnotationRoot"
```

---

### Task 8: Wire State Through Agent Execution

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Update `materializeAgent` to accept state fields**

Modify `packages/langchain/src/agent-adapter.ts`:

Add import at top:

```typescript
import type { ResolvedStateField } from "@dawn-ai/core"
import { materializeStateSchema } from "./state-adapter.js"
```

Update `materializeAgent` signature and body:

```typescript
async function materializeAgent(
  descriptor: DawnAgent,
  tools: readonly DawnToolDefinition[],
  stateFields?: readonly ResolvedStateField[],
): Promise<AgentLike> {
  const cached = materializedAgents.get(descriptor)
  if (cached) {
    return cached
  }

  const { createReactAgent } = await import("@langchain/langgraph/prebuilt")
  const { ChatOpenAI } = await import("@langchain/openai")

  const langchainTools = tools.map((tool) => convertToolToLangChain(tool))

  const llm = new ChatOpenAI({
    model: descriptor.model,
  })

  const agentOptions: Record<string, unknown> = {
    llm,
    tools: langchainTools,
    prompt: descriptor.systemPrompt,
  }

  if (stateFields && stateFields.length > 0) {
    agentOptions.stateSchema = materializeStateSchema(stateFields)
  }

  const compiled = createReactAgent(agentOptions)

  materializedAgents.set(descriptor, compiled as unknown as AgentLike)
  return compiled as unknown as AgentLike
}
```

Update `executeAgent` to accept and pass state fields:

```typescript
export async function executeAgent(options: {
  readonly entry: unknown
  readonly input: unknown
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly stateFields?: readonly ResolvedStateField[]
  readonly tools: readonly DawnToolDefinition[]
}): Promise<unknown> {
```

And in the `isDawnAgent` branch:

```typescript
if (isDawnAgent(options.entry)) {
  const materializedAgent = await materializeAgent(options.entry, options.tools, options.stateFields)
  const messages = [new HumanMessage(formatAgentMessage(agentInput))]
  return await materializedAgent.invoke({ messages }, config)
}
```

- [ ] **Step 2: Update `execute-route.ts` to discover and pass state**

Modify `packages/cli/src/lib/runtime/execute-route.ts`:

Add import:

```typescript
import { resolveStateFields } from "@dawn-ai/core"
import { discoverStateDefinition } from "./state-discovery.js"
```

In `executeRouteAtResolvedPath` (the function that calls `executeAgent`), after tool discovery and before the agent invocation, add state discovery:

```typescript
// Discover state (only for agent routes)
let stateFields: readonly ResolvedStateField[] | undefined
if (routeModule.kind === "agent") {
  const stateDefinition = await discoverStateDefinition({ routeDir })
  if (stateDefinition) {
    stateFields = resolveStateFields({
      defaults: stateDefinition.defaults,
      reducerOverrides: stateDefinition.reducerOverrides,
    })
  }
}
```

Pass `stateFields` to `executeAgent`:

```typescript
return await executeAgent({
  entry: routeModule.entry,
  input: options.input,
  routeParamNames,
  signal,
  stateFields,
  tools,
})
```

- [ ] **Step 3: Run full test suite**

Run: `cd packages/cli && npx vitest run && cd ../langchain && npx vitest run`
Expected: ALL PASS (existing tests still pass since stateFields is optional)

- [ ] **Step 4: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat: wire state discovery through agent execution pipeline"
```

---

### Task 9: Inject Generated Schema into Tool Discovery

**Files:**
- Modify: `packages/cli/src/lib/runtime/tool-discovery.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Add schema injection to tool discovery**

Modify `packages/cli/src/lib/runtime/tool-discovery.ts` — add a function to merge generated schemas:

```typescript
export function injectGeneratedSchemas(
  tools: readonly DiscoveredToolDefinition[],
  generatedSchemas: Record<string, unknown>,
): readonly DiscoveredToolDefinition[] {
  return tools.map((tool) => {
    // User-exported schema takes priority
    if (tool.schema) return tool

    const generated = generatedSchemas[tool.name]
    if (!generated) return tool

    return { ...tool, schema: generated }
  })
}
```

- [ ] **Step 2: Load generated schemas in execute-route**

In `packages/cli/src/lib/runtime/execute-route.ts`, after tool discovery, attempt to load generated schemas:

```typescript
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { injectGeneratedSchemas } from "./tool-discovery.js"
```

After `discoverToolDefinitions`:

```typescript
// Inject codegen-generated schemas (for tools without explicit schema exports)
const schemaManifestPath = join(appRoot, ".dawn", "routes", routeId, "tools.json")
let discoveredTools = tools
if (existsSync(schemaManifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(schemaManifestPath, "utf-8"))
    discoveredTools = injectGeneratedSchemas(tools, manifest)
  } catch {
    // Fall through — generated schema is best-effort
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd packages/cli && npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/runtime/tool-discovery.ts packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): inject codegen-generated JSON Schema into tool definitions"
```

---

### Task 10: Render State Type Manifest

**Files:**
- Create: `packages/core/src/typegen/render-state-types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/render-state-types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/render-state-types.test.ts`:

```typescript
import { describe, expect, test } from "vitest"

import { renderStateTypes } from "../src/typegen/render-state-types"

describe("renderStateTypes", () => {
  test("renders empty interface when no routes have state", () => {
    const result = renderStateTypes([])
    expect(result).toContain("export interface DawnRouteState {}")
  })

  test("renders state type for a route", () => {
    const result = renderStateTypes([
      {
        pathname: "/hello/[tenant]",
        fields: [
          { name: "context", type: "string" },
          { name: "confidence", type: "number" },
          { name: "results", type: "string[]" },
        ],
      },
    ])

    expect(result).toContain('"/hello/[tenant]"')
    expect(result).toContain("context: string")
    expect(result).toContain("confidence: number")
    expect(result).toContain("results: string[]")
  })

  test("renders RouteState utility type", () => {
    const result = renderStateTypes([])
    expect(result).toContain("export type RouteState<P extends DawnRoutePath> = DawnRouteState[P]")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run test/render-state-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `render-state-types.ts`**

Create `packages/core/src/typegen/render-state-types.ts`:

```typescript
export interface RouteStateFields {
  readonly pathname: string
  readonly fields: readonly { readonly name: string; readonly type: string }[]
}

export function renderStateTypes(routeStates: readonly RouteStateFields[]): string {
  const routeStateType = "  export type RouteState<P extends DawnRoutePath> = DawnRouteState[P];"

  if (routeStates.length === 0) {
    return ["  export interface DawnRouteState {}", "", routeStateType, ""].join("\n")
  }

  const routeLines: string[] = []
  for (const route of routeStates) {
    routeLines.push(`    ${JSON.stringify(route.pathname)}: {`)
    for (const field of route.fields) {
      routeLines.push(`      readonly ${field.name}: ${field.type};`)
    }
    routeLines.push("    };")
  }

  return [
    "  export interface DawnRouteState {",
    ...routeLines,
    "  }",
    "",
    routeStateType,
    "",
  ].join("\n")
}
```

- [ ] **Step 4: Export from core barrel**

Modify `packages/core/src/index.ts` — add:

```typescript
export type { RouteStateFields } from "./typegen/render-state-types.js"
export { renderStateTypes } from "./typegen/render-state-types.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/render-state-types.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/typegen/render-state-types.ts packages/core/src/index.ts packages/core/test/render-state-types.test.ts
git commit -m "feat(core): render state type manifest for codegen"
```

---

### Task 11: Update Template with State Example

**Files:**
- Create: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts`
- Modify: `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts`
- Modify: `packages/devkit/templates/app-basic/package.json.template`

- [ ] **Step 1: Create state.ts in template**

Create `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts`:

```typescript
import { z } from "zod"

export default z.object({
  /** Accumulated context from tool call results */
  context: z.string().default(""),
})
```

- [ ] **Step 2: Update generated types to include state**

Modify `packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts`:

```typescript
declare module "dawn:routes" {
  export type DawnRoutePath = "/hello/[tenant]";

  export interface DawnRouteParams {
  "/hello/[tenant]": { tenant: string };
  }

  export interface DawnRouteTools {
    "/hello/[tenant]": {
      readonly greet: (input: { readonly tenant: string; }) => Promise<{ name: string; plan: string; }>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];

  export interface DawnRouteState {
    "/hello/[tenant]": {
      readonly context: string;
    };
  }

  export type RouteState<P extends DawnRoutePath> = DawnRouteState[P];
}
```

- [ ] **Step 3: Add zod to template dependencies**

Modify `packages/devkit/templates/app-basic/package.json.template` — add `zod` to dependencies:

```json
"zod": "^3.24.0"
```

- [ ] **Step 4: Run framework harness tests**

Run: `pnpm test --filter @dawn-ai/devkit`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/devkit/templates/app-basic/src/app/\(public\)/hello/\[tenant\]/state.ts packages/devkit/templates/app-basic/.dawn/dawn.generated.d.ts packages/devkit/templates/app-basic/package.json.template
git commit -m "feat(devkit): add state.ts to basic template with zod schema"
```

---

### Task 12: Consolidate NormalizedRouteModule

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/lib/runtime/load-route-kind.ts`

- [ ] **Step 1: Add canonical type to core**

Modify `packages/core/src/types.ts` — add:

```typescript
export interface NormalizedRouteModule {
  readonly kind: RouteKind
  readonly entry: unknown
  readonly config: Record<string, unknown>
}
```

- [ ] **Step 2: Export from core barrel**

Modify `packages/core/src/index.ts` — add to the type exports:

```typescript
export type { NormalizedRouteModule } from "./types.js"
```

- [ ] **Step 3: Update CLI to import from core**

Modify `packages/cli/src/lib/runtime/load-route-kind.ts`:

Remove the local `NormalizedRouteModule` interface definition (lines 8-12) and add import:

```typescript
import type { NormalizedRouteModule } from "@dawn-ai/core"
```

- [ ] **Step 4: Run CLI tests**

Run: `cd packages/cli && npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts packages/cli/src/lib/runtime/load-route-kind.ts
git commit -m "refactor: consolidate NormalizedRouteModule into @dawn-ai/core"
```

---

### Task 13: Update pack-check and CI Validation

**Files:**
- Modify: `scripts/pack-check.mjs`

- [ ] **Step 1: Update pack-check for new SDK files**

Modify `scripts/pack-check.mjs` — add the new SDK files to the expected dist entries:

Add to the SDK expected files list:

```javascript
"dist/known-model-ids.js",
"dist/known-model-ids.d.ts",
"dist/types.js",
"dist/types.d.ts",
"dist/route-types.js",
"dist/route-types.d.ts",
```

And for core, add:

```javascript
"dist/typegen/extract-tool-schema.js",
"dist/typegen/extract-tool-schema.d.ts",
"dist/typegen/render-state-types.js",
"dist/typegen/render-state-types.d.ts",
"dist/state/resolve-state-fields.js",
"dist/state/resolve-state-fields.d.ts",
```

- [ ] **Step 2: Run pack-check**

Run: `node scripts/pack-check.mjs`
Expected: PASS

- [ ] **Step 3: Run full CI locally**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/pack-check.mjs
git commit -m "chore: update pack-check for new SDK and core dist files"
```

---

### Task 14: Integration Test — Full Pipeline

**Files:**
- Create: `test/integration/dx-improvements.test.ts`

- [ ] **Step 1: Write integration test**

Create `test/integration/dx-improvements.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractToolSchemasForRoute, extractToolTypesForRoute } from "@dawn-ai/core"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-dx-integration-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("DX improvements integration", () => {
  test("tool schema generation produces valid JSON Schema for LLM", async () => {
    const routeDir = join(tempDir, "route")
    const toolsDir = join(routeDir, "tools")
    mkdirSync(toolsDir, { recursive: true })

    writeFileSync(
      join(toolsDir, "search.ts"),
      `
/**
 * Searches the knowledge base for relevant documents.
 */
export default async (input: {
  /** The search query string */
  query: string
  /** Maximum number of results */
  limit?: number
  /** Filter by category */
  category: "docs" | "code" | "issues"
}) => {
  return { results: [], total: 0 }
}
`,
    )

    const schemas = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(schemas).toHaveLength(1)
    const schema = schemas[0]!

    expect(schema.name).toBe("search")
    expect(schema.description).toBe("Searches the knowledge base for relevant documents.")
    expect(schema.parameters.type).toBe("object")
    expect(schema.parameters.additionalProperties).toBe(false)
    expect(schema.parameters.properties.query).toEqual({
      type: "string",
      description: "The search query string",
    })
    expect(schema.parameters.properties.limit).toEqual({
      type: "number",
      description: "Maximum number of results",
    })
    expect(schema.parameters.properties.category).toEqual({
      type: "string",
      enum: ["docs", "code", "issues"],
      description: "Filter by category",
    })
    expect(schema.parameters.required).toEqual(["query", "category"])
  })

  test("type extraction and schema extraction produce consistent results", async () => {
    const routeDir = join(tempDir, "route")
    const toolsDir = join(routeDir, "tools")
    mkdirSync(toolsDir, { recursive: true })

    writeFileSync(
      join(toolsDir, "greet.ts"),
      `
/** Greets someone. */
export default async (input: { name: string }) => {
  return { message: "hello" }
}
`,
    )

    const types = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })
    const schemas = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(types).toHaveLength(1)
    expect(schemas).toHaveLength(1)
    expect(types[0]!.name).toBe(schemas[0]!.name)
    expect(types[0]!.description).toBe(schemas[0]!.description)
  })
})
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run test/integration/dx-improvements.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add test/integration/dx-improvements.test.ts
git commit -m "test: add integration test for DX improvements pipeline"
```
