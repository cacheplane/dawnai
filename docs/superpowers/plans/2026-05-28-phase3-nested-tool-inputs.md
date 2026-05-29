# Nested-Object Tool Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support nested objects, arrays-of-objects, `Record<string,T>` maps, and object unions (arbitrary depth, depth-capped) in tool input schemas, end-to-end across the JSON-Schema extractor and the runtime Zod converter.

**Architecture:** Three conversion layers turn a tool's TS input type into what the LLM sees. (1) `extract-tool-schema.ts` (TS type → JSON Schema) and (3) `tool-converter.ts` (JSON Schema → Zod) only handle flat shapes and need recursion. (2) `extract-tool-types.ts` (TS type → TS string) already nests via `checker.typeToString()` and only needs a no-truncation flag. The shared schema node `JsonSchemaProperty` in `@dawn-ai/core` gains `anyOf` + schema-valued `additionalProperties`; the converter drops its duplicate private interface and imports the canonical one.

**Tech Stack:** TypeScript compiler API (`typescript`), Zod (`zod`), vitest, biome. Packages: `@dawn-ai/core`, `@dawn-ai/langchain`.

**Spec:** `docs/superpowers/specs/2026-05-28-phase3-nested-tool-inputs-design.md`

**Constants:** depth cap = `8` (shared across both recursions; beyond it, fall back to `string` / `z.string()`).

---

## File map

**Modified — `@dawn-ai/core`:**
- `packages/core/src/types.ts` — widen `JsonSchemaProperty` (`type` optional, `additionalProperties: boolean | JsonSchemaProperty`, new `anyOf`).
- `packages/core/src/typegen/extract-tool-schema.ts` — `tsTypeToJsonSchema` gains object / Record / object-union branches + a `depth` param.
- `packages/core/src/typegen/extract-tool-types.ts` — pass `ts.TypeFormatFlags.NoTruncation` to `typeToString`.
- `packages/core/test/extract-tool-schema.test.ts` — nested cases.
- `packages/core/test/extract-tool-types.test.ts` — nested rendering + no-truncation.

**Modified — `@dawn-ai/langchain`:**
- `packages/langchain/src/tool-converter.ts` — import `JsonSchemaProperty` from core; `jsonSchemaFieldToZod` gains object / array-of-object / Record / anyOf branches + `depth`.
- `packages/langchain/test/tool-converter.test.ts` — nested cases (create if absent).

**Integration:**
- `examples/chat/server/src/app/chat/tools/` — one fixture tool with a nested input (for the runtime-contract/typegen assertion). Final task confirms exact location against the repo.

---

## Task 1: Widen `JsonSchemaProperty` and converge the converter onto it

**Files:**
- Modify: `packages/core/src/types.ts` (the `JsonSchemaProperty` interface, currently ~lines 90-98)
- Modify: `packages/langchain/src/tool-converter.ts` (remove private `JsonSchemaObject` + inline field type; import from core)

- [ ] **Step 1: Read the current interface**

Run: `grep -n "interface JsonSchemaProperty" -A9 packages/core/src/types.ts`
Expected: shows `type: string` (required), `additionalProperties?: boolean`, no `anyOf`.

- [ ] **Step 2: Replace the interface**

In `packages/core/src/types.ts`, replace the `JsonSchemaProperty` interface with:

```ts
export interface JsonSchemaProperty {
  readonly type?: string
  readonly description?: string
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchemaProperty
  readonly anyOf?: readonly JsonSchemaProperty[]
  readonly enum?: readonly string[]
}
```

(Only two lines change vs today: `type?` becomes optional and `additionalProperties` widens to `boolean | JsonSchemaProperty`; `anyOf` is new. `items`/`properties`/`required`/`enum` already exist.)

- [ ] **Step 3: Typecheck core to surface fallout**

Run: `pnpm --filter @dawn-ai/core typecheck`
Expected: clean. `tsTypeToJsonSchema`'s return literals all set `type`, so making it optional is backward-compatible. If any consumer assumed `type` always present and errors, note it — it will be handled in the relevant task.

- [ ] **Step 4: Point the converter at the canonical type**

