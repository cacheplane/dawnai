import type { JsonSchemaProperty } from "@dawn-ai/core"
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

export type OffloadFn = (content: string, toolName: string, toolCallId?: string) => Promise<string>

export function convertToolToLangChain(
  tool: DawnToolDefinition,
  middlewareContext?: Readonly<Record<string, unknown>>,
  offload?: OffloadFn,
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
      const toolCallId = extractToolCallId(config)
      const finalContent = offload
        ? await offload(content, tool.name, toolCallId || undefined)
        : content

      if (stateUpdates) {
        return new Command({
          update: {
            ...stateUpdates,
            messages: [
              new ToolMessage({
                content: finalContent,
                tool_call_id: toolCallId,
                name: tool.name,
              }),
            ],
          },
        })
      }

      return finalContent
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

function isJsonSchemaObject(value: unknown): value is JsonSchemaProperty & { type: "object" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "object" &&
    typeof (value as { properties?: unknown }).properties === "object"
  )
}

const MAX_ZOD_DEPTH = 8

export function jsonSchemaToZod(schema: JsonSchemaProperty): z.ZodObject<z.ZodRawShape> {
  return objectToZod(schema, 0) as z.ZodObject<z.ZodRawShape>
}

function objectToZod(prop: JsonSchemaProperty, depth: number): z.ZodTypeAny {
  // Record<string,T>: schema-valued additionalProperties and no named properties.
  if (
    typeof prop.additionalProperties === "object" &&
    prop.additionalProperties !== null &&
    (!prop.properties || Object.keys(prop.properties).length === 0)
  ) {
    return z.record(z.string(), jsonSchemaFieldToZod(prop.additionalProperties, depth + 1))
  }

  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(prop.required ?? [])
  for (const [key, sub] of Object.entries(prop.properties ?? {})) {
    let field = jsonSchemaFieldToZod(sub, depth + 1)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return z.object(shape)
}

function jsonSchemaFieldToZod(prop: JsonSchemaProperty, depth = 0): z.ZodTypeAny {
  if (depth > MAX_ZOD_DEPTH) return z.string()

  // Object unions are emitted as anyOf (no `type`); map to z.union.
  if (prop.anyOf && prop.anyOf.length > 0) {
    const members = prop.anyOf.map((m) => jsonSchemaFieldToZod(m, depth + 1))
    if (members.length === 1) return members[0] ?? z.unknown()
    return z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }

  switch (prop.type) {
    case "string":
      return prop.enum && prop.enum.length > 0
        ? z.enum([...prop.enum] as [string, ...string[]])
        : z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array": {
      const items = prop.items
      return items ? z.array(jsonSchemaFieldToZod(items, depth + 1)) : z.array(z.unknown())
    }
    case "object":
      return objectToZod(prop, depth)
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
