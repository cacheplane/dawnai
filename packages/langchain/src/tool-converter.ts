import { DynamicStructuredTool } from "@langchain/core/tools"
import { z } from "zod"

interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
    },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
}

export function convertToolToLangChain(
  tool: DawnToolDefinition,
  middlewareContext?: Readonly<Record<string, unknown>>,
): DynamicStructuredTool {
  const schema = toZodSchema(tool.schema)

  // Cast through unknown to bridge the dual-Zod version type incompatibility
  // (package uses zod@3.24.4; @langchain/core uses zod@3.25.x — structurally identical at runtime)
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema: schema as unknown as z.ZodObject<z.ZodRawShape>,
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const result = await tool.run(input, {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
      })
      return JSON.stringify(result)
    },
  }) as unknown as DynamicStructuredTool
}

function toZodSchema(value: unknown): z.ZodObject<z.ZodRawShape> {
  if (isZodObject(value)) return value
  if (isJsonSchemaObject(value)) return jsonSchemaToZod(value)
  return z.record(z.string(), z.unknown()) as unknown as z.ZodObject<z.ZodRawShape>
}

function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_def" in value &&
    typeof (value as { _def?: { typeName?: unknown } })._def === "object" &&
    (value as { _def: { typeName?: unknown } })._def !== null
  )
}

interface JsonSchemaObject {
  readonly type: "object"
  readonly properties?: Record<string, { readonly type?: string; readonly items?: unknown }>
  readonly required?: readonly string[]
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "object" &&
    typeof (value as { properties?: unknown }).properties === "object"
  )
}

function jsonSchemaToZod(schema: JsonSchemaObject): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {}
  const required = new Set(schema.required ?? [])

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let field: z.ZodTypeAny = jsonSchemaFieldToZod(prop)
    if (!required.has(key)) {
      field = field.optional()
    }
    shape[key] = field
  }

  return z.object(shape)
}

function jsonSchemaFieldToZod(prop: {
  readonly type?: string
  readonly items?: unknown
}): z.ZodTypeAny {
  switch (prop.type) {
    case "string":
      return z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array": {
      const items = prop.items as { readonly type?: string } | undefined
      if (items?.type === "string") return z.array(z.string())
      if (items?.type === "number" || items?.type === "integer") return z.array(z.number())
      if (items?.type === "boolean") return z.array(z.boolean())
      return z.array(z.unknown())
    }
    default:
      return z.unknown()
  }
}
