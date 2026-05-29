# Phase 3 Sub-project 5 — Nested-Object Tool Inputs (Design)

**Status:** Approved for planning
**Date:** 2026-05-28
**Roadmap:** Phase 3 sub-project 5 of 9 (typegen extension). Sequenced before sub-project 6 (tool-output offloading).

## Problem

Dawn extracts a user-authored tool's TypeScript input type into a JSON Schema (for LLM tool-calling) and a TS `inputType` string (for `RouteTools` DX typegen), then converts the JSON Schema to a Zod schema at runtime so the model receives a validated tool signature. Today all three conversions only handle flat shapes — primitives, string-literal-unions (enums), and arrays of primitives. **Anything else silently falls back to `string`.**

Concretely, a tool input like:

```ts
{ filter: { status: "open" | "closed"; tags: string[] }; limit?: number }
```

is coerced to `{ filter: string; limit?: number }` (or worse). The nested object is invisible to the model, the generated type is wrong, and the runtime converter discards it as `z.unknown()`.

## Goal

Support nested structures end-to-end in tool input schemas:

- Nested objects (arbitrary depth)
- Arrays of objects (and objects within arrays, any depth)
- `Record<string, T>` open maps
- Unions of object shapes (`A | B`), including discriminated unions
- Optional fields at every level

All inlined (no `$ref`/`$defs`), depth-capped for safety, applied identically across the three conversion layers.

## Background: the three conversion layers

The nesting gap spans three conversion points. Fixing fewer than all three produces incoherent behavior (e.g. correct generated types but the model still receives an untyped blob).

1. **`packages/core/src/typegen/extract-tool-schema.ts`** — TS type → JSON Schema. The `tsTypeToJsonSchema()` helper handles unions (→ enum / optional-unwrap), arrays (→ `items`, recursive), and `string`/`number`/`boolean`. Everything else hits `return { type: "string" }` (the fallback at the end of the function).

2. **`packages/core/src/typegen/extract-tool-types.ts`** — TS type → TS `inputType` string emitted into generated `RouteTools` types for DX.

3. **`packages/langchain/src/tool-converter.ts`** — JSON Schema → Zod (`jsonSchemaToZod` / `jsonSchemaFieldToZod`). This is the runtime path; the resulting Zod schema is what LangChain binds and what the model actually sees. It is currently **narrower** than layer 1: nested objects and arrays-of-objects both collapse to `z.unknown()` via the `default` branch. **This is the layer that makes nesting real at inference time.**

## Ecosystem alignment (research summary, 2026-05-28)

Two parallel research passes (LLM provider constraints; framework patterns) informed this design.

**Provider support matrix:**

| Feature | OpenAI non-strict | OpenAI strict | Anthropic non-strict | Anthropic strict | Gemini |
|---|---|---|---|---|---|
| Nested objects / arrays of objects | Yes | Yes (≤5 levels) | Yes | Yes | Yes (≤32 levels) |
| `Record<string,T>` (`additionalProperties: schema`) | Yes | **No** (hard error) | Yes | **No** (hard error) | API-only (SDK rejects) |
| Object unions (`anyOf`) | Yes | Partial (not at root) | Yes (not at top level) | Partial (counted vs limits) | Model-dependent |

**Framework patterns:** Every major TS framework (LangChain JS, Vercel AI SDK, Mastra, deepagentsjs) accepts Zod, converts to JSON Schema, and sends that to the provider. Supporting `Record` maps + object unions at the schema layer is **normal**; supporting them end-to-end under OpenAI strict mode is **impossible** (every framework documents this, degrades, or exposes a per-tool `strict` flag).

**Two findings that favor Dawn's approach:**
1. The #1 cross-framework bug is **un-inlined `$ref`/`$defs`** — LangChain JS and Pydantic ship broken nested schemas because their zod/pydantic→JSON-Schema step emits `$ref`s that OpenAI strict rejects (LangChain JS #6479/#7830/#9099, LangChain Py #32170). **Dawn generates inlined JSON Schema directly from TS types — no `$ref`s by construction — sidestepping this entirely.**
2. **Dawn does not enable provider strict mode** (it binds a `DynamicStructuredTool` with a Zod schema in default mode). So `Record` maps + object unions work today in Dawn's default path; the strict-mode limitation is hypothetical/future.

**Conclusion:** full scope (nested + arrays + Record + unions) matches the most mature frameworks and is safe in Dawn's non-strict path. Guardrails: inline everything, depth-cap, and document the future strict-mode incompatibility for Record/unions.

## Conversion rules

Applied identically in all three layers:

