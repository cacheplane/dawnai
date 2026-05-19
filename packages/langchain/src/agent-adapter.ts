import type { PromptFragment, StreamTransformer } from "@dawn-ai/core"
import type { DawnAgent, RetryConfig } from "@dawn-ai/sdk"
import { isDawnAgent } from "@dawn-ai/sdk"
import { type BaseMessageLike, HumanMessage } from "@langchain/core/messages"
import { createChatModel } from "./chat-model-factory.js"
import { resolveProvider } from "./model-provider-resolver.js"
import { isRetryableError, withRetry } from "./retry.js"
import { materializeStateSchema, type ResolvedStateField } from "./state-adapter.js"
import {
  createSubagentStreamContext,
  type SubagentEvent,
  type SubagentStreamContext,
} from "./subagent-dispatcher.js"
import { bridgeSubagentTool, type SubagentResolverResult } from "./subagent-tool-bridge.js"
import { convertToolToLangChain } from "./tool-converter.js"

export type SubagentResolver = (leafName: string) => SubagentResolverResult | undefined

export interface DawnToolDefinition {
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
  options?: { readonly bypassCache?: boolean },
): Promise<AgentLike> {
  if (!options?.bypassCache) {
    const cached = materializedAgents.get(descriptor)
    if (cached) {
      return cached
    }
  }

  const { createReactAgent } = await import("@langchain/langgraph/prebuilt")

  const langchainTools = tools.map((tool) => convertToolToLangChain(tool, middlewareContext))

  const provider = resolveProvider({
    model: descriptor.model,
    ...(descriptor.provider ? { provider: descriptor.provider } : {}),
  })
  const llm = await createChatModel({
    model: descriptor.model,
    provider,
    ...(descriptor.reasoning ? { reasoning: descriptor.reasoning } : {}),
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

  if (!options?.bypassCache) {
    materializedAgents.set(descriptor, compiled as unknown as AgentLike)
  }
  return compiled as unknown as AgentLike
}

export async function materializeAgentGraph(options: {
  readonly descriptor: DawnAgent
  readonly tools?: readonly DawnToolDefinition[]
  readonly stateFields?: readonly ResolvedStateField[]
  readonly promptFragments?: readonly PromptFragment[]
}): Promise<unknown> {
  return materializeAgent(
    options.descriptor,
    options.tools ?? [],
    options.stateFields,
    undefined,
    options.promptFragments,
  )
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
  /**
   * Resolves a subagent leaf name to a child graph + routeId. When set, the
   * `task` tool contributed by the subagents capability marker is intercepted
   * inside `streamFromRunnable` and replaced with a bridge that dispatches the
   * call via `dispatchSubagent`. Emitted `subagent.*` events are queued and
   * drained alongside normal stream chunks (no module-level mutable state).
   */
  readonly subagentResolver?: SubagentResolver
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

  // Per-call subagent event queue. The bridge's writer pushes here; the
  // streaming generator drains the queue alongside normal stream chunks. This
  // avoids the module-level mutable-writer anti-pattern: each call has its
  // own queue scoped to the surrounding generator frame.
  const subagentEvents: AgentStreamChunk[] = []
  const queueWriter = (event: SubagentEvent): void => {
    subagentEvents.push({
      type: event.event as AgentStreamChunk["type"],
      data: event.data,
    })
  }

  // Per-call counter shared with the dispatcher. While a child is active, the
  // parent's on_chat_model_stream events are suppressed (LangChain v2
  // streamEvents propagates child events to the parent listener via
  // async-local-storage tracing, so without this gate every child token
  // appears twice on the parent stream: once as a raw token chunk and once
  // wrapped in a subagent.message envelope).
  const streamContext = createSubagentStreamContext()

  const resolver = options.subagentResolver
  const hasTaskTool = options.tools.some((t) => t.name === "task")
  const effectiveTools: readonly DawnToolDefinition[] =
    resolver && hasTaskTool
      ? options.tools.map((t) =>
          t.name === "task"
            ? {
                ...t,
                run: bridgeSubagentTool({
                  subagentResolver: resolver,
                  writer: queueWriter,
                  parentConfig: config,
                  streamContext,
                }).run as DawnToolDefinition["run"],
              }
            : t,
        )
      : options.tools

  // DawnAgent descriptor path — materialize on first use
  if (isDawnAgent(options.entry)) {
    // Bypass the per-descriptor cache when a resolver is wired: the bridged
    // tool closes over the per-call queue + parent config, so caching would
    // bind those to a single call.
    const materializedAgent = await materializeAgent(
      options.entry,
      effectiveTools,
      options.stateFields,
      options.middlewareContext,
      options.promptFragments,
      resolver && hasTaskTool ? { bypassCache: true } : undefined,
    )
    const retryConfig = options.entry.retry
    yield* streamFromRunnable(
      materializedAgent,
      { messages },
      config,
      retryConfig,
      options.streamTransformers,
      subagentEvents,
      streamContext,
    )
    return
  }

  // Legacy path — raw Runnable with .invoke()
  assertAgentLike(options.entry)

  const langchainTools = effectiveTools.map((tool) =>
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
    subagentEvents,
    streamContext,
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
  subagentEvents?: AgentStreamChunk[],
  streamContext?: SubagentStreamContext,
): AsyncGenerator<AgentStreamChunk> {
  // Drains any pending subagent events queued by the bridge. Called before
  // each normal yield to keep ordering predictable on the single event loop.
  function* drainSubagentEvents(): Generator<AgentStreamChunk> {
    if (!subagentEvents) return
    while (subagentEvents.length > 0) {
      const next = subagentEvents.shift()
      if (next) yield next
    }
  }
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
        // Drain any subagent.* events queued by the bridge's writer before
        // emitting the next normal stream chunk, so ordering is predictable.
        yield* drainSubagentEvents()
        switch (event.event) {
          case "on_chat_model_stream": {
            // Suppress while a child subagent run is active — child token
            // events leak onto the parent's streamEvents listener via
            // LangChain v2 async-local-storage tracing. The dispatcher
            // already emits a `subagent.message` envelope for each child
            // token, so emitting the raw token here would duplicate.
            if (streamContext && streamContext.activeChildRuns > 0) break
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

  // Final drain in case the last tool call was the bridged task tool —
  // its events would otherwise be stranded after the stream ends.
  yield* drainSubagentEvents()
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
