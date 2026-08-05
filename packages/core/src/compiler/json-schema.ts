import type { ExtractedToolSchema, JsonSchemaProperty } from "../types.js"
import type { PropertyInfo, TypeInfo } from "./model.js"

const MAX_SCHEMA_DEPTH = 8

export function typeInfoToToolParameters(
  parameter: TypeInfo | null,
): ExtractedToolSchema["parameters"] {
  const objectParameter = unwrapOptional(parameter)
  if (objectParameter?.kind !== "object") return emptyParameters()

  return objectSchema(objectParameter.properties, -1)
}

function typeInfoToJsonSchema(type: TypeInfo, depth: number): JsonSchemaProperty {
  if (depth > MAX_SCHEMA_DEPTH) return { type: "string" }

  switch (type.kind) {
    case "string":
      return { type: "string" }
    case "number":
      return { type: "number" }
    case "boolean":
      return { type: "boolean" }
    case "literal":
      if (typeof type.value === "string") {
        return { type: "string", enum: [type.value] }
      }
      return { type: typeof type.value }
    case "enum":
      return { type: "string", enum: type.values }
    case "array":
      return {
        type: "array",
        items: typeInfoToJsonSchema(type.element, depth + 1),
      }
    case "object":
      return objectSchema(type.properties, depth)
    case "record":
      return {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: typeInfoToJsonSchema(type.value, depth + 1),
      }
    case "union":
      if (type.members.length > 1 && type.members.every((member) => member.kind === "object")) {
        return {
          anyOf: type.members.map((member) => typeInfoToJsonSchema(member, depth + 1)),
        }
      }
      return { type: "string" }
    case "optional":
      return typeInfoToJsonSchema(type.inner, depth)
    default:
      return { type: "string" }
  }
}

function objectSchema(
  propertyInfo: readonly PropertyInfo[],
  depth: number,
): ExtractedToolSchema["parameters"] {
  const properties: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []

  for (const property of propertyInfo) {
    const schema = typeInfoToJsonSchema(property.type, depth + 1)
    properties[property.name] = property.description
      ? { ...schema, description: property.description }
      : schema
    if (!property.optional) required.push(property.name)
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }
}

function unwrapOptional(type: TypeInfo | null): TypeInfo | null {
  return type?.kind === "optional" ? type.inner : type
}

function emptyParameters(): ExtractedToolSchema["parameters"] {
  return {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }
}
