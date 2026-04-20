import { describe, expect, it } from "vitest"
import type { TypeInfo } from "../src/type-info.js"
import { generateZodSchema } from "../src/zod-generator.js"

describe("generateZodSchema", () => {
  it("generates z.string() for string", () => {
    const type: TypeInfo = { kind: "string" }
    expect(generateZodSchema(type)).toBe("z.string()")
  })

  it("generates z.number() for number", () => {
    const type: TypeInfo = { kind: "number" }
    expect(generateZodSchema(type)).toBe("z.number()")
  })

  it("generates z.boolean() for boolean", () => {
    const type: TypeInfo = { kind: "boolean" }
    expect(generateZodSchema(type)).toBe("z.boolean()")
  })

  it("generates z.null() for null", () => {
    const type: TypeInfo = { kind: "null" }
    expect(generateZodSchema(type)).toBe("z.null()")
  })

  it("generates z.unknown() for unknown", () => {
    const type: TypeInfo = { kind: "unknown" }
    expect(generateZodSchema(type)).toBe("z.unknown()")
  })

  it("generates z.literal() for string literal", () => {
    const type: TypeInfo = { kind: "literal", value: "hello" }
    expect(generateZodSchema(type)).toBe('z.literal("hello")')
  })

  it("generates z.literal() for number literal", () => {
    const type: TypeInfo = { kind: "literal", value: 42 }
    expect(generateZodSchema(type)).toBe("z.literal(42)")
  })

  it("generates z.literal() for boolean literal", () => {
    const type: TypeInfo = { kind: "literal", value: true }
    expect(generateZodSchema(type)).toBe("z.literal(true)")
  })

  it("generates z.array() for array", () => {
    const type: TypeInfo = { kind: "array", element: { kind: "string" } }
    expect(generateZodSchema(type)).toBe("z.array(z.string())")
  })

  it("generates z.tuple() for tuple", () => {
    const type: TypeInfo = {
      kind: "tuple",
      elements: [{ kind: "string" }, { kind: "number" }],
    }
    expect(generateZodSchema(type)).toBe("z.tuple([z.string(), z.number()])")
  })

  it("generates z.object() for object with required properties", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [
        { name: "id", type: { kind: "string" }, optional: false },
        { name: "count", type: { kind: "number" }, optional: false },
      ],
    }
    expect(generateZodSchema(type)).toBe('z.object({ "id": z.string(), "count": z.number() })')
  })

  it("generates .optional() for optional properties", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [{ name: "name", type: { kind: "string" }, optional: true }],
    }
    expect(generateZodSchema(type)).toBe('z.object({ "name": z.string().optional() })')
  })

  it("generates .describe() from PropertyInfo.description", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [
        {
          name: "email",
          type: { kind: "string" },
          optional: false,
          description: "The user email",
        },
      ],
    }
    expect(generateZodSchema(type)).toBe(
      'z.object({ "email": z.string().describe("The user email") })',
    )
  })

  it("generates .describe() from descriptions Map parameter", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [{ name: "age", type: { kind: "number" }, optional: false }],
    }
    const descriptions = new Map([["age", "The user age"]])
    expect(generateZodSchema(type, descriptions)).toBe(
      'z.object({ "age": z.number().describe("The user age") })',
    )
  })

  it("prefers PropertyInfo.description over descriptions Map", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [
        {
          name: "role",
          type: { kind: "string" },
          optional: false,
          description: "from property",
        },
      ],
    }
    const descriptions = new Map([["role", "from map"]])
    expect(generateZodSchema(type, descriptions)).toBe(
      'z.object({ "role": z.string().describe("from property") })',
    )
  })

  it("generates .optional().describe() for optional property with description", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [
        {
          name: "nickname",
          type: { kind: "string" },
          optional: true,
          description: "Optional nickname",
        },
      ],
    }
    expect(generateZodSchema(type)).toBe(
      'z.object({ "nickname": z.string().optional().describe("Optional nickname") })',
    )
  })

  it("generates z.record() for record", () => {
    const type: TypeInfo = {
      kind: "record",
      key: { kind: "string" },
      value: { kind: "number" },
    }
    expect(generateZodSchema(type)).toBe("z.record(z.string(), z.number())")
  })

  it("generates z.map() for map", () => {
    const type: TypeInfo = {
      kind: "map",
      key: { kind: "string" },
      value: { kind: "boolean" },
    }
    expect(generateZodSchema(type)).toBe("z.map(z.string(), z.boolean())")
  })

  it("generates z.set() for set", () => {
    const type: TypeInfo = { kind: "set", element: { kind: "string" } }
    expect(generateZodSchema(type)).toBe("z.set(z.string())")
  })

  it("generates z.union() for union", () => {
    const type: TypeInfo = {
      kind: "union",
      members: [{ kind: "string" }, { kind: "null" }],
    }
    expect(generateZodSchema(type)).toBe("z.union([z.string(), z.null()])")
  })

  it("generates z.intersection() for two-member intersection", () => {
    const type: TypeInfo = {
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
    }
    expect(generateZodSchema(type)).toBe(
      'z.intersection(z.object({ "id": z.string() }), z.object({ "name": z.string() }))',
    )
  })

  it("chains z.intersection() for >2 members", () => {
    const type: TypeInfo = {
      kind: "intersection",
      members: [
        { kind: "object", properties: [{ name: "a", type: { kind: "string" }, optional: false }] },
        { kind: "object", properties: [{ name: "b", type: { kind: "number" }, optional: false }] },
        { kind: "object", properties: [{ name: "c", type: { kind: "boolean" }, optional: false }] },
      ],
    }
    expect(generateZodSchema(type)).toBe(
      'z.intersection(z.intersection(z.object({ "a": z.string() }), z.object({ "b": z.number() })), z.object({ "c": z.boolean() }))',
    )
  })

  it("generates z.enum() for enum", () => {
    const type: TypeInfo = {
      kind: "enum",
      values: ["active", "inactive", "pending"],
    }
    expect(generateZodSchema(type)).toBe('z.enum(["active", "inactive", "pending"])')
  })

  it("generates .optional() for optional wrapper", () => {
    const type: TypeInfo = { kind: "optional", inner: { kind: "string" } }
    expect(generateZodSchema(type)).toBe("z.string().optional()")
  })

  it("handles nested objects", () => {
    const type: TypeInfo = {
      kind: "object",
      properties: [
        {
          name: "user",
          type: {
            kind: "object",
            properties: [
              { name: "id", type: { kind: "string" }, optional: false },
              { name: "age", type: { kind: "number" }, optional: true },
            ],
          },
          optional: false,
        },
      ],
    }
    expect(generateZodSchema(type)).toBe(
      'z.object({ "user": z.object({ "id": z.string(), "age": z.number().optional() }) })',
    )
  })

  it("handles array of objects", () => {
    const type: TypeInfo = {
      kind: "array",
      element: {
        kind: "object",
        properties: [{ name: "id", type: { kind: "string" }, optional: false }],
      },
    }
    expect(generateZodSchema(type)).toBe('z.array(z.object({ "id": z.string() }))')
  })
})
