import type { ToolContext } from "./runtime-context.js"

export interface ToolDefinition<TInput = unknown, TOutput = unknown, TContext = ToolContext> {
  readonly name: string
  readonly description?: string
  readonly run: (input: TInput, context: TContext) => Promise<TOutput> | TOutput
}

export function defineTool<TTool extends ToolDefinition>(tool: TTool): TTool {
  assertToolName(tool.name)
  assertToolRun(tool.run)
  return tool
}

function assertToolName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Tool name must be a non-empty string")
  }
}

function assertToolRun(run: unknown): asserts run is ToolDefinition["run"] {
  if (typeof run !== "function") {
    throw new Error("Tool run must be a function")
  }
}
