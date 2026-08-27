import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { analyzeToolSource } from "../src/compiler/index.ts"

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function analyze(source: string, fileName = "lookup.ts") {
  const result = analyzeToolSource(source, fileName)
  expect(result).not.toBeNull()
  if (!result) throw new Error("Expected an analyzed tool")
  return result
}

function analyzeRootIntersection(source: string) {
  const parameter = analyze(`export default async (input: ${source}) => input`).parameter
  expect(parameter?.kind).toBe("intersection")
  if (parameter?.kind !== "intersection") {
    throw new Error("Expected an intersection parameter")
  }
  return parameter
}

// These suites drive the TypeScript compiler through
// `src/compiler/typescript-backend.ts`, so their runtime tracks machine load
// rather than the work in the test. Idle they finish well inside a second; under
// a saturated parallel run they have exceeded vitest's 5000ms default and failed
// as timeouts rather than as anything real. The explicit suite timeout leaves
// room for that without hiding a genuine hang.
describe("analyzeToolSource", { timeout: 30_000 }, () => {
  test("analyzes a typed default-exported tool from one callable signature", () => {
    const source = `
/**
 * Look up a customer.
 * @param id - Customer identifier
 */
export default async function lookup(
  input: { id: string },
): Promise<{ found: boolean }> {
  return { found: input.id.length > 0 }
}
`

    expect(analyze(source)).toEqual({
      name: "lookup",
      description: "Look up a customer.",
      exports: { description: false, schema: false },
      inputType: "{ id: string; }",
      outputType: "{ found: boolean; }",
      parameter: {
        kind: "object",
        properties: [{ name: "id", type: { kind: "string" }, optional: false }],
      },
      parameterDescriptions: new Map([["id", "Customer identifier"]]),
    })
  })

  test("reports description and schema presence from module exports", () => {
    const result = analyze(`
export const description: string = "Explicit description"
export const schema: { parse(value: unknown): unknown } = {
  parse: (value) => value,
}
export default async (input: { id: string }) => input
`)

    expect(result.exports).toEqual({ description: true, schema: true })
  })

  test("does not report type-only description and schema exports as runtime values", () => {
    const result = analyze(`
export interface schema { parse(value: unknown): unknown }
class description {}
export type { description }
export default async (input: { id: string }) => input
`)

    expect(result.exports).toEqual({ description: false, schema: false })
  })

  test("does not report erased values through type-only alias chains or ambient declarations", () => {
    const directory = mkdtempSync(join(tmpdir(), "dawn-compiler-exports-"))
    tempDirectories.push(directory)
    const sourceFile = join(directory, "tool.ts")
    const source = `
import type { Schema as schema } from "./schema.js"
export { schema }
export declare const description: string
export default async (input: { id: string }) => input
`
    writeFileSync(join(directory, "schema.ts"), "export class Schema {}")
    writeFileSync(sourceFile, source)

    expect(analyze(source, sourceFile).exports).toEqual({ description: false, schema: false })
  })

  test("represents literal parameter types", () => {
    const result = analyze(`
export default async function literals(input: { mode: "fast"; count: 2; enabled: true }) {
  return input
}
`)

    expect(result.parameter).toEqual({
      kind: "object",
      properties: [
        { name: "mode", type: { kind: "literal", value: "fast" }, optional: false },
        { name: "count", type: { kind: "literal", value: 2 }, optional: false },
        { name: "enabled", type: { kind: "literal", value: true }, optional: false },
      ],
    })
  })

  test("represents array parameter types", () => {
    expect(analyze("export default async (input: string[]) => input").parameter).toEqual({
      kind: "array",
      element: { kind: "string" },
    })
  })

  test("represents tuple parameter types", () => {
    expect(analyze("export default async (input: [string, number]) => input").parameter).toEqual({
      kind: "tuple",
      elements: [{ kind: "string" }, { kind: "number" }],
    })
  })

  test("represents record parameter types", () => {
    expect(
      analyze("export default async (input: Record<string, number>) => input").parameter,
    ).toEqual({
      kind: "record",
      key: { kind: "string" },
      value: { kind: "number" },
    })
  })

  test("represents map parameter types", () => {
    expect(analyze("export default async (input: Map<string, number>) => input").parameter).toEqual(
      {
        kind: "map",
        key: { kind: "string" },
        value: { kind: "number" },
      },
    )
  })

  test("represents set parameter types", () => {
    expect(analyze("export default async (input: Set<boolean>) => input").parameter).toEqual({
      kind: "set",
      element: { kind: "boolean" },
    })
  })

  test("preserves standard Promise, Map, and Set identities with the TypeScript 6 bridge", () => {
    const result = analyze(`
export default async function collect(input: {
  values: Map<string, number>
  flags: Set<boolean>
}): Promise<{ count: number }> {
  return { count: input.values.size + input.flags.size }
}
`)

    expect(result.outputType).toBe("{ count: number; }")
    expect(result.parameter).toEqual({
      kind: "object",
      properties: [
        {
          name: "values",
          optional: false,
          type: {
            kind: "map",
            key: { kind: "string" },
            value: { kind: "number" },
          },
        },
        {
          name: "flags",
          optional: false,
          type: { kind: "set", element: { kind: "boolean" } },
        },
      ],
    })
  })

  test.each([
    {
      typeName: "Array",
      source: `
interface Array<T> { arrayValue: T }
export default async (input: Array<string>) => input
`,
      property: { name: "arrayValue", type: { kind: "string" }, optional: false },
    },
    {
      typeName: "Map",
      source: `
interface Map<K, V> { mapKey: K; mapValue: V }
export default async (input: Map<string, number>) => input
`,
      property: {
        name: "mapKey",
        type: { kind: "string" },
        optional: false,
      },
      secondProperty: {
        name: "mapValue",
        type: { kind: "number" },
        optional: false,
      },
    },
    {
      typeName: "Set",
      source: `
interface Set<T> { setValue: T }
export default async (input: Set<boolean>) => input
`,
      property: { name: "setValue", type: { kind: "boolean" }, optional: false },
    },
  ])("keeps a user-defined $typeName as an object", ({ source, property, secondProperty }) => {
    expect(analyze(source).parameter).toEqual({
      kind: "object",
      properties: secondProperty ? [property, secondProperty] : [property],
    })
  })

  test("represents union parameter types", () => {
    expect(analyze("export default async (input: string | number) => input").parameter).toEqual({
      kind: "union",
      members: [{ kind: "string" }, { kind: "number" }],
    })
  })

  test("represents intersections that cannot be merged as objects", () => {
    expect(
      analyze("export default async (input: string & { branded: true }) => input").parameter,
    ).toEqual({
      kind: "intersection",
      members: [
        { kind: "string" },
        {
          kind: "object",
          properties: [
            { name: "branded", type: { kind: "literal", value: true }, optional: false },
          ],
        },
      ],
    })
  })

  test("preserves nested all-object intersections in the neutral model", () => {
    expect(
      analyze("export default async (input: { value: { a: string } & { b: number } }) => input")
        .parameter,
    ).toEqual({
      kind: "object",
      properties: [
        {
          name: "value",
          optional: false,
          type: {
            kind: "intersection",
            members: [
              {
                kind: "object",
                properties: [{ name: "a", type: { kind: "string" }, optional: false }],
              },
              {
                kind: "object",
                properties: [{ name: "b", type: { kind: "number" }, optional: false }],
              },
            ],
          },
        },
      ],
    })
  })

  test.each([
    {
      name: "record",
      effectiveProperties: true,
      source: "Record<string, number> & { fixed: string }",
      specialized: {
        kind: "record",
        key: { kind: "string" },
        value: { kind: "number" },
      },
    },
    {
      name: "map",
      effectiveProperties: false,
      source: "Map<string, number> & { fixed: string }",
      specialized: {
        kind: "map",
        key: { kind: "string" },
        value: { kind: "number" },
      },
    },
    {
      name: "array",
      effectiveProperties: false,
      source: "string[] & { fixed: string }",
      specialized: { kind: "array", element: { kind: "string" } },
    },
    {
      name: "set",
      effectiveProperties: false,
      source: "Set<boolean> & { fixed: string }",
      specialized: { kind: "set", element: { kind: "boolean" } },
    },
    {
      name: "tuple",
      effectiveProperties: false,
      source: "[string, number] & { fixed: string }",
      specialized: {
        kind: "tuple",
        elements: [{ kind: "string" }, { kind: "number" }],
      },
    },
  ])(
    "preserves specialized $name members on root intersections",
    ({ source, specialized, effectiveProperties }) => {
      const parameter = analyzeRootIntersection(source)

      expect(parameter.members).toEqual([
        specialized,
        {
          kind: "object",
          properties: [{ name: "fixed", type: { kind: "string" }, optional: false }],
        },
      ])
      expect(
        parameter.effectiveProperties?.some((property) => property.name === "fixed") ?? false,
      ).toBe(effectiveProperties)
    },
  )

  test("allows semantic consumers to project members without effective root metadata", () => {
    const parameter = analyzeRootIntersection("Map<string, number> & { fixed: string }")

    const semanticKinds = parameter.members.map((member) => member.kind)

    expect(semanticKinds).toEqual(["map", "object"])
  })

  test.each([
    ["root", "Partial<{ a: string }>", ["a"]],
    ["nested", "{ nested: Partial<{ a: string }> }", ["nested", "a"]],
    ["readonly root", "Readonly<Partial<{ a: string }>>", ["a"]],
    ["readonly nested", "{ nested: Readonly<Partial<{ a: string }>> }", ["nested", "a"]],
  ])("keeps %s Partial properties semantically optional", (_name, source, path) => {
    const parameter = analyze(`export default async (input: ${source}) => input`).parameter
    let property = parameter?.kind === "object" ? parameter.properties[0] : undefined
    for (const propertyName of path.slice(1)) {
      expect(property?.name).toBe(path[0])
      property = property?.type.kind === "object" ? property.type.properties[0] : undefined
      expect(property?.name).toBe(propertyName)
    }

    expect(property?.optional).toBe(true)
    expect(property).not.toHaveProperty("schemaProjection")
  })

  test("keeps mapped optional properties semantically optional", () => {
    const parameter = analyze(`
type MappedOptional<T> = { [K in keyof T]?: T[K] }
export default async (input: MappedOptional<{ a: string }>) => input
`).parameter
    const property = parameter?.kind === "object" ? parameter.properties[0] : undefined

    expect(property).toMatchObject({
      name: "a",
      optional: true,
    })
    expect(property).not.toHaveProperty("schemaProjection")
  })

  test("keeps the compiler model and backend free of JSON Schema projection details", () => {
    const property = analyze(
      "export default async (input: Partial<{ a: string }>) => input",
    ).parameter
    expect(property?.kind === "object" ? property.properties[0] : undefined).not.toHaveProperty(
      "schemaProjection",
    )

    const backendSource = readFileSync(
      new URL("../src/compiler/typescript-backend.ts", import.meta.url),
      "utf8",
    )
    expect(backendSource).not.toMatch(
      /JsonSchemaProperty|compilerTypeToJsonSchema|MAX_SCHEMA_DEPTH/,
    )

    const modelSource = readFileSync(new URL("../src/compiler/model.ts", import.meta.url), "utf8")
    expect(modelSource).not.toContain("schemaProjection")
  })

  test("represents string literal unions as enums", () => {
    expect(
      analyze('export default async (input: "pending" | "complete") => input').parameter,
    ).toEqual({
      kind: "enum",
      values: ["pending", "complete"],
    })
  })

  test("represents null within unions", () => {
    expect(analyze("export default async (input: string | null) => input").parameter).toEqual({
      kind: "union",
      members: [{ kind: "null" }, { kind: "string" }],
    })
  })

  test("represents undefined unions as optional values", () => {
    expect(analyze("export default async (input: string | undefined) => input").parameter).toEqual({
      kind: "optional",
      inner: { kind: "string" },
    })
  })

  test("represents optional parameters as optional values", () => {
    expect(analyze("export default async (input?: { id: string }) => input").parameter).toEqual({
      kind: "optional",
      inner: {
        kind: "object",
        properties: [{ name: "id", type: { kind: "string" }, optional: false }],
      },
    })
  })

  test("preserves unions between object types on optional properties", () => {
    const result = analyze(`
export default async (input: { choice?: { a: string } | { b: number } }) => input
`)

    expect(result.parameter).toEqual({
      kind: "object",
      properties: [
        {
          name: "choice",
          optional: true,
          type: {
            kind: "union",
            members: [
              {
                kind: "object",
                properties: [{ name: "a", type: { kind: "string" }, optional: false }],
              },
              {
                kind: "object",
                properties: [{ name: "b", type: { kind: "number" }, optional: false }],
              },
            ],
          },
        },
      ],
    })
  })

  test("resolves type aliases in the neutral parameter model", () => {
    const result = analyze(`
type Input = { id: string }
export default async (input: Input) => input
`)

    expect(result.parameter).toEqual({
      kind: "object",
      properties: [{ name: "id", type: { kind: "string" }, optional: false }],
    })
  })

  test("resolves effective root properties from instantiated generic intersections", () => {
    const result = analyze(`
type WithId<T> = { id: string } & T
export default async (input: WithId<{ name: string }>) => input
`)

    expect(result.parameter).toEqual({
      kind: "intersection",
      members: [
        {
          kind: "object",
          properties: [{ name: "id", type: { kind: "string" }, optional: false }],
        },
        {
          kind: "object",
          properties: [{ name: "name", type: { kind: "string" }, optional: false }],
        },
      ],
      effectiveProperties: [
        { name: "id", type: { kind: "string" }, optional: false },
        { name: "name", type: { kind: "string" }, optional: false },
      ],
    })
  })

  test("resolves imported input and output types from the source filename", () => {
    const directory = mkdtempSync(join(tmpdir(), "dawn-compiler-analysis-"))
    tempDirectories.push(directory)
    const sourceFile = join(directory, "imported-tool.ts")
    const source = `
import type { ImportedInput, ImportedOutput } from "./types.js"
export default async function importedTool(input: ImportedInput): Promise<ImportedOutput> {
  return { accepted: input.query.length > 0 }
}
`
    writeFileSync(
      join(directory, "types.ts"),
      `
export interface ImportedInput { query: string }
export interface ImportedOutput { accepted: boolean }
`,
    )
    writeFileSync(sourceFile, source)

    const result = analyze(source, sourceFile)

    expect(result.inputType).toBe("ImportedInput")
    expect(result.outputType).toBe("ImportedOutput")
    expect(result.parameter).toEqual({
      kind: "object",
      properties: [{ name: "query", type: { kind: "string" }, optional: false }],
    })
  })

  test("does not unwrap a user-defined Promise return type", () => {
    const result = analyze(`
interface Promise<T> { wrapped: T }
export default function customPromise(input: string): Promise<number> {
  return { wrapped: input.length }
}
`)

    expect(result.outputType).toBe("Promise<number>")
  })

  test("represents unknown input types", () => {
    const result = analyze(
      "export default async function flexible(input: unknown): Promise<boolean> { return true }",
    )

    expect(result.inputType).toBe("unknown")
    expect(result.parameter).toEqual({ kind: "unknown" })
  })

  test("uses void and no neutral parameter for tools without parameters", () => {
    const result = analyze("export default async function ping(): Promise<boolean> { return true }")

    expect(result.inputType).toBe("void")
    expect(result.parameter).toBeNull()
  })

  test("returns null when the source has no default export", () => {
    expect(
      analyzeToolSource("export const lookup = (input: string) => input", "lookup.ts"),
    ).toBeNull()
  })

  test("returns null when the default export is not callable", () => {
    expect(analyzeToolSource("export default { enabled: true }", "config.ts")).toBeNull()
  })

  test("extracts inline property documentation", () => {
    const result = analyze(`
export default async function search(input: {
  /** Terms to find. */
  query: string
  /** Maximum number of results. */
  limit?: number
}) {
  return input
}
`)

    expect(result.parameter).toEqual({
      kind: "object",
      properties: [
        {
          name: "query",
          type: { kind: "string" },
          optional: false,
          description: "Terms to find.",
        },
        {
          name: "limit",
          type: { kind: "number" },
          optional: true,
          description: "Maximum number of results.",
        },
      ],
    })
  })

  test("cuts off self-referential types without throwing", () => {
    const result = analyze(`
interface Branch {
  label: string
  child?: Branch
}
export default async (input: Branch) => input
`)

    expect(result.parameter).toEqual({
      kind: "object",
      properties: [
        { name: "label", type: { kind: "string" }, optional: false },
        { name: "child", type: { kind: "unknown" }, optional: true },
      ],
    })
  })

  test("cuts off deeply nested acyclic types without throwing", () => {
    const nestingDepth = 40
    let inputType = "string"
    for (let index = nestingDepth - 1; index >= 0; index -= 1) {
      inputType = `{ level${index}: ${inputType} }`
    }

    const result = analyze(`export default async (input: ${inputType}) => input`)
    let current = result.parameter
    let resolvedDepth = 0

    while (current?.kind === "object") {
      current = current.properties[0]?.type ?? null
      resolvedDepth += 1
    }

    expect(resolvedDepth).toBeGreaterThan(0)
    expect(resolvedDepth).toBeLessThan(nestingDepth)
    expect(current).toEqual({ kind: "unknown" })
  })

  test("extracts multiline JSDoc attached to a default export expression", () => {
    const result = analyze(`
/**
 * Search across all indexed
 * customer records.
 * @param query Search terms
 */
export default async (
  input: { query: string },
): Promise<{ matches: string[] }> => ({ matches: [input.query] })
`)

    expect(result.description).toBe("Search across all indexed\ncustomer records.")
    expect(result.parameterDescriptions).toEqual(new Map([["query", "Search terms"]]))
  })

  test("keeps multiline param continuation out of the description while retaining fallback", () => {
    const result = analyze(`
/**
 * Search across indexed customer records.
 * @param query Search terms
 *   including known aliases.
 */
export default async (
  input: { query: string },
): Promise<{ matches: string[] }> => ({ matches: [input.query] })
`)

    expect(result.description).toBe("Search across indexed customer records.")
    expect(result.parameterDescriptions).toEqual(new Map([["query", "Search terms"]]))
  })

  test("parses a one-line JSDoc param as a tag", () => {
    const result = analyze(`
/** @param id Identifier */
export default async (input: { id: string }) => input
`)

    expect(result.description).toBe("")
    expect(result.parameterDescriptions).toEqual(new Map([["id", "Identifier"]]))
  })

  test.each([
    [
      "const",
      `
/** Look up a customer from a const. */
const tool = async (input: { id: string }) => input
export { tool as default }
`,
      "Look up a customer from a const.",
    ],
    [
      "function",
      `
/** Look up a customer from a function. */
async function tool(input: { id: string }) { return input }
export { tool as default }
`,
      "Look up a customer from a function.",
    ],
  ])("resolves documentation from an aliased %s target", (_kind, source, description) => {
    expect(analyze(source).description).toBe(description)
  })

  test("falls back to leading JSDoc on a default export declaration", () => {
    const result = analyze(`
const tool = async (input: { id: string }) => input
/**
 * Look up a customer from an export alias.
 * @param id - Exported customer identifier
 *   including inactive records.
 */
export { tool as default }
`)

    expect(result.description).toBe("Look up a customer from an export alias.")
    expect(result.parameterDescriptions).toEqual(new Map([["id", "Exported customer identifier"]]))
  })
})
