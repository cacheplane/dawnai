import type { RuntimeTool } from "./runtime-context.js"

export interface ToolDefinition<TInput = unknown, TOutput = unknown, TContext = unknown>
  extends RuntimeTool<TInput, TOutput, TContext> {}

export function defineTool<TTool extends ToolDefinition>(tool: TTool): TTool {
  assertToolName(tool.name)
  return tool
}

function assertToolName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("Tools must define a non-empty name")
  }
}
