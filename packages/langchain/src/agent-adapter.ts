import type { PromptFragment, StreamTransformer } from "@dawn-ai/core"
import type { DawnAgent, RetryConfig } from "@dawn-ai/sdk"
import { isDawnAgent } from "@dawn-ai/sdk"
import { type BaseMessageLike, HumanMessage } from "@langchain/core/messages"
import { isRetryableError, withRetry } from "./retry.js"
import { materializeStateSchema, type ResolvedStateField } from "./state-adapter.js"
import { convertToolToLangChain } from "./tool-converter.js"

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

interface AgentLike {
  readonly invoke: (input: unknown, config?: unknown) => Promise<unknown>
}

function assertAgentLike(entry: unknown): asserts entry is AgentLike {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("invoke" in entry) ||
    typeof (entry as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error("Agent entry must expose invoke(input) — expected a LangChain agent")
  }
}

// Cache keyed on descriptor only. Assumption: a given descriptor is always
// invoked with the same capability contributions (prompt fragments come from
// the route directory, which is stable per descriptor). If that assumption
// changes, the cache key must include a hash of the fragments/transformers.
const materializedAgents = new WeakMap<DawnAgent, AgentLike>()

export function composePromptMessages(
  systemPrompt: string,
  promptFragments: readonly PromptFragment[],
  state: Record<string, unknown>,
): BaseMessageLike[] {
  const rendered = promptFragments
    .filter((f) => f.placement === "after_user_prompt")
    .map((f) => f.render(state))
    .filter((s) => s.length > 0)
  const composed = [systemPrompt, ...rendered].join("\n\n")
  const messages = Array.isArray(state.messages) ? (state.messages as BaseMessageLike[]) : []
  return [{ role: "system", content: composed }, ...messages]
}

async function materializeAgent(
  descriptor: DawnAgent,
  tools: readonly DawnToolDefinition[],
  stateFields?: readonly ResolvedStateField[],
  middlewareContext?: Readonly<Record<string, unknown>>,
  promptFragments?: readonly PromptFragment[],
): Promise<AgentLike> {
  const cached = materializedAgents.get(descriptor)
  if (cached) {
    return cached
  }

  const { createReactAgent } = await import("@langchain/langgraph/prebuilt")
  const { ChatOpenAI } = await import("@langchain/openai")

  const langchainTools = tools.map((tool) => convertToolToLangChain(tool, middlewareContext))

  const llm = new ChatOpenAI({
    model: descriptor.model,
    // Maps to OpenAI's reasoningEffort param. Non-reasoning models ignore it.
    // Default is `medium` for pre-gpt-5.1 reasoning models per OpenAI docs.
    // Bump to `high` for tool-use-heavy agents that aren't following directives.
    ...(descriptor.reasoning?.effort ? { reasoningEffort: descriptor.reasoning.effort } : {}),
  })

  const fragments = promptFragments ?? []
  const agentOptions: Record<string, unknown> = {
    llm,
    tools: langchainTools,
    // Function-form prompt re-renders fragments on every model turn so they
    // can reflect live state (e.g., the current todos list).
    prompt:
      fragments.length > 0
        ? (state: Record<string, unknown>) =>
            composePromptMessages(descriptor.systemPrompt, fragments, state)
        : descriptor.systemPrompt,
  }

  if (stateFields && stateFields.length > 0) {
    agentOptions.stateSchema = materializeStateSchema(stateFields)
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options don't satisfy strict StateDefinition type
  const compiled = createReactAgent(agentOptions as any)

  materializedAgents.set(descriptor, compiled as unknown as AgentLike)
  return compiled as unknown as AgentLike
}

export interface AgentStreamChunk {
  readonly type: "token" | "tool_call" | "tool_result" | "done" | (string & {})
  readonly data: unknown
}

export interface AgentOptions {
  readonly entry: unknown
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly retry?: RetryConfig
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly stateFields?: readonly ResolvedStateField[]
  readonly tools: readonly DawnToolDefinition[]
  readonly promptFragments?: readonly PromptFragment[]
  readonly streamTransformers?: readonly StreamTransformer[]
}

export async function executeAgent(options: AgentOptions): Promise<unknown> {
  let result: unknown
  for await (const chunk of streamAgent(options)) {
    if (chunk.type === "done") {
      result = chunk.data
    }
  }
  return result
}

export async function* streamAgent(options: AgentOptions): AsyncGenerator<AgentStreamChunk> {
  const { agentInput, config } = prepareAgentCall(options)
  const messages = extractMessages(agentInput)

  // DawnAgent descriptor path — materialize on first use
  if (isDawnAgent(options.entry)) {
    const materializedAgent = await materializeAgent(
      options.entry,
      options.tools,
      options.stateFields,
      options.middlewareContext,
      options.promptFragments,
    )
    const retryConfig = options.entry.retry
    yield* streamFromRunnable(
      materializedAgent,
      { messages },
      config,
      retryConfig,
      options.streamTransformers,
    )
    return
  }

  // Legacy path — raw Runnable with .invoke()
  assertAgentLike(options.entry)

  const langchainTools = options.tools.map((tool) =>
    convertToolToLangChain(tool, options.middlewareContext),
  )
  if (langchainTools.length > 0) {
    config.tools = langchainTools
  }

  yield* streamFromRunnable(
    options.entry,
    { messages },
    config,
    options.retry,
    options.streamTransformers,
  )
}

function prepareAgentCall(options: AgentOptions): {
  agentInput: Record<string, unknown>
  config: Record<string, unknown>
} {
  const inputRecord = (options.input ?? {}) as Record<string, unknown>
  const params: Record<string, unknown> = {}
  const agentInput: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(inputRecord)) {
    if (options.routeParamNames.includes(key)) {
      params[key] = value
    } else {
      agentInput[key] = value
    }
  }

  const config: Record<string, unknown> = {
    signal: options.signal,
  }

  if (Object.keys(params).length > 0) {
    config.configurable = params
  }

  return { agentInput, config }
}

