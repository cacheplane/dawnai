import type { TypeInfo } from "@dawn-ai/core/internal/compiler"

export function generateZodSchema(
  type: TypeInfo,
  descriptions?: ReadonlyMap<string, string>,
  zodIdentifier = "z",
): string {
  switch (type.kind) {
    case "string":
      return `${zodIdentifier}.string()`
    case "number":
      return `${zodIdentifier}.number()`
    case "boolean":
      return `${zodIdentifier}.boolean()`
    case "null":
      return `${zodIdentifier}.null()`
    case "unknown":
      return `${zodIdentifier}.unknown()`
    case "literal": {
      const val = typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value)
      return `${zodIdentifier}.literal(${val})`
    }
    case "array":
      return `${zodIdentifier}.array(${generateZodSchema(type.element, descriptions, zodIdentifier)})`
    case "tuple": {
      const elements = type.elements
        .map((el) => generateZodSchema(el, descriptions, zodIdentifier))
        .join(", ")
      return `${zodIdentifier}.tuple([${elements}])`
    }
    case "object": {
      const props = type.properties.map((prop) => {
        let schema = generateZodSchema(prop.type, descriptions, zodIdentifier)
        if (prop.optional) {
          schema = `${schema}.optional()`
        }
        const desc = prop.description ?? descriptions?.get(prop.name)
        if (desc !== undefined) {
          schema = `${schema}.describe(${JSON.stringify(desc)})`
        }
        return `${JSON.stringify(prop.name)}: ${schema}`
      })
      return `${zodIdentifier}.object({ ${props.join(", ")} })`
    }
    case "record":
      return `${zodIdentifier}.record(${generateZodSchema(type.key, descriptions, zodIdentifier)}, ${generateZodSchema(type.value, descriptions, zodIdentifier)})`
    case "map":
      return `${zodIdentifier}.map(${generateZodSchema(type.key, descriptions, zodIdentifier)}, ${generateZodSchema(type.value, descriptions, zodIdentifier)})`
    case "set":
      return `${zodIdentifier}.set(${generateZodSchema(type.element, descriptions, zodIdentifier)})`
    case "union": {
      const members = type.members
        .map((member) => generateZodSchema(member, descriptions, zodIdentifier))
        .join(", ")
      return `${zodIdentifier}.union([${members}])`
    }
    case "intersection": {
      if (type.members.length === 0) {
        return `${zodIdentifier}.unknown()`
      }
      const first = type.members[0]
      if (!first) {
        return `${zodIdentifier}.unknown()`
      }
      if (type.members.length === 1) {
        return generateZodSchema(first, descriptions, zodIdentifier)
      }
      const second = type.members[1]
      if (!second) {
        return generateZodSchema(first, descriptions, zodIdentifier)
      }
      let result = `${zodIdentifier}.intersection(${generateZodSchema(first, descriptions, zodIdentifier)}, ${generateZodSchema(second, descriptions, zodIdentifier)})`
      for (let i = 2; i < type.members.length; i++) {
        const member = type.members[i]
        if (member) {
          result = `${zodIdentifier}.intersection(${result}, ${generateZodSchema(member, descriptions, zodIdentifier)})`
        }
      }
      return result
    }
    case "enum": {
      const values = type.values.map((v) => JSON.stringify(v)).join(", ")
      return `${zodIdentifier}.enum([${values}])`
    }
    case "optional":
      return `${generateZodSchema(type.inner, descriptions, zodIdentifier)}.optional()`
  }
}
