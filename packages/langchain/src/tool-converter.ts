import { DynamicStructuredTool } from "@langchain/core/tools"
import { z } from "zod"

interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<unknown> | unknown
  readonly schema?: unknown
}

export function convertToolToLangChain(tool: DawnToolDefinition): DynamicStructuredTool {
  const schema = isZodObject(tool.schema) ? tool.schema : z.record(z.string(), z.unknown())

  // Cast through unknown to bridge the dual-Zod version type incompatibility
  // (package uses zod@3.24.4; @langchain/core uses zod@3.25.x — structurally identical at runtime)
  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema: schema as unknown as z.ZodObject<z.ZodRawShape>,
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const result = await tool.run(input, { signal })
      return JSON.stringify(result)
    },
  }) as unknown as DynamicStructuredTool
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
