export interface RuntimeContext<
  TTools extends Record<string, RuntimeTool<any, any, any>> = Record<
    string,
    RuntimeTool<any, any, any>
  >,
> {
  readonly signal: AbortSignal
  readonly tools: TTools
}

export interface RuntimeTool<TInput = unknown, TOutput = unknown, TContext = RuntimeContext> {
  readonly name: string
  readonly description?: string
  readonly run: (input: TInput, context?: TContext) => Promise<TOutput> | TOutput
}
