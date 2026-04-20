import { extractJsDoc } from "./jsdoc-extractor.js"
import { extractParameterType } from "./type-extractor.js"
import { generateZodSchema } from "./zod-generator.js"

// Keep all existing re-exports
export { extractJsDoc, type JsDocInfo } from "./jsdoc-extractor.js"
export { extractParameterType } from "./type-extractor.js"
export { generateZodSchema } from "./zod-generator.js"

const TOOLS_DIR_PATTERN = /\/tools\/[^/]+\.ts$/

export function dawnToolSchemaPlugin(): {
  name: string
  transform(code: string, id: string): { code: string } | null
} {
  return {
    name: "dawn-tool-schema",
    transform(code: string, id: string): { code: string } | null {
      if (!TOOLS_DIR_PATTERN.test(id)) {
        return null
      }

      const transformed = transformToolSource(code, id)

      if (!transformed) {
        return null
      }

      return { code: transformed }
    },
  }
}

export function transformToolSource(source: string, fileName: string): string | null {
  const hasExistingDescription = /export\s+const\s+description\s*=/.test(source)
  const hasExistingSchema = /export\s+const\s+schema\s*=/.test(source)

  // If both already exist, nothing to inject
  if (hasExistingDescription && hasExistingSchema) {
    return null
  }

  const jsDoc = extractJsDoc(source, fileName)
  const typeInfo = extractParameterType(source, fileName)

  const needsDescription = !hasExistingDescription && jsDoc.description !== undefined
  const needsSchema = !hasExistingSchema && typeInfo !== null && typeInfo.kind !== "unknown"

  if (!needsDescription && !needsSchema) {
    return null
  }

  const injections: string[] = []

  if (needsDescription) {
    injections.push(`export const description = ${JSON.stringify(jsDoc.description)}`)
  }

  if (needsSchema && typeInfo) {
    // Merge JSDoc @param descriptions into TypeInfo properties
    const paramDescriptions = new Map(Object.entries(jsDoc.params))
    if (typeInfo.kind === "object") {
      for (const prop of typeInfo.properties) {
        const desc = paramDescriptions.get(prop.name)
        if (desc && !prop.description) {
          // PropertyInfo is readonly, so we need to work around it
          ;(prop as { description?: string }).description = desc
        }
      }
    }
    const zodCode = generateZodSchema(typeInfo, paramDescriptions)
    injections.push(`import { z } from "zod"`)
    injections.push(`export const schema = ${zodCode}`)
  }

  return `${injections.join("\n")}\n${source}`
}