In `packages/langchain/src/tool-converter.ts`, delete the private `interface JsonSchemaObject { ... }` (~lines 75-79) and the inline `prop: { readonly type?: string; readonly items?: unknown }` parameter type on `jsonSchemaFieldToZod`. Add at the top with the other imports:

```ts
import type { JsonSchemaProperty } from "@dawn-ai/core"
```

Change `isJsonSchemaObject` to return `value is JsonSchemaProperty & { type: "object" }` and change `jsonSchemaToZod(schema: JsonSchemaObject)` → `jsonSchemaToZod(schema: JsonSchemaProperty)`, and `jsonSchemaFieldToZod(prop: {...})` → `jsonSchemaFieldToZod(prop: JsonSchemaProperty)`. Leave the bodies as-is for now (later tasks extend them).

- [ ] **Step 5: Confirm `@dawn-ai/core` is a dependency of `@dawn-ai/langchain`**

Run: `grep '"@dawn-ai/core"' packages/langchain/package.json`
Expected: present under dependencies. (It already is — the adapter imports core types.) If absent, add `"@dawn-ai/core": "workspace:*"` to dependencies and run `pnpm install`.

- [ ] **Step 6: Typecheck + lint both packages**

Run: `pnpm --filter @dawn-ai/core --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/core --filter @dawn-ai/langchain lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/langchain/src/tool-converter.ts
git commit -m "refactor(core,langchain): widen JsonSchemaProperty (anyOf, schema additionalProperties); converge converter onto it"
```

---

## Task 2: Nested objects in `extract-tool-schema` (+ depth cap)

**Context:** `tsTypeToJsonSchema(type, checker)` (currently ~lines 127-162 of `packages/core/src/typegen/extract-tool-schema.ts`) handles union→enum/optional, array→items, primitives, and falls back to `{ type: "string" }`. Add an object branch that recurses into properties, threading a `depth` parameter with a cap.

**Files:**
- Modify: `packages/core/src/typegen/extract-tool-schema.ts`
- Test: `packages/core/test/extract-tool-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Look at `packages/core/test/extract-tool-schema.test.ts` to match its fixture style (it compiles a tool source string and asserts the extracted schema). Add:

```ts
it("extracts a nested object property", async () => {
  const schemas = await extractSchemasFromSource(`
    /** Search tool */
    export default async function search(input: {
      filter: { status: "open" | "closed"; limit: number }
    }) { return input }
  `)
  const filter = schemas[0]?.parameters.properties.filter
  expect(filter?.type).toBe("object")
  expect(filter?.properties?.status).toEqual({ type: "string", enum: ["open", "closed"] })
  expect(filter?.properties?.limit).toEqual({ type: "number" })
  expect(filter?.required).toEqual(["status", "limit"])
  expect(filter?.additionalProperties).toBe(false)
})
```

If the test file has no `extractSchemasFromSource` helper, use the existing pattern in that file for compiling a source string through `extractToolSchemasForRoute` (write the source to a temp `tools/<name>.ts`). Match what's already there rather than inventing a helper.

- [ ] **Step 2: Run the test (expect fail)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-schema`
Expected: FAIL — `filter.type` is `"string"` (current fallback), not `"object"`.

- [ ] **Step 3: Add the depth-capped object branch**

In `extract-tool-schema.ts`, change the signature and add the object branch. Replace the function header and the final fallback:

