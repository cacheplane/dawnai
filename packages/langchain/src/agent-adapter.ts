import type { PromptFragment, StreamTransformer } from "@dawn-ai/core"
import type { DawnAgent, RetryConfig } from "@dawn-ai/sdk"
import { isDawnAgent } from "@dawn-ai/sdk"
import { type BaseMessageLike, HumanMessage } from "@langchain/core/messages"
import { Command, MemorySaver } from "@langchain/langgraph"
import { createChatModel } from "./chat-model-factory.js"
import { resolveProvider } from "./model-provider-resolver.js"
import {
  clearPending,
  type PendingInterrupt,
  type ResumeDecision,
  setPending,
} from "./pending-interrupts.js"
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

/**
 * Process-level checkpointer shared by every materialized agent. LangGraph
 * requires a checkpointer + a stable `thread_id` for `interrupt()` to park
 * graph state and for `new Command({resume})` to replay from the parked
 * step. The dev/runtime server passes the client-supplied
 * `metadata.dawn.thread_id` through to `streamAgent`, which forwards it to
 * `config.configurable.thread_id`.
 *
 * Single shared instance is fine for in-process runtimes; revisit if the
 * runtime ever runs across processes (each would have its own saver and
 * resume would need a distributed checkpointer like SQLite/Postgres).
 */
const sharedCheckpointer = new MemorySaver()

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
    ...(descriptor.provider !== undefined ? { provider: descriptor.provider } : {}),
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
    // Required so `interrupt()` can park graph state and `Command({resume})`
    // can replay it. Paired with `config.configurable.thread_id`.
    checkpointer: sharedCheckpointer,
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
  readonly type: "token" | "tool_call" | "tool_result" | "interrupt" | "done" | (string & {})
  readonly data: unknown
}

/**
 * LangGraph 1.x surfaces `interrupt()` calls in the graph's final output under
 * the `__interrupt__` key — there is no dedicated `on_interrupt` streamEvents
 * v2 event. We detect interrupts by inspecting `on_chain_end` for the
 * top-level `LangGraph` chain.
 */
const INTERRUPT_KEY = "__interrupt__"

interface RawInterruptEntry {
  readonly value?: unknown
  readonly id?: string
  readonly when?: string
  readonly resumable?: boolean
}

