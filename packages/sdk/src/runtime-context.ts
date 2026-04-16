export type RuntimeTool<TInput = unknown, TOutput = unknown> = (
  input: TInput,
) => Promise<TOutput> | TOutput

export type ToolRegistry = Record<string, RuntimeTool<never, unknown>>

export interface RuntimeContext<TTools extends ToolRegistry = ToolRegistry> {
  readonly signal: AbortSignal
  readonly tools: TTools
}