async function* streamFromRunnable(
  runnable: AgentLike,
  input: unknown,
  config: Record<string, unknown>,
  retryConfig?: RetryConfig,
  streamTransformers?: readonly StreamTransformer[],
): AsyncGenerator<AgentStreamChunk> {
  const streamable = runnable as AgentLike & {
    streamEvents?: (
      input: unknown,
      options: Record<string, unknown>,
    ) => AsyncIterable<{
      event: string
      data: { chunk?: unknown; output?: unknown }
      name: string
    }>
  }

  if (typeof streamable.streamEvents !== "function") {
    // Fallback: invoke with retry and emit a single done event
    const signal = config.signal as AbortSignal | undefined
    const retryOptions: import("./retry.js").RetryOptions = {
      ...(retryConfig?.maxAttempts ? { maxAttempts: retryConfig.maxAttempts } : {}),
      ...(retryConfig?.baseDelay ? { baseDelayMs: retryConfig.baseDelay } : {}),
      ...(signal ? { signal } : {}),
    }
    const result = await withRetry(
      () => runnable.invoke(input, config),
      Object.keys(retryOptions).length > 0 ? retryOptions : undefined,
    )
    yield { type: "done", data: result }
    return
  }

  let finalOutput: unknown
  let hasYielded = false
  let lastStreamError: Error | undefined

  // Retry the entire stream if it fails before producing any output
  const maxStreamAttempts = retryConfig?.maxAttempts ?? 3
  for (let attempt = 0; attempt < maxStreamAttempts; attempt++) {
    hasYielded = false
    lastStreamError = undefined
    finalOutput = undefined

    try {
      for await (const event of streamable.streamEvents(input, {
        ...config,
        version: "v2",
      })) {
        switch (event.event) {
          case "on_chat_model_stream": {
            const content = (event.data.chunk as { content?: unknown })?.content
            if (content && typeof content === "string" && content.length > 0) {
              hasYielded = true
              yield { type: "token" as const, data: content }
            }
            break
          }
          case "on_tool_start": {
            hasYielded = true
            yield {
              type: "tool_call" as const,
              data: {
                name: event.name,
                input: event.data.chunk ?? event.data.output,
              },
            }
            break
          }
          case "on_tool_end": {
            hasYielded = true
            yield {
              type: "tool_result" as const,
              data: { name: event.name, output: event.data.output },
            }
            for (const transformer of streamTransformers ?? []) {
              if (transformer.observes !== "tool_result") continue
              for await (const out of transformer.transform({
                toolName: event.name,
                toolOutput: event.data.output,
              })) {
                yield {
                  type: out.event as AgentStreamChunk["type"],
                  data: out.data,
                }
              }
            }
            break
          }
          case "on_chain_end": {
            if (event.name === "LangGraph") {
              finalOutput = event.data.output
            }
            break
          }
        }
      }

      // Stream completed successfully
      break
    } catch (error) {
      lastStreamError = error instanceof Error ? error : new Error(String(error))

      // If we already yielded chunks, we can't retry (client has partial data)
      // Or if the error isn't retryable, rethrow immediately
      if (hasYielded || !isRetryableError(error) || attempt === maxStreamAttempts - 1) {
        throw lastStreamError
      }

      // Backoff before retry
      const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 10_000)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  yield { type: "done", data: finalOutput }
}

interface InputMessage {
  readonly role: string
  readonly content: string
}

function isInputMessageArray(value: unknown): value is readonly InputMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { role?: unknown }).role === "string" &&
        typeof (item as { content?: unknown }).content === "string",
    )
  )
}

function extractMessages(input: Record<string, unknown>): HumanMessage[] {
  // LangGraph protocol format: {messages: [{role, content}, ...]}
  if (isInputMessageArray(input.messages)) {
    return input.messages
      .filter((msg) => msg.role === "user")
      .map((msg) => new HumanMessage(msg.content))
  }

  // Legacy flat-object format: {key: value, ...}
  return [new HumanMessage(formatAgentMessage(input))]
}

function formatAgentMessage(input: Record<string, unknown>): string {
  const entries = Object.entries(input)

  if (entries.length === 0) {
    return ""
  }

  if (entries.length === 1) {
    return String(entries[0]?.[1])
  }

  return entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n")
}
