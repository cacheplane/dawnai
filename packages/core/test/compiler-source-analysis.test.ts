import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

describe("analyzeToolSource", () => {
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
      inputType: "{ id: string; }",
      outputType: "{ found: boolean; }",
      parameter: {
        kind: "object",
        properties: [{ name: "id", type: { kind: "string" }, optional: false }],
      },
      parameterDescriptions: new Map([["id", "Customer identifier"]]),
    })
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

  test("resolves instantiated generic types in the neutral parameter model", () => {
    const result = analyze(`
type WithId<T> = { id: string } & T
export default async (input: WithId<{ name: string }>) => input
`)

    expect(result.parameter).toEqual({
      kind: "object",
      properties: [
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

    expect(result.description).toBe("Search across all indexed customer records.")
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
})
