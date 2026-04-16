export interface ToolContext {
  readonly signal: AbortSignal
}

export interface RuntimeContext<
  TTools extends Record<string, RuntimeTool<any, any>> = Record<string, RuntimeTool<any, any>>,
> {
  readonly signal: AbortSignal
  readonly tools: TTools
}

export type RuntimeTool<TInput = unknown, TOutput = unknown> = (
  input: TInput,
) => Promise<TOutput> | TOutput
