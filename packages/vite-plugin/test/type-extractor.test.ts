import { describe, expect, it } from "vitest"

import { extractParameterType } from "../src/type-extractor.js"

describe("extractParameterType", () => {
  it("extracts object with string property", () => {
    const source = `export default async (input: { name: string }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "name", type: { kind: "string" }, optional: false }],
    })
  })

  it("extracts object with number property", () => {
    const source = `export default async (input: { count: number }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "count", type: { kind: "number" }, optional: false }],
    })
  })

  it("extracts object with boolean property", () => {
    const source = `export default async (input: { active: boolean }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "active", type: { kind: "boolean" }, optional: false }],
    })
  })

  it("extracts optional property", () => {
    const source = `export default async (input: { name?: string }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "name", type: { kind: "string" }, optional: true }],
    })
  })

  it("extracts array property", () => {
    const source = `export default async (input: { tags: string[] }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "tags",
          type: { kind: "array", element: { kind: "string" } },
          optional: false,
        },
      ],
    })
  })

  it("extracts nested object", () => {
    const source = `export default async (input: { user: { id: string; name: string } }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "user",
          type: {
            kind: "object",
            properties: [
              { name: "id", type: { kind: "string" }, optional: false },
              { name: "name", type: { kind: "string" }, optional: false },
            ],
          },
          optional: false,
        },
      ],
    })
  })

  it("extracts string literal union as enum", () => {
    const source = `export default async (input: { status: "active" | "inactive" }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "status",
          type: { kind: "enum", values: ["active", "inactive"] },
          optional: false,
        },
      ],
    })
  })

  it("extracts Record type", () => {
    const source = `export default async (input: Record<string, number>) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "record",
      key: { kind: "string" },
      value: { kind: "number" },
    })
  })

  it("extracts Map property", () => {
    const source = `export default async (input: { data: Map<string, number> }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "data",
          type: { kind: "map", key: { kind: "string" }, value: { kind: "number" } },
          optional: false,
        },
      ],
    })
  })

  it("extracts Set property", () => {
    const source = `export default async (input: { ids: Set<string> }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "ids",
          type: { kind: "set", element: { kind: "string" } },
          optional: false,
        },
      ],
    })
  })

  it("extracts tuple property", () => {
    const source = `export default async (input: { pair: [string, number] }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "pair",
          type: {
            kind: "tuple",
            elements: [{ kind: "string" }, { kind: "number" }],
          },
          optional: false,
        },
      ],
    })
  })

  it("extracts literal types", () => {
    const source = `export default async (input: { count: 42; flag: true }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        { name: "count", type: { kind: "literal", value: 42 }, optional: false },
        { name: "flag", type: { kind: "literal", value: true }, optional: false },
      ],
    })
  })

  it("extracts nullable type as union with null", () => {
    const source = `export default async (input: { name: string | null }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        {
          name: "name",
          type: {
            kind: "union",
            members: [{ kind: "null" }, { kind: "string" }],
          },
          optional: false,
        },
      ],
    })
  })

  it("resolves type aliases", () => {
    const source = `
type Input = { id: string }
export default async (input: Input) => input
`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [{ name: "id", type: { kind: "string" }, optional: false }],
    })
  })

  it("resolves generic types", () => {
    const source = `
type WithId<T> = { id: string } & T
export default async (input: WithId<{ name: string }>) => input
`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({
      kind: "object",
      properties: [
        { name: "id", type: { kind: "string" }, optional: false },
        { name: "name", type: { kind: "string" }, optional: false },
      ],
    })
  })

  it("returns unknown for untyped parameter", () => {
    const source = `export default async (input) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toEqual({ kind: "unknown" })
  })

  it("returns null when no default export", () => {
    const source = `export const foo = (input: { name: string }) => input`
    const result = extractParameterType(source, "test.ts")
    expect(result).toBeNull()
  })
})
