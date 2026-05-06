import { AIMessage, ToolMessage } from "@langchain/core/messages"

const DEFAULT_MAX_ITERATIONS = 10

interface ToolExecutor {
  readonly name: string
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
    },
  ) => Promise<unknown> | unknown
}

export interface ExecuteWithToolLoopOptions {
  readonly chain: { readonly invoke: (input: unknown) => Promise<unknown> }
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly tools: readonly ToolExecutor[]
  readonly signal: AbortSignal
  readonly maxIterations?: number
}

export async function executeWithToolLoop(options: ExecuteWithToolLoopOptions): Promise<unknown> {
  const {
    chain,
    input,
    middlewareContext,
    tools,
    signal,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = options
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  let currentInput: unknown = input

  for (let i = 0; i < maxIterations; i++) {
    const result = await chain.invoke(currentInput)

    if (!isAIMessageWithToolCalls(result)) {
      return result
    }

    const toolMessages = await Promise.all(
      result.tool_calls.map(async (call) => {
        const tool = toolMap.get(call.name)
        if (!tool) {
          return new ToolMessage({
            content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
            tool_call_id: call.id ?? "",
          })
        }
        try {
          const output = await tool.run(call.args, {
            ...(middlewareContext ? { middleware: middlewareContext } : {}),
            signal,
          })
          return new ToolMessage({
            content: JSON.stringify(output),
            tool_call_id: call.id ?? "",
          })
        } catch (error) {
          return new ToolMessage({
            content: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
            tool_call_id: call.id ?? "",
          })
        }
      }),
    )

    currentInput = [
      ...(Array.isArray(currentInput) ? (currentInput as unknown[]) : []),
      result,
      ...toolMessages,
    ]
  }

  throw new Error(`Tool execution loop exceeded maximum ${maxIterations} iterations`)
}

function isAIMessageWithToolCalls(value: unknown): value is AIMessage & {
  tool_calls: readonly { id?: string; name: string; args: unknown }[]
} {
  return (
    value instanceof AIMessage &&
    Array.isArray((value as AIMessage & { tool_calls?: unknown }).tool_calls) &&
    (value as AIMessage & { tool_calls: unknown[] }).tool_calls.length > 0
  )
}