function extractInterrupts(output: unknown): readonly RawInterruptEntry[] | undefined {
  if (!output || typeof output !== "object") return undefined
  const maybe = (output as Record<string, unknown>)[INTERRUPT_KEY]
  if (!Array.isArray(maybe)) return undefined
  return maybe as readonly RawInterruptEntry[]
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
  /**
   * Stable per-conversation identifier used as LangGraph's `thread_id`. When
   * set, the agent-adapter wires it into `config.configurable.thread_id` so
   * the checkpointer can park interrupted state. Required for resume to work
   * — without a thread_id, an interrupt ends the stream with no way to
   * replay.
   */
  readonly threadId?: string
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
      options.threadId,
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
    options.threadId,
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

  const configurable: Record<string, unknown> = { ...params }
  if (options.threadId !== undefined && options.threadId.length > 0) {
    configurable.thread_id = options.threadId
  }
  if (Object.keys(configurable).length > 0) {
    config.configurable = configurable
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
  threadId?: string,
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

  // Capture into a typed const so TS narrowing survives across the nested
  // async-generator closure below. Bind to `streamable` — LangGraph's
  // Pregel.streamEvents reads `this.config?.recursionLimit`, so calling it
  // unbound throws "Cannot read properties of undefined (reading 'config')".
  const streamEventsFn = streamable.streamEvents.bind(streamable)

  // Tracks the most recent invocation's outcome. The outer resume loop
  // inspects this to decide whether to park + replay or finish.
  interface PassResult {
    readonly finalOutput: unknown
    readonly interrupts: readonly RawInterruptEntry[]
  }

  // Process a single streamEvents iterator: yield AgentStreamChunks and
  // return whatever __interrupt__ entries appeared in the graph's final
  // on_chain_end output. Shared between the initial invocation and any
  // resume re-invocations so the chunk-shaping logic stays in one place.
  async function* processEventStream(
    invocationInput: unknown,
    invocationConfig: Record<string, unknown>,
    allowRetryOnError: boolean,
  ): AsyncGenerator<AgentStreamChunk, PassResult, void> {
    let finalOutput: unknown
    let capturedInterrupts: readonly RawInterruptEntry[] = []
    let hasYielded = false

    const maxStreamAttempts = allowRetryOnError ? (retryConfig?.maxAttempts ?? 3) : 1

    for (let attempt = 0; attempt < maxStreamAttempts; attempt++) {
      hasYielded = false
      finalOutput = undefined
      capturedInterrupts = []

      try {
        for await (const event of streamEventsFn(invocationInput, {
          ...invocationConfig,
          version: "v2",
        })) {
          yield* drainSubagentEvents()
          switch (event.event) {
            case "on_chat_model_stream": {
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
                const interrupts = extractInterrupts(event.data.output)
                if (interrupts && interrupts.length > 0) {
                  capturedInterrupts = interrupts
                  for (const entry of interrupts) {
                    hasYielded = true
                    yield {
                      type: "interrupt" as const,
                      // The capability's interrupt() payload is wrapped in
                      // entry.value by LangGraph — surface it verbatim so the
                      // SSE consumer sees the original {interruptId, kind, ...}
                      // envelope the workspace capability emitted.
                      data: entry.value,
                    }
                  }
                }
              }
              break
            }
          }
        }
        // Stream completed successfully
        return { finalOutput, interrupts: capturedInterrupts }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        if (hasYielded || !isRetryableError(error) || attempt === maxStreamAttempts - 1) {
          throw err
        }
        const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 10_000)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    // Unreachable: the loop either returns or throws.
    return { finalOutput, interrupts: capturedInterrupts }
  }

  // Initial invocation. Retries on transient errors before any chunk yields.
  let pass = yield* processEventStream(input, config, /* allowRetryOnError */ true)

  // Resume loop. Each interrupt → park → await decision → re-invoke with
  // Command({resume}). The resume invocation may itself interrupt (e.g. a
  // capability gates another tool call mid-run) — loop until either no
  // interrupt remains or we cannot resume (no threadId / no resolved
  // decision).
  while (pass.interrupts.length > 0) {
    if (!threadId) {
      // Without a thread_id there is no checkpointer key to replay from;
      // the parked state will be discarded. End the stream cleanly so the
      // SSE consumer can surface the interrupt to the user, but they have
      // no way to resume this run.
      break
    }

    // We only resume the first interrupt — if a capability ever fans out
    // multiple parallel interrupts in a single step, this becomes lossy
    // and we'd need to await N decisions. None of today's capabilities do
    // that; revisit when one does.
    const entry = pass.interrupts[0]
    const interruptId =
      (typeof entry?.id === "string" ? entry.id : undefined) ?? `generated-${Date.now()}`

    const decision = await new Promise<ResumeDecision>((resolve) => {
      const pending: PendingInterrupt = { interruptId, resolve }
      setPending(threadId, pending)
    })
    clearPending(threadId)

    // Resume invocations reuse the same config (same thread_id, signal,
    // configurable). Retry-on-error is disabled because we have already
    // yielded the interrupt chunk; if the resume call fails we surface
    // the error rather than silently restarting.
    pass = yield* processEventStream(
      new Command({ resume: decision }),
      config,
      /* allowRetryOnError */ false,
    )
  }

  // Final drain in case the last tool call was the bridged task tool —
  // its events would otherwise be stranded after the stream ends.
  yield* drainSubagentEvents()
  yield { type: "done", data: pass.finalOutput }
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