```ts
const MAX_SCHEMA_DEPTH = 8

function tsTypeToJsonSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
): JsonSchemaProperty {
  if (depth > MAX_SCHEMA_DEPTH) {
    return { type: "string" }
  }

  // Strip undefined from unions (optional properties resolve as T | undefined)
  if (type.isUnion()) {
    const nonUndefined = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined))
    if (nonUndefined.length === 1 && nonUndefined[0]) {
      return tsTypeToJsonSchema(nonUndefined[0], checker, depth)
    }

    const allStringLiterals = nonUndefined.every((t) => t.isStringLiteral())
    if (allStringLiterals && nonUndefined.length > 0) {
      const enumValues = nonUndefined.map((t) => (t as ts.StringLiteralType).value)
      return { type: "string", enum: enumValues }
    }
  }

  // Array type
  if (checker.isArrayType(type)) {
    const typeArgs = (type as ts.TypeReference).typeArguments
    const elementType = typeArgs && typeArgs.length > 0 && typeArgs[0]
    const items = elementType
      ? tsTypeToJsonSchema(elementType, checker, depth + 1)
      : { type: "string" }
    return { type: "array", items }
  }

  const typeString = checker.typeToString(type)
  if (typeString === "string") return { type: "string" }
  if (typeString === "number") return { type: "number" }
  if (typeString === "boolean") return { type: "boolean" }

  // Object type: recurse into named properties.
  const objectSchema = tryObjectSchema(type, checker, depth)
  if (objectSchema) return objectSchema

  // Fallback to string for unknown types
  return { type: "string" }
}

function tryObjectSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): JsonSchemaProperty | undefined {
  const props = type.getProperties()
  if (props.length === 0) return undefined

  const properties: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []

  for (const prop of props) {
    const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? prop.declarations?.[0] ?? ({} as ts.Node))
    const schema = tsTypeToJsonSchema(propType, checker, depth + 1)
    const propDoc = ts.displayPartsToString(prop.getDocumentationComment(checker))
    if (propDoc) schema.description = propDoc
    properties[prop.getName()] = schema

    const declarations = prop.getDeclarations()
    const isOptional =
      declarations !== undefined &&
      declarations.length > 0 &&
      declarations.some((d) => ts.isPropertySignature(d) && d.questionToken !== undefined)
    if (!isOptional) required.push(prop.getName())
  }

  return { type: "object", properties, required, additionalProperties: false }
}
```

Note: `schema.description = propDoc` mutates the returned object — `tsTypeToJsonSchema` returns fresh object literals so this is safe (matches the existing top-level loop pattern at lines 92-95). Ensure the returned objects are mutable (`JsonSchemaProperty` fields are `readonly`; build a local `let` mutable object inside `tryObjectSchema` if the compiler complains, or cast — match how the top-level loop currently assigns `schema.description`).

- [ ] **Step 4: Run the test (expect pass)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-schema`
Expected: PASS.

- [ ] **Step 5: Add the depth-cap + array-of-object tests**

```ts
it("extracts an array of objects", async () => {
  const schemas = await extractSchemasFromSource(`
    export default async function f(input: { items: { id: number; label: string }[] }) { return input }
  `)
  const items = schemas[0]?.parameters.properties.items
  expect(items?.type).toBe("array")
  expect(items?.items?.type).toBe("object")
  expect(items?.items?.properties?.id).toEqual({ type: "number" })
})

it("falls back to string past the depth cap", async () => {
  // 10 levels of nesting; level >8 must degrade to string
  const deep = Array.from({ length: 10 }).reduce((inner) => `{ n: ${inner} }`, "string")
  const schemas = await extractSchemasFromSource(`
    export default async function f(input: { root: ${deep} }) { return input }
  `)
  // Walk down .properties.n until a string type appears before TS depth would explode
  expect(JSON.stringify(schemas[0]?.parameters.properties.root)).toContain('"type":"string"')
})
```

- [ ] **Step 6: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-schema`
Expected: PASS.

- [ ] **Step 7: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/core typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/typegen/extract-tool-schema.ts packages/core/test/extract-tool-schema.test.ts
git commit -m "feat(core): extract nested objects + arrays-of-objects into tool JSON schema (depth-capped)"
```

---

## Task 3: `Record<string,T>` maps in `extract-tool-schema`

**Context:** `Record<string, T>` has no named properties but a string index type. `type.getStringIndexType()` returns `T`. Detect this in `tryObjectSchema` and emit `additionalProperties: <schema of T>`.

**Files:**
- Modify: `packages/core/src/typegen/extract-tool-schema.ts`
- Test: `packages/core/test/extract-tool-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("extracts a Record<string,T> map as additionalProperties", async () => {
  const schemas = await extractSchemasFromSource(`
    export default async function f(input: { meta: Record<string, number> }) { return input }
  `)
  const meta = schemas[0]?.parameters.properties.meta
  expect(meta?.type).toBe("object")
  expect(meta?.additionalProperties).toEqual({ type: "number" })
})