| TS type | JSON Schema | Zod (runtime) | TS `inputType` string |
|---|---|---|---|
| `{a: string; b: number}` | `{type:"object", properties, required, additionalProperties:false}` | `z.object({...})` | `{ a: string; b: number }` |
| `T[]` (T any) | `{type:"array", items:<T>}` | `z.array(<T>)` | `T[]` |
| `Record<string,T>` | `{type:"object", additionalProperties:<T>}` | `z.record(z.string(), <T>)` | `Record<string, T>` |
| `A \| B` (object shapes) | `{anyOf:[<A>,<B>]}` | `z.union([<A>,<B>])` | `A \| B` |
| `"x" \| "y"` | `{type:"string", enum:[...]}` | `z.enum([...])` | `"x" \| "y"` |
| optional `a?` | omit from `required` | `.optional()` | `a?:` |
| unmapped type or depth > cap | `{type:"string"}` | `z.string()` | `string` |

Notes:
- **Discriminated unions** need no special handling — they are object unions (`anyOf`); the model and Zod infer the discriminant.
- **Optional detection** is unchanged from today (a union member that is `undefined` marks the field optional and unwraps the rest).
- **Depth cap:** 8 levels. Beyond the cap, fall back to `string` / `z.string()` rather than recurse further. Prevents infinite recursion on self-referential TS types. 8 comfortably exceeds OpenAI strict's 5-level limit and real-world tool inputs.
- **`additionalProperties`:** `false` on every closed object (current behavior, preserved); a sub-schema only for `Record<string,T>`.

## Type vocabulary changes

`JsonSchemaProperty` in `packages/core/src/types.ts` is the canonical schema node. It already has `items`, `properties`, `required`, `enum`. Two changes:

```ts
export interface JsonSchemaProperty {
  readonly type?: string                 // now optional — an anyOf node has no `type`
  readonly description?: string
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchemaProperty  // widened from boolean
  readonly anyOf?: readonly JsonSchemaProperty[]                 // new
  readonly enum?: readonly string[]
}
```

`type` becomes optional because an `anyOf` node carries no `type`. All existing producers set `type`, so this is backward-compatible.

The runtime converter (`tool-converter.ts`) currently duplicates a private, narrower `JsonSchemaObject` + field interface. **Replace that duplication by importing `JsonSchemaProperty` from `@dawn-ai/core`**, so all three layers speak one vocabulary. This is the only refactor and it directly serves the feature.

## Architecture / units

Each conversion is a pure, independently testable recursion over `JsonSchemaProperty` (layers 1 → its output; layer 3 → its input). No shared mutable state, no I/O.

- `extract-tool-schema.ts`: add `object` (recurse `properties` + `required`), `Record` (detect index signature → `additionalProperties: <value schema>`), and object-union (`anyOf`) branches to `tsTypeToJsonSchema`, threading a `depth` parameter.
- `extract-tool-types.ts`: mirror the same recursion to emit the TS string form, threading `depth`.
- `tool-converter.ts`: extend `jsonSchemaFieldToZod` with `object` → `z.object`, `array`-of-object, `additionalProperties` schema → `z.record`, and `anyOf` → `z.union`, threading `depth`.

Each recursion takes a `depth` arg (default 0), increments per level, and returns the `string` fallback when `depth > 8`.

## Error handling

- **Depth overflow** → silent `string` fallback (matches the existing unknown-type contract; no throw).
- **Genuinely unmappable types** (functions, `Date`, `symbol`, intersections, non-object unions that aren't string-literals) → `string` fallback, as today.
- **Empty object `{}`** → `{type:"object", properties:{}, additionalProperties:false}` / `z.object({})`.
- No new error paths or thrown exceptions; the feature only widens what maps cleanly.

## Testing

**Unit — `@dawn-ai/core`** (extend `extract-tool-schema.test.ts`, `extract-tool-types.test.ts`):
- nested object (one + multi level)
- array of objects; object containing an array of objects
- `Record<string, T>` (T primitive and T object)
- object union `A | B`; discriminated union
- optional nested fields (`a?: { b?: string }`)
- depth-cap fallback (construct a >8-level type, assert `string` at the boundary)
- mixed: `{ filter: { tags: string[]; range: { min: number; max: number } }; mode: "fast" | "full" }`

**Unit — `@dawn-ai/langchain`** (extend the tool-converter test):
- JSON Schema with nested object → `z.object`; validates a conforming payload, rejects a non-conforming one
- array-of-object, `additionalProperties` schema → `z.record`, `anyOf` → `z.union`
- depth-cap fallback → `z.string`

**Integration** (reuse the runtime-contract harness; no new lane):
- one chat-example (or fixture) tool authored with a nested input; assert the generated `RouteTools` type contains the nested shape, and a real/stubbed tool call round-trips a nested argument.

## Out of scope

- OpenAI strict-mode emission/toggle — documented limitation only; Dawn stays non-strict. (When a strict toggle is added later, Record/unions must degrade knowingly.)
- Validation keywords (`minimum`, `maximum`, `pattern`, `minLength`, …) — not extracted today; unchanged.
- `$ref`/`$defs` — Dawn inlines by construction; explicitly never emit them.
- Recursive/self-referential types beyond the depth cap.
- Tuple types (`[string, number]`) — fall back to `string` unless a concrete need appears (YAGNI).
