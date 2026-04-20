import type { TypeInfo } from "./type-info.js"

export function generateZodSchema(
  type: TypeInfo,
  descriptions?: Map<string, string>,
): string {
  switch (type.kind) {
    case "string":
      return "z.string()"
    case "number":
      return "z.number()"
    case "boolean":
      return "z.boolean()"
    case "null":
      return "z.null()"
    case "unknown":
      return "z.unknown()"
    case "literal": {
      const val =
        typeof type.value === "string"
          ? JSON.stringify(type.value)
          : String(type.value)
      return `z.literal(${val})`
    }
    case "array":
      return `z.array(${generateZodSchema(type.element, descriptions)})`
    case "tuple": {
      const elements = type.elements
        .map((el) => generateZodSchema(el, descriptions))
        .join(", ")
      return `z.tuple([${elements}])`
    }
    case "object": {
      const props = type.properties.map((prop) => {
        let schema = generateZodSchema(prop.type, descriptions)
        if (prop.optional) {
          schema = `${schema}.optional()`
        }
        const desc =
          prop.description ?? descriptions?.get(prop.name)
        if (desc !== undefined) {
          schema = `${schema}.describe(${JSON.stringify(desc)})`
        }
        return `${JSON.stringify(prop.name)}: ${schema}`
      })
      return `z.object({ ${props.join(", ")} })`
    }
    case "record":
      return `z.record(${generateZodSchema(type.key, descriptions)}, ${generateZodSchema(type.value, descriptions)})`
    case "map":
      return `z.map(${generateZodSchema(type.key, descriptions)}, ${generateZodSchema(type.value, descriptions)})`
    case "set":
      return `z.set(${generateZodSchema(type.element, descriptions)})`
    case "union": {
      const members = type.members
        .map((m) => generateZodSchema(m, descriptions))
        .join(", ")
      return `z.union([${members}])`
    }
    case "intersection": {
      if (type.members.length === 0) {
        return "z.unknown()"
      }
      if (type.members.length === 1) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return generateZodSchema(type.members[0]!, descriptions)
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      let result = `z.intersection(${generateZodSchema(type.members[0]!, descriptions)}, ${generateZodSchema(type.members[1]!, descriptions)})`
      for (let i = 2; i < type.members.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        result = `z.intersection(${result}, ${generateZodSchema(type.members[i]!, descriptions)})`
      }
      return result
    }
    case "enum": {
      const values = type.values.map((v) => JSON.stringify(v)).join(", ")
      return `z.enum([${values}])`
    }
    case "optional":
      return `${generateZodSchema(type.inner, descriptions)}.optional()`
  }
}