it("extracts a Record of objects", async () => {
  const schemas = await extractSchemasFromSource(`
    export default async function f(input: { byId: Record<string, { name: string }> }) { return input }
  `)
  const byId = schemas[0]?.parameters.properties.byId
  expect(byId?.additionalProperties).toMatchObject({ type: "object" })
})
```

- [ ] **Step 2: Run the test (expect fail)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-schema`
Expected: FAIL — `meta` extracted as `{ type: "string" }` or an empty object (Record has no named properties, so `tryObjectSchema` returns undefined → string fallback).

- [ ] **Step 3: Handle the index signature in `tryObjectSchema`**

Replace the early `if (props.length === 0) return undefined` and add index-type handling:

```ts
function tryObjectSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): JsonSchemaProperty | undefined {
  const props = type.getProperties()
  const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String)

  // Record<string, T> (no named props, has a string index signature)
  if (props.length === 0 && indexType) {
    return {
      type: "object",
      additionalProperties: tsTypeToJsonSchema(indexType, checker, depth + 1),
    }
  }

  if (props.length === 0) return undefined

  const properties: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []
  for (const prop of props) {
    const propType = checker.getTypeOfSymbolAtLocation(
      prop,
      prop.valueDeclaration ?? prop.declarations?.[0] ?? ({} as ts.Node),
    )
    const schema = tsTypeToJsonSchema(propType, checker, depth + 1)
    const propDoc = ts.displayPartsToString(prop.getDocumentationComment(checker))
    if (propDoc) schema.description = propDoc
    properties[prop.getName()] = schema
    const declarations = prop.getDeclarations()
    const isOptional =
      declarations !== undefined &&
      declarations.length > 0 &&
      declarations.some((d) => ts.isPropertySignature(d) && d.questionToken !== undefined)
    if (!isOptional) required.push(prop.getName())
  }
  return { type: "object", properties, required, additionalProperties: false }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-schema`
Expected: PASS.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/core typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/typegen/extract-tool-schema.ts packages/core/test/extract-tool-schema.test.ts
git commit -m "feat(core): extract Record<string,T> maps as additionalProperties schema"
```

---

## Task 4: Object unions (`anyOf`) in `extract-tool-schema`

**Context:** A union whose members are object shapes (not all string-literals, after stripping `undefined`) should become `anyOf: [<member schemas>]`.

**Files:**
- Modify: `packages/core/src/typegen/extract-tool-schema.ts`
- Test: `packages/core/test/extract-tool-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("extracts an object union as anyOf", async () => {
  const schemas = await extractSchemasFromSource(`
    export default async function f(input: {
      action: { kind: "create"; name: string } | { kind: "delete"; id: number }
    }) { return input }
  `)
  const action = schemas[0]?.parameters.properties.action
  expect(action?.anyOf).toHaveLength(2)
  expect(action?.anyOf?.[0]?.type).toBe("object")
  expect(action?.anyOf?.[1]?.properties?.id).toEqual({ type: "number" })
})
```

- [ ] **Step 2: Run the test (expect fail)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-schema`
Expected: FAIL — `action` falls back to `{ type: "string" }`.

- [ ] **Step 3: Add the union→anyOf branch**

In `tsTypeToJsonSchema`, inside the existing `if (type.isUnion()) { ... }` block, after the string-literal-enum check, add:

```ts
    // Union of object shapes → anyOf
    if (nonUndefined.length > 1) {
      const allObjects = nonUndefined.every(
        (t) => t.getProperties().length > 0 || checker.getIndexTypeOfType(t, ts.IndexKind.String),
      )
      if (allObjects) {
        return {
          anyOf: nonUndefined.map((t) => tsTypeToJsonSchema(t, checker, depth + 1)),
        }
      }
    }
```

(Place this immediately after the `allStringLiterals` block, still inside `if (type.isUnion())`. Mixed unions that are neither all-string-literal nor all-object fall through to the string fallback, as designed.)

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-schema`
Expected: PASS.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/core typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/typegen/extract-tool-schema.ts packages/core/test/extract-tool-schema.test.ts
git commit -m "feat(core): extract object unions as anyOf in tool JSON schema"
```

