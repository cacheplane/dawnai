import { ToolMessage } from "@langchain/core/messages"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { Command } from "@langchain/langgraph"
import { z } from "zod"
import { unwrapToolResult } from "./unwrap-tool-result.js"

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

  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema,
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const rawResult = await tool.run(input, {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
      })
      const { content, stateUpdates } = unwrapToolResult(rawResult)

      if (stateUpdates) {
        const toolCallId = extractToolCallId(config)
        return new Command({
          update: {
            ...stateUpdates,
            messages: [
              new ToolMessage({
                content,
                tool_call_id: toolCallId,
                name: tool.name,
              }),
            ],
          },
        })
      }

      return content
    },
  })
}

function toZodSchema(value: unknown): z.ZodTypeAny {
  if (isZodObject(value)) return value
  if (isJsonSchemaObject(value)) return jsonSchemaToZod(value)
  return z.record(z.string(), z.unknown())
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
  const shape: Record<string, z.ZodTypeAny> = {}
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

function extractToolCallId(config: unknown): string {
  if (typeof config !== "object" || config === null) return ""
  const c = config as Record<string, unknown>
  // LangGraph 1.x exposes the tool call id in different ways depending on
  // the calling code path; try the most likely locations.
  const direct = (c.toolCall as { id?: string } | undefined)?.id
  if (typeof direct === "string") return direct
  const configurable = c.configurable as { toolCallId?: string } | undefined
  if (typeof configurable?.toolCallId === "string") return configurable.toolCallId
  const metadata = c.metadata as { tool_call_id?: string } | undefined
  if (typeof metadata?.tool_call_id === "string") return metadata.tool_call_id
  return ""
}
