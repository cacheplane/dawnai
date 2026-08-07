import { describe, expect, test } from "vitest"

import { type TypeInfo, typeInfoToToolParameters } from "../src/compiler/index.ts"

describe("typeInfoToToolParameters", () => {
  test("renders supported TypeInfo shapes without compiler values", () => {
    const parameter: TypeInfo = {
      kind: "object",
      properties: [
        {
          name: "query",
          type: { kind: "string" },
          optional: false,
          description: "Terms to find.",
        },
        { name: "limit", type: { kind: "number" }, optional: true },
        { name: "enabled", type: { kind: "boolean" }, optional: false },
        {
          name: "direction",
          type: { kind: "enum", values: ["asc", "desc"] },
          optional: false,
        },
        {
          name: "filter",
          type: {
            kind: "object",
            properties: [
              {
                name: "status",
                type: { kind: "literal", value: "open" },
                optional: false,
              },
              {
                name: "tags",
                type: { kind: "array", element: { kind: "string" } },
                optional: false,
              },
            ],
          },
          optional: false,
        },
        {
          name: "scores",
          type: {
            kind: "record",
            key: { kind: "string" },
            value: { kind: "number" },
          },
          optional: false,
        },
        {
          name: "action",
          type: {
            kind: "union",
            members: [
              {
                kind: "object",
                properties: [
                  {
                    name: "kind",
                    type: { kind: "literal", value: "create" },
                    optional: false,
                  },
                  { name: "name", type: { kind: "string" }, optional: false },
                ],
              },
              {
                kind: "object",
                properties: [
                  {
                    name: "kind",
                    type: { kind: "literal", value: "delete" },
                    optional: false,
                  },
                  { name: "id", type: { kind: "number" }, optional: false },
                ],
              },
            ],
          },
          optional: false,
        },
      ],
    }

    expect(typeInfoToToolParameters(parameter)).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Terms to find." },
        limit: { type: "number" },
        enabled: { type: "boolean" },
        direction: { type: "string", enum: ["asc", "desc"] },
        filter: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open"] },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["status", "tags"],
          additionalProperties: false,
        },
        scores: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: { type: "number" },
        },
        action: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["create"] },
                name: { type: "string" },
              },
              required: ["kind", "name"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["delete"] },
                id: { type: "number" },
              },
              required: ["kind", "id"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["query", "enabled", "direction", "filter", "scores", "action"],
      additionalProperties: false,
    })
  })

  test("renders empty parameters for a tool without a parameter", () => {
    expect(typeInfoToToolParameters(null)).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  test("renders unions of records as object alternatives", () => {
    const parameter: TypeInfo = {
      kind: "object",
      properties: [
        {
          name: "lookup",
          type: {
            kind: "union",
            members: [
              {
                kind: "record",
                key: { kind: "string" },
                value: { kind: "string" },
              },
              {
                kind: "record",
                key: { kind: "string" },
                value: { kind: "number" },
              },
            ],
          },
          optional: false,
        },
      ],
    }

    expect(typeInfoToToolParameters(parameter).properties.lookup).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: { type: "string" },
        },
        {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: { type: "number" },
        },
      ],
    })
  })

  test("falls back to string for unsupported shapes", () => {
    const parameter: TypeInfo = {
      kind: "object",
      properties: [{ name: "unknown", type: { kind: "unknown" }, optional: false }],
    }

    expect(typeInfoToToolParameters(parameter).properties.unknown).toEqual({ type: "string" })
  })

  test("falls back at the first object beyond the schema depth limit", () => {
    let deepType: TypeInfo = { kind: "string" }
    for (let index = 0; index < 10; index += 1) {
      deepType = {
        kind: "object",
        properties: [{ name: `level${index}`, type: deepType, optional: false }],
      }
    }

    const parameter: TypeInfo = {
      kind: "object",
      properties: [{ name: "deep", type: deepType, optional: false }],
    }
    let overDepthNode = typeInfoToToolParameters(parameter).properties.deep

    for (let index = 9; index >= 1; index -= 1) {
      expect(overDepthNode).toMatchObject({ type: "object" })
      overDepthNode = overDepthNode?.properties?.[`level${index}`]
    }

    expect(overDepthNode).toEqual({ type: "string" })
  })
})