---

## Task 5: No-truncation TS type rendering in `extract-tool-types`

**Context:** Layer 2 already renders nested types via `checker.typeToString(paramType)` (line 69). But TypeScript truncates long types with `...` by default, which would corrupt the generated `inputType` for big nested shapes. Pass `ts.TypeFormatFlags.NoTruncation`.

**Files:**
- Modify: `packages/core/src/typegen/extract-tool-types.ts`
- Test: `packages/core/test/extract-tool-types.test.ts`

- [ ] **Step 1: Write the failing test**

Match the existing fixture style in `extract-tool-types.test.ts`. Add:

```ts
it("renders a nested object input type in full (no truncation)", async () => {
  const types = await extractTypesFromSource(`
    export default async function f(input: {
      filter: { status: "open" | "closed"; tags: string[]; range: { min: number; max: number } }
    }) { return input }
  `)
  const t = types[0]?.inputType ?? ""
  expect(t).toContain("filter")
  expect(t).toContain("status")
  expect(t).toContain("range")
  expect(t).not.toContain("...") // truncation marker must be absent
})
```

If there's no `extractTypesFromSource` helper, follow the file's existing compile-from-source pattern.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @dawn-ai/core test extract-tool-types`
Expected: likely PASS for `contains` assertions but the point is to lock in no-truncation; if the nested type is short it may already pass. Make the fixture large enough that default truncation would trigger (the `range` + `tags` + `status` combo exceeds the ~100-char default). If it passes already, proceed — the next step still hardens it.

- [ ] **Step 3: Add the NoTruncation flag**

In `extract-tool-types.ts`, change line ~69:

```ts
      inputType = checker.typeToString(paramType, undefined, ts.TypeFormatFlags.NoTruncation)
```

And the output type at line ~81:

```ts
      outputType: checker.typeToString(outputType, undefined, ts.TypeFormatFlags.NoTruncation),
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/core test extract-tool-types`
Expected: PASS, no `...` in output.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/core typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/typegen/extract-tool-types.ts packages/core/test/extract-tool-types.test.ts
git commit -m "feat(core): render nested tool input types without truncation"
```

---

## Task 6: Nested objects + arrays-of-objects in the runtime converter

**Context:** `jsonSchemaFieldToZod` (now typed `(prop: JsonSchemaProperty)` after Task 1) handles string/number/boolean/array-of-primitive and falls to `z.unknown()`. Add object + array-of-object recursion, depth-capped.

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Test: `packages/langchain/test/tool-converter.test.ts` (create if it doesn't exist)

- [ ] **Step 1: Confirm/create the test file**

Run: `ls packages/langchain/test/tool-converter.test.ts 2>/dev/null || echo MISSING`
If MISSING, create it with this header (match the import path used elsewhere in the package's tests):

```ts
import { describe, expect, it } from "vitest"
import { z } from "zod"
// jsonSchemaToZod is currently module-private. If it is not exported, export it
// from tool-converter.ts with `export` so tests can target it directly.
import { jsonSchemaToZod } from "../src/tool-converter.js"
```

If `jsonSchemaToZod` is not exported, add `export` to its declaration in `tool-converter.ts` in this step and commit that with the task.

- [ ] **Step 2: Write the failing test**

```ts
describe("jsonSchemaToZod nesting", () => {
  it("builds a nested object schema that validates", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" }, limit: { type: "number" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
      required: ["filter"],
      additionalProperties: false,
    })
    const parsed = zodSchema.parse({ filter: { status: "open", limit: 5 } })
    expect(parsed).toEqual({ filter: { status: "open", limit: 5 } })
    expect(() => zodSchema.parse({ filter: { limit: 5 } })).toThrow() // status required
  })

  it("builds an array-of-objects schema", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { id: { type: "number" } }, required: ["id"], additionalProperties: false } },
      },
      required: ["items"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ items: [{ id: 1 }, { id: 2 }] })).toEqual({ items: [{ id: 1 }, { id: 2 }] })
  })
})
```

- [ ] **Step 3: Run the test (expect fail)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: FAIL — nested object becomes `z.unknown()`, so the "status required" assertion does not throw.

- [ ] **Step 4: Extend `jsonSchemaFieldToZod`**

Add a depth param and object/array-of-object branches. The `array` case must recurse into `items` (not just primitive checks):

```ts
const MAX_ZOD_DEPTH = 8

function jsonSchemaFieldToZod(prop: JsonSchemaProperty, depth = 0): z.ZodTypeAny {
  if (depth > MAX_ZOD_DEPTH) return z.string()

  switch (prop.type) {
    case "string":
      return prop.enum && prop.enum.length > 0
        ? z.enum([...prop.enum] as [string, ...string[]])
        : z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array": {
      const items = prop.items
      return items ? z.array(jsonSchemaFieldToZod(items, depth + 1)) : z.array(z.unknown())
    }
    case "object":
      return objectToZod(prop, depth)
    default:
      return z.unknown()
  }
}

function objectToZod(prop: JsonSchemaProperty, depth: number): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(prop.required ?? [])
  for (const [key, sub] of Object.entries(prop.properties ?? {})) {
    let field = jsonSchemaFieldToZod(sub, depth + 1)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return z.object(shape)
}
```

Then refactor the existing top-level `jsonSchemaToZod(schema)` to delegate to `objectToZod(schema, 0)` so there is a single object-building path (DRY):

```ts
function jsonSchemaToZod(schema: JsonSchemaProperty): z.ZodObject<z.ZodRawShape> {
  return objectToZod(schema, 0) as z.ZodObject<z.ZodRawShape>
}
```

(Note: this also adds enum support at the field level, which the old converter lacked — harmless and consistent with the extractor emitting `enum`.)

- [ ] **Step 5: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: PASS.

- [ ] **Step 6: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat(langchain): convert nested objects + arrays-of-objects to zod (depth-capped)"
```

---

## Task 7: `Record` maps (`additionalProperties` schema) in the converter

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Test: `packages/langchain/test/tool-converter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("builds a z.record from additionalProperties schema", () => {
  const zodSchema = jsonSchemaToZod({
    type: "object",
    properties: { meta: { type: "object", additionalProperties: { type: "number" } } },
    required: ["meta"],
    additionalProperties: false,
  })
  expect(zodSchema.parse({ meta: { a: 1, b: 2 } })).toEqual({ meta: { a: 1, b: 2 } })
  expect(() => zodSchema.parse({ meta: { a: "x" } })).toThrow() // values must be numbers
})
```

- [ ] **Step 2: Run the test (expect fail)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: FAIL — `meta` builds an empty `z.object({})` (no properties), ignoring `additionalProperties`.

- [ ] **Step 3: Handle schema-valued `additionalProperties` in `objectToZod`**

At the top of `objectToZod`, before building the shape, handle the Record case:

```ts
function objectToZod(prop: JsonSchemaProperty, depth: number): z.ZodTypeAny {
  // Record<string,T>: object with a schema-valued additionalProperties and no named properties.
  if (
    typeof prop.additionalProperties === "object" &&
    prop.additionalProperties !== null &&
    (!prop.properties || Object.keys(prop.properties).length === 0)
  ) {
    return z.record(z.string(), jsonSchemaFieldToZod(prop.additionalProperties, depth + 1))
  }

  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(prop.required ?? [])
  for (const [key, sub] of Object.entries(prop.properties ?? {})) {
    let field = jsonSchemaFieldToZod(sub, depth + 1)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return z.object(shape)
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: PASS.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat(langchain): convert Record maps (additionalProperties schema) to z.record"
```

---

## Task 8: Object unions (`anyOf`) in the converter

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Test: `packages/langchain/test/tool-converter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("builds a z.union from anyOf", () => {
  const zodSchema = jsonSchemaToZod({
    type: "object",
    properties: {
      action: {
        anyOf: [
          { type: "object", properties: { kind: { type: "string", enum: ["create"] }, name: { type: "string" } }, required: ["kind", "name"], additionalProperties: false },
          { type: "object", properties: { kind: { type: "string", enum: ["delete"] }, id: { type: "number" } }, required: ["kind", "id"], additionalProperties: false },
        ],
      },
    },
    required: ["action"],
    additionalProperties: false,
  })
  expect(zodSchema.parse({ action: { kind: "create", name: "x" } })).toEqual({ action: { kind: "create", name: "x" } })
  expect(zodSchema.parse({ action: { kind: "delete", id: 7 } })).toEqual({ action: { kind: "delete", id: 7 } })
  expect(() => zodSchema.parse({ action: { kind: "create" } })).toThrow() // name required
})
```

- [ ] **Step 2: Run the test (expect fail)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: FAIL — `action` has no `type`, hits `default` → `z.unknown()`, so the throw assertion fails.

- [ ] **Step 3: Handle `anyOf` first in `jsonSchemaFieldToZod`**

At the very top of `jsonSchemaFieldToZod` (after the depth guard, before the `switch`):

```ts
  if (prop.anyOf && prop.anyOf.length > 0) {
    const members = prop.anyOf.map((m) => jsonSchemaFieldToZod(m, depth + 1))
    if (members.length === 1) return members[0] ?? z.unknown()
    return z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: PASS.

- [ ] **Step 5: Full package tests + lint + typecheck**

Run: `pnpm --filter @dawn-ai/langchain test && pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain typecheck`
Expected: all green (existing converter tests must still pass).

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat(langchain): convert object unions (anyOf) to z.union"
```

---

## Task 9: End-to-end integration + full validation

**Context:** Prove a nested tool input flows through extraction → generated types → runtime conversion. Reuse the existing generated/runtime test harness rather than adding a new lane.

**Files:**
- Inspect: `test/generated/run-generated-app.test.ts` and its fixtures (to see how a tool's generated `RouteTools` type is asserted)
- Possibly modify: a fixture app's `tools/` + the corresponding `*.expected.json`/expected-types fixture

- [ ] **Step 1: Locate the generated-types assertion pattern**

Run: `grep -rn "RouteTools\|inputType\|tools/" test/generated/*.test.ts | head -20`
Read the matching test to learn how a fixture tool's generated type is asserted and which fixture file encodes the expectation.

- [ ] **Step 2: Add a nested-input fixture tool**

In the fixture app used by `test/generated/run-generated-app.test.ts` (path discovered in Step 1; commonly `test/generated/fixtures/<app>/src/app/<route>/tools/`), add `searchFilters.ts`:

```ts
/** Search with a structured filter. */
export default async function searchFilters(input: {
  filter: { status: "open" | "closed"; tags: string[] }
  limit?: number
}): Promise<{ count: number }> {
  return { count: input.filter.tags.length }
}
```

- [ ] **Step 3: Update the expected fixture**

Regenerate or hand-update the expected fixture so the generated `RouteTools` includes the nested `inputType`. If the harness supports an update flag, run it (check `test/generated/` for an `UPDATE_FIXTURES`/`--update` convention via `grep -rn "UPDATE" test/generated/`); otherwise edit the `.expected.json` to contain the nested `searchFilters` input type:
`{ filter: { status: "open" | "closed"; tags: string[] }; limit?: number }`.

- [ ] **Step 4: Run the generated test**

Run: `pnpm --filter dawn-tests exec vitest --run test/generated/run-generated-app.test.ts` (adjust the package filter to match the test package name — discover via `grep -rn "\"name\"" test/**/package.json` or the root scripts).
Expected: PASS, fixture shows the nested type.

- [ ] **Step 5: Full workspace build + lint + typecheck + unit tests**

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```
Expected: all green. (If `pnpm build` is not a root script, build the two changed packages: `pnpm --filter @dawn-ai/core --filter @dawn-ai/langchain build`.)

- [ ] **Step 6: Commit**

```bash
git add test/generated
git commit -m "test: end-to-end nested tool input through generated types + runtime"
```

---

## Task 10: Changeset, memory, PR

**Files:**
- Create: `.changeset/phase3-nested-tool-inputs.md`
- Modify: phase status memory (note sub-project 5 shipped)

- [ ] **Step 1: Write the changeset**

Create `.changeset/phase3-nested-tool-inputs.md`:

```md
---
"@dawn-ai/core": minor
"@dawn-ai/langchain": minor
---

Support nested structures in tool input schemas: nested objects, arrays of objects, `Record<string,T>` maps, and object unions (arbitrary depth, capped at 8 levels). Previously any non-flat input type was silently coerced to `string` in both the generated JSON Schema and the runtime Zod schema. Schemas are emitted fully inlined (no `$ref`); `Record` maps and object unions are incompatible with provider strict mode (documented), which Dawn does not currently enable.
```

- [ ] **Step 2: Verify the changeset check passes**

Run: `BASE_REF=origin/main HEAD_REF=feat/phase3-nested-tool-inputs node scripts/check-changesets.mjs`
Expected: "Changesets check passed".

- [ ] **Step 3: Push + open PR**

```bash
git add .changeset/phase3-nested-tool-inputs.md
git commit -m "chore: changeset for nested tool inputs"
git push -u origin feat/phase3-nested-tool-inputs
gh pr create --title "feat: phase3 sub-project 5 — nested-object tool inputs" --body "$(cat <<'EOF'
## Summary
- Nested objects, arrays-of-objects, Record<string,T> maps, and object unions now flow end-to-end through tool input schemas (arbitrary depth, capped at 8).
- Three conversion layers updated: extract-tool-schema (TS→JSON Schema), extract-tool-types (no-truncation rendering), tool-converter (JSON Schema→Zod). The converter now shares the canonical `JsonSchemaProperty` type from @dawn-ai/core.
- Inlined by construction (no $ref). Record maps + object unions documented as strict-mode-incompatible; Dawn is non-strict.

## Test plan
- [x] Unit: extract-tool-schema (nested/array-of-object/Record/anyOf/depth-cap)
- [x] Unit: extract-tool-types (no-truncation nested render)
- [x] Unit: tool-converter (nested/array/Record/union → zod, validates payloads)
- [x] Integration: nested tool input through generated types
- [x] Full build + lint + typecheck + test green

Spec: docs/superpowers/specs/2026-05-28-phase3-nested-tool-inputs-design.md
Plan: docs/superpowers/plans/2026-05-28-phase3-nested-tool-inputs.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Update phase memory**

Edit `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md`: mark sub-project 5 ✅ with the PR link; update the header count to "8 of 9 shipped".

---

## Self-Review

**Spec coverage:**
- Three-layer architecture → Tasks 1 (types+converter dedup), 2-4 (layer 1), 5 (layer 2), 6-8 (layer 3). ✓
- Conversion rules table (object/array/Record/union/enum/optional/fallback) → Tasks 2,3,4 (schema) + 6,7,8 (zod). ✓
- Depth cap 8 → introduced in Task 2 (`MAX_SCHEMA_DEPTH`) and Task 6 (`MAX_ZOD_DEPTH`). ✓
- `JsonSchemaProperty` widening (anyOf, additionalProperties schema, optional type) → Task 1. ✓
- Converter dedup onto core type → Task 1. ✓
- Inline-only (no $ref) → inherent; no task emits $ref. ✓
- Testing (core unit, langchain unit, integration) → Tasks 2-8 (unit), 9 (integration). ✓
- Out-of-scope items (strict toggle, validation keywords, $ref, recursion-beyond-cap, tuples) → none implemented; depth-cap test in Task 2 covers the recursion bound. ✓

**Placeholder scan:** No TBD/TODO. Two tasks (Task 6 Step 1, Task 9 Steps 1/3/4) intentionally instruct discovery of an existing pattern (test-file existence, fixture location, test-package filter) rather than hardcoding a possibly-wrong path — each gives the exact `grep`/`ls` to run and what to do with the result. This is deliberate, not a placeholder.

**Type consistency:** `JsonSchemaProperty` shape used identically in Tasks 1-4 (producer) and 6-8 (consumer). `tsTypeToJsonSchema(type, checker, depth)` signature consistent across Tasks 2-4. `jsonSchemaFieldToZod(prop, depth)` + `objectToZod(prop, depth)` consistent across Tasks 6-8. `additionalProperties: boolean | JsonSchemaProperty` produced in Task 3, consumed in Task 7. `anyOf` produced in Task 4, consumed in Task 8. Depth constant 8 in both layers.
