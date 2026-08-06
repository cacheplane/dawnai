import type { PromptFragment, StreamTransformer } from "@dawn-ai/core"
import type { DawnAgent, RetryConfig } from "@dawn-ai/sdk"
import { isDawnAgent } from "@dawn-ai/sdk"
import { type BaseMessageLike, HumanMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { createChatModel } from "./chat-model-factory.js"
import { resolveProvider } from "./model-provider-resolver.js"
import { isRetryableError, withRetry } from "./retry.js"
import { materializeStateSchema, type ResolvedStateField } from "./state-adapter.js"
import { convertSubagentTaskToLangChain, type SubagentResolver } from "./subagent-tool-bridge.js"
import { buildSummarizationHook, type ResolvedSummarizationConfig } from "./summarization/index.js"
import { convertToolToLangChain, type OffloadFn } from "./tool-converter.js"

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

// Cache keyed on descriptor, guarded by a fingerprint of the prompt fragments'
// load-time data. Prompt fragments come from the route directory (stable per
// descriptor), but some fragments close over external state captured at load
// time — e.g. the memory-index fragment snapshots the active store rows. Those
// fragments expose a `cacheKey`; when it changes (a memory written mid-process)
// the fingerprint changes and the agent re-materializes instead of serving a
// stale prompt. Fragments without a cacheKey are treated as stable.
interface CachedAgent {
  readonly fingerprint: string
  readonly agent: AgentLike
}
let materializedAgents = new WeakMap<DawnAgent, CachedAgent>()

function fragmentFingerprint(fragments: readonly PromptFragment[]): string {
  return fragments.map((f) => f.cacheKey ?? "").join("|")
}

/**
 * Test-only escape hatch: reset the materialized-agents cache so the next
 * harness run creates a fresh LLM instance (e.g. pointing at a new aimock
 * port). Exported (and re-exported via `@dawn-ai/cli/runtime`) so the
 * `@dawn-ai/testing` harness can clear the cache on teardown. Not for
 * production use; the `__`/`ForTests` name marks it internal-by-convention.
 */
export function __resetMaterializedAgentsForTests(): void {
  materializedAgents = new WeakMap()
}

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
  checkpointer: BaseCheckpointSaver | undefined,
  opts: {
    readonly stateFields?: readonly ResolvedStateField[]
    readonly middlewareContext?: Readonly<Record<string, unknown>>
    readonly promptFragments?: readonly PromptFragment[]
    readonly bypassCache?: boolean
    readonly offload?: OffloadFn
    readonly summarization?: ResolvedSummarizationConfig
    readonly routeParamNames?: readonly string[]
    readonly streamTransformers?: readonly StreamTransformer[]
    readonly subagentResolver?: SubagentResolver
  } = {},
): Promise<AgentLike> {
  const fingerprint = fragmentFingerprint(opts.promptFragments ?? [])
  const bypassCache =
    checkpointer === undefined ||
    opts.subagentResolver !== undefined ||
    opts.bypassCache === true ||
    (opts.streamTransformers?.length ?? 0) > 0

  if (!bypassCache) {
    const cached = materializedAgents.get(descriptor)
    if (cached && cached.fingerprint === fingerprint) {
      return cached.agent
    }
  }

  const { createReactAgent } = await import("@langchain/langgraph/prebuilt")

  const langchainTools = tools.map((tool) =>
    tool.name === "task" && opts.subagentResolver
      ? convertSubagentTaskToLangChain(tool, opts.subagentResolver)
      : convertToolToLangChain(
          tool,
          opts.middlewareContext,
          opts.offload,
          opts.routeParamNames ?? [],
          opts.streamTransformers ?? [],
        ),
  )

  const provider = resolveProvider({
    model: descriptor.model,
    ...(descriptor.provider !== undefined ? { provider: descriptor.provider } : {}),
  })
  const llm = await createChatModel({
    model: descriptor.model,
    provider,
    ...(descriptor.reasoning ? { reasoning: descriptor.reasoning } : {}),
  })

  const fragments = opts.promptFragments ?? []
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
    ...(checkpointer ? { checkpointer } : {}),
  }

  const runningSummaryField: ResolvedStateField = {
    name: "runningSummary",
    reducer: "replace",
    default: undefined,
  }
  const effectiveStateFields: readonly ResolvedStateField[] = opts.summarization
    ? [...(opts.stateFields ?? []).filter((f) => f.name !== "runningSummary"), runningSummaryField]
    : (opts.stateFields ?? [])

  if (effectiveStateFields.length > 0) {
    agentOptions.stateSchema = materializeStateSchema(effectiveStateFields)
  }

  if (opts.summarization) {
    agentOptions.preModelHook = buildSummarizationHook(opts.summarization)
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options don't satisfy strict StateDefinition type
  const compiled = createReactAgent(agentOptions as any)

  if (!bypassCache) {
    materializedAgents.set(descriptor, { fingerprint, agent: compiled as unknown as AgentLike })
  }
  return compiled as unknown as AgentLike
}

export async function materializeAgentGraph(options: {
  readonly checkpointer?: BaseCheckpointSaver
  readonly descriptor: DawnAgent
  readonly tools?: readonly DawnToolDefinition[]
  readonly stateFields?: readonly ResolvedStateField[]
  readonly streamTransformers?: readonly StreamTransformer[]
  readonly promptFragments?: readonly PromptFragment[]
  readonly summarization?: ResolvedSummarizationConfig
  readonly subagentResolver?: SubagentResolver
  /**
   * Set when the caller's tools are bound to a per-thread sandbox (workspace
   * fs/exec backends). Bypasses the per-descriptor cache so one thread's
   * sandbox closures never leak into another thread's agent.
   */
  readonly sandboxed?: boolean
}): Promise<unknown> {
  return materializeAgent(options.descriptor, options.tools ?? [], options.checkpointer, {
    ...(options.stateFields ? { stateFields: options.stateFields } : {}),
    ...(options.promptFragments ? { promptFragments: options.promptFragments } : {}),
    ...(options.summarization ? { summarization: options.summarization } : {}),
    ...(options.streamTransformers ? { streamTransformers: options.streamTransformers } : {}),
    ...(options.subagentResolver ? { subagentResolver: options.subagentResolver } : {}),
    ...(options.sandboxed === true ? { bypassCache: true } : {}),
  })
}

export interface AgentStreamChunk {
  readonly type: "token" | "tool_call" | "tool_result" | "interrupt" | "done" | (string & {})
  readonly data: unknown
}

interface CapabilityEventPayload {
  readonly data: unknown
  readonly event: string
}

interface LangChainStreamEvent {
  readonly event: string
  readonly run_id: string
  readonly data: Record<string, unknown> & {
    readonly chunk?: unknown
    readonly input?: unknown
    readonly output?: unknown
    readonly error?: unknown
  }
  readonly metadata?: Record<string, unknown>
  readonly name: string
  readonly parent_ids?: string[]
}

interface SubagentContext {
  readonly callId: string
  readonly depth: number
  readonly name: string
  readonly routeId: string
}

interface StreamEventProjection {
  readonly capturesFinalOutput: boolean
  readonly child: SubagentContext | undefined
  readonly chunks: readonly AgentStreamChunk[]
  readonly finalOutput: unknown
  readonly interrupts: readonly RawInterruptEntry[]
}

interface SubagentToolRunContexts {
  readonly contextsByToolRunId: Map<string, SubagentContext | null>
}

interface SubagentPhaseProjection {
  readonly chunk: AgentStreamChunk
  readonly context: SubagentContext
  readonly toolRunId: string | undefined
}

const CAPABILITY_EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/
const RESERVED_ROOT_EVENT_NAMES = new Set([
  "chunk",
  "token",
  "tool_call",
  "tool_result",
  "interrupt",
  "done",
])

function isCapabilityEventName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CAPABILITY_EVENT_NAME_PATTERN.test(value) &&
    !RESERVED_ROOT_EVENT_NAMES.has(value) &&
    !value.startsWith("subagent.")
  )
}

function parseCapabilityEvent(value: unknown): CapabilityEventPayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const payload = value as Record<string, unknown>
  if (!Object.hasOwn(payload, "event")) return undefined
  if (!isCapabilityEventName(payload.event)) return undefined
  if (!Object.hasOwn(payload, "data")) return undefined
  return { event: payload.event, data: payload.data }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSubagentContext(
  metadata: Record<string, unknown> | undefined,
): SubagentContext | undefined {
  const dawn = metadata?.dawn
  if (!isRecord(dawn)) return undefined
  const stack = dawn.subagent_stack
  if (!Array.isArray(stack) || stack.length === 0) return undefined

  for (const value of stack) {
    if (!isRecord(value)) return undefined
    if (typeof value.callId !== "string" || value.callId === "") return undefined
    if (typeof value.name !== "string" || value.name === "") return undefined
    if (typeof value.routeId !== "string" || value.routeId === "") return undefined
  }

  const top = stack.at(-1) as Record<string, unknown>
  return {
    callId: top.callId as string,
    depth: stack.length,
    name: top.name as string,
    routeId: top.routeId as string,
  }
}

function sameSubagentContext(left: SubagentContext, right: SubagentContext): boolean {
  return (
    left.callId === right.callId &&
    left.depth === right.depth &&
    left.name === right.name &&
    left.routeId === right.routeId
  )
}

function indexSubagentContext(
  toolRuns: SubagentToolRunContexts,
  toolRunId: string,
  context: SubagentContext,
): void {
  const existing = toolRuns.contextsByToolRunId.get(toolRunId)
  if (existing === undefined) {
    toolRuns.contextsByToolRunId.set(toolRunId, context)
  } else if (existing !== null && !sameSubagentContext(existing, context)) {
    toolRuns.contextsByToolRunId.set(toolRunId, null)
  }
}

function resolveEventSubagentContext(
  event: LangChainStreamEvent,
  toolRuns: SubagentToolRunContexts,
): SubagentContext | undefined {
  const direct = parseSubagentContext(event.metadata)
  if (direct) return direct
  if (event.event !== "on_tool_error") return undefined
  return toolRuns.contextsByToolRunId.get(event.run_id) ?? undefined
}

function childIdentity(child: SubagentContext): Record<string, unknown> {
  return {
    call_id: child.callId,
    subagent: child.name,
    route_id: child.routeId,
    depth: child.depth,
  }
}

function childData(child: SubagentContext, data: unknown): Record<string, unknown> {
  return {
    ...(isRecord(data) ? data : { value: data }),
    ...childIdentity(child),
  }
}

function parseSubagentPhaseEvent(event: LangChainStreamEvent): SubagentPhaseProjection | undefined {
  if (event.event !== "on_custom_event" || event.name !== "dawn.subagent") return undefined
  if (!isRecord(event.data)) return undefined
  const phase = event.data.phase
  if (phase !== "start" && phase !== "end") return undefined
  if (typeof event.data.call_id !== "string" || event.data.call_id === "") return undefined
  if (typeof event.data.subagent !== "string" || event.data.subagent === "") return undefined
  if (typeof event.data.route_id !== "string" || event.data.route_id === "") return undefined
  if (
    typeof event.data.depth !== "number" ||
    !Number.isInteger(event.data.depth) ||
    event.data.depth < 1
  ) {
    return undefined
  }

  const context: SubagentContext = {
    callId: event.data.call_id,
    depth: event.data.depth,
    name: event.data.subagent,
    routeId: event.data.route_id,
  }
  const toolRunId =
    typeof event.data.tool_run_id === "string" && event.data.tool_run_id !== ""
      ? event.data.tool_run_id
      : undefined
  const { phase: _phase, tool_run_id: _toolRunId, ...data } = event.data
  return {
    chunk: { type: `subagent.${phase}`, data },
    context,
    toolRunId,
  }
}

function classifyStreamEvent(
  event: LangChainStreamEvent,
  toolRuns: SubagentToolRunContexts,
): StreamEventProjection {
  const phase = parseSubagentPhaseEvent(event)
  if (phase) {
    if (phase.toolRunId !== undefined) {
      indexSubagentContext(toolRuns, phase.toolRunId, phase.context)
    }
    return {
      capturesFinalOutput: false,
      child: phase.context,
      chunks: [phase.chunk],
      finalOutput: undefined,
      interrupts: [],
    }
  }
  const child = resolveEventSubagentContext(event, toolRuns)

  switch (event.event) {
    case "on_chat_model_stream": {
      const content = (event.data.chunk as { content?: unknown })?.content
      if (typeof content !== "string" || content.length === 0) break
      return {
        capturesFinalOutput: false,
        child,
        chunks: [
          child
            ? { type: "subagent.message", data: { ...childIdentity(child), chunk: content } }
            : { type: "token", data: content },
        ],
        finalOutput: undefined,
        interrupts: [],
      }
    }
    case "on_tool_start":
      return {
        capturesFinalOutput: false,
        child,
        chunks: [
          child
            ? {
                type: "subagent.tool_call",
                data: {
                  ...childIdentity(child),
                  id: event.run_id,
                  tool: event.name,
                  input: event.data.input ?? event.data.chunk ?? event.data.output,
                },
              }
            : {
                type: "tool_call",
                data: {
                  id: event.run_id,
                  name: event.name,
                  input: event.data.input ?? event.data.chunk ?? event.data.output,
                },
              },
        ],
        finalOutput: undefined,
        interrupts: [],
      }
    case "on_tool_end":
      return {
        capturesFinalOutput: false,
        child,
        chunks: [
          child
            ? {
                type: "subagent.tool_result",
                data: {
                  ...childIdentity(child),
                  id: event.run_id,
                  tool: event.name,
                  output: event.data.output,
                },
              }
            : {
                type: "tool_result",
                data: { id: event.run_id, name: event.name, output: event.data.output },
              },
        ],
        finalOutput: undefined,
        interrupts: [],
      }
    case "on_custom_event": {
      if (event.name !== "dawn.capability") break
      const payload = parseCapabilityEvent(event.data)
      if (!payload) break
      return {
        capturesFinalOutput: false,
        child,
        chunks: [
          child
            ? { type: `subagent.${payload.event}`, data: childData(child, payload.data) }
            : { type: payload.event, data: payload.data },
        ],
        finalOutput: undefined,
        interrupts: [],
      }
    }
    case "on_chain_stream":
      return {
        capturesFinalOutput: false,
        child,
        chunks: [],
        finalOutput: undefined,
        interrupts: extractInterrupts(event.data.chunk) ?? [],
      }
    case "on_tool_error":
      return {
        capturesFinalOutput: false,
        child,
        chunks: [],
        finalOutput: undefined,
        interrupts: extractInterruptsFromError(event.data.error) ?? [],
      }
    case "on_chain_end":
      if (!child && event.name === "LangGraph") {
        return {
          capturesFinalOutput: true,
          child,
          chunks: [],
          finalOutput: event.data.output,
          interrupts: extractInterrupts(event.data.output) ?? [],
        }
      }
      if (child) {
        return {
          capturesFinalOutput: false,
          child,
          chunks: [],
          finalOutput: undefined,
          interrupts: extractInterrupts(event.data.output) ?? [],
        }
      }
      break
  }

  return {
    capturesFinalOutput: false,
    child,
    chunks: [],
    finalOutput: undefined,
    interrupts: [],
  }
}

/**
 * LangGraph 1.x's `interrupt()` throws a `GraphInterrupt` from inside the tool
 * node. Under `streamEvents` v2 this surfaces as an `on_tool_error` whose
 * `event.data.error` is the `GraphInterrupt` instance — its `.name` is
 * `"GraphInterrupt"` and its `.interrupts` array carries the `{ id, value }`
 * entries we need. The top-level `on_chain_end` for `LangGraph` does NOT
 * include `__interrupt__` in this code path (that key appears only on the
 * `invoke`/`stream` return value), so detection must happen at the tool error.
 *
 * We still keep the `__interrupt__` extractor for `on_chain_end` as a
 * defensive fallback in case a future LangGraph version surfaces interrupts
 * via the chain output too.
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

const CHILD_INTERRUPT_KINDS = new Set(["command", "memory", "path", "tool"])

function projectInterruptValue(
  entry: RawInterruptEntry,
  child: SubagentContext | undefined,
): unknown {
  const value = entry.value
  if (!child || !isRecord(value) || Object.hasOwn(value, "callId")) return value
  if (!CHILD_INTERRUPT_KINDS.has(String(value.kind))) return value
  return { ...value, callId: child.callId }
}

/**
 * Detects a thrown `GraphInterrupt` surfaced via `on_tool_error`.
 *
 * LangGraph's `interrupt()` throws a `GraphInterrupt` whose `.message` is
 * `JSON.stringify(interrupts)` and whose `.interrupts` array carries the
 * `{ id, value }` entries. By the time the error reaches `streamEvents`'
 * `data.error` it has already been stringified — typically into
 * `<JSON interrupts>\n\nGraphInterrupt: <JSON interrupts>\n    at ...stack`.
 *
 * We handle three shapes defensively:
 *   - object with `.name === "GraphInterrupt"` and `.interrupts` array
 *     (in case a future LangGraph version surfaces the live error)
 *   - object/Error whose stringified message starts with a JSON array
 *   - bare string with the `GraphInterrupt:` marker
 */
function extractInterruptsFromError(error: unknown): readonly RawInterruptEntry[] | undefined {
  if (!error) return undefined

  if (typeof error === "object") {
    const e = error as { name?: unknown; interrupts?: unknown; message?: unknown }
    if (e.name === "GraphInterrupt" && Array.isArray(e.interrupts) && e.interrupts.length > 0) {
      return e.interrupts as readonly RawInterruptEntry[]
    }
    if (typeof e.message === "string") {
      const parsed = parseInterruptStringMessage(e.message)
      if (parsed) return parsed
    }
  }

  if (typeof error === "string") {
    const parsed = parseInterruptStringMessage(error)
    if (parsed) return parsed
  }

  return undefined
}

/**
 * Parses the stringified form of a GraphInterrupt's message. The string
 * begins with `JSON.stringify(interrupts, null, 2)` and is followed by
 * `\n\nGraphInterrupt: ...\n    at ...` stack metadata. We slice the leading
 * JSON array up to the first `]` followed by a newline + non-JSON sentinel
 * and parse it.
 */
function parseInterruptStringMessage(text: string): readonly RawInterruptEntry[] | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("[")) return undefined
  // Find the matching closing bracket by bracket counting at depth 0 — robust
  // against nested arrays in the interrupt payloads.
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "[") depth++
    else if (ch === "]") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return undefined
  const json = trimmed.slice(0, end + 1)
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    return parsed as readonly RawInterruptEntry[]
  } catch {
    return undefined
  }
}

export interface AgentOptions {
  /**
   * Checkpointer used by LangGraph to park interrupted graph state and replay
   * from it on resume. Required — the CLI runtime supplies a SQLite-backed
   * instance by default. If you call agent-adapter directly (e.g. in tests),
   * pass `new MemorySaver()` from `@langchain/langgraph`.
   */
  readonly checkpointer: BaseCheckpointSaver
  readonly entry: unknown
  /**
   * The agent input. For a normal invocation, this is a record like
   * `{messages: [...]}`. For a resume invocation (after a parked interrupt),
   * pass a `Command({resume: decision})` instance directly — the adapter will
   * forward it verbatim to `streamEvents` instead of wrapping it in messages.
   */
  readonly input: unknown
  readonly middlewareContext?: Readonly<Record<string, unknown>>
  readonly offload?: OffloadFn
  readonly retry?: RetryConfig
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly stateFields?: readonly ResolvedStateField[]
  readonly tools: readonly DawnToolDefinition[]
  readonly promptFragments?: readonly PromptFragment[]
  readonly streamTransformers?: readonly StreamTransformer[]
  /** Resolves guarded task requests to lazily materialized child graphs. */
  readonly subagentResolver?: SubagentResolver
  /**
   * Stable per-conversation identifier used as LangGraph's `thread_id`. When
   * set, the agent-adapter wires it into `config.configurable.thread_id` so
   * the checkpointer can park interrupted state. Required for resume to work
   * — without a thread_id, an interrupt ends the stream with no way to
   * replay.
   */
  readonly threadId?: string
  readonly summarization?: ResolvedSummarizationConfig
  /**
   * Set by the CLI runtime when a per-thread sandbox is active for this turn
   * (the workspace tools close over the thread's sandbox filesystem/exec
   * backend). Forces `bypassCache` in materializeAgent so a cached agent
   * compiled with one thread's sandbox tools is never reused for another
   * thread — the one leak a sandbox must never allow.
   */
  readonly sandboxed?: boolean
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
  if (!options.checkpointer) {
    throw new Error(
      "[dawn] agent-adapter requires a checkpointer in AgentOptions. The CLI runtime instantiates sqliteCheckpointer by default; if you're calling agent-adapter directly, pass one explicitly.",
    )
  }

  // If the caller is passing a Command directly (resume path), forward it
  // verbatim without the usual input preparation and message extraction.
  const isCommandInput = options.input instanceof Command
  const { agentInput, config } = prepareAgentCall(options)
  const messages = isCommandInput ? [] : extractMessages(agentInput)

  const resolver = options.subagentResolver
  const hasTaskTool = options.tools.some((t) => t.name === "task")

  // DawnAgent descriptor path — materialize on first use
  if (isDawnAgent(options.entry)) {
    // Resolver and sandbox-backed tools close over route-preparation state, so
    // they must not be reused from another materialized route invocation.
    const materializedAgent = await materializeAgent(
      options.entry,
      options.tools,
      options.checkpointer,
      {
        ...(options.stateFields ? { stateFields: options.stateFields } : {}),
        ...(options.middlewareContext ? { middlewareContext: options.middlewareContext } : {}),
        ...(options.promptFragments ? { promptFragments: options.promptFragments } : {}),
        ...((resolver && hasTaskTool) || options.sandboxed ? { bypassCache: true } : {}),
        ...(options.offload ? { offload: options.offload } : {}),
        ...(options.summarization ? { summarization: options.summarization } : {}),
        routeParamNames: options.routeParamNames,
        ...(options.streamTransformers ? { streamTransformers: options.streamTransformers } : {}),
        ...(resolver ? { subagentResolver: resolver } : {}),
      },
    )
    const retryConfig = options.entry.retry
    const runnableInput = isCommandInput ? options.input : { messages }
    yield* streamFromRunnable(materializedAgent, runnableInput, config, retryConfig)
    return
  }

  // Legacy path — raw Runnable with .invoke()
  assertAgentLike(options.entry)

  const langchainTools = options.tools.map((tool) =>
    tool.name === "task" && resolver
      ? convertSubagentTaskToLangChain(tool, resolver)
      : convertToolToLangChain(
          tool,
          options.middlewareContext,
          options.offload,
          options.routeParamNames,
          options.streamTransformers ?? [],
        ),
  )
  if (langchainTools.length > 0) {
    config.tools = langchainTools
  }

  const runnableInput = isCommandInput ? options.input : { messages }
  yield* streamFromRunnable(options.entry, runnableInput, config, options.retry)
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
  // Per-agent super-step ceiling. LangGraph's Pregel reads config.recursionLimit
  // (default 25); deep agents (coordinator + subagents + many tool calls) can
  // legitimately need more. Sourced from the DawnAgent descriptor, mirroring retry.
  if (isDawnAgent(options.entry) && typeof options.entry.recursionLimit === "number") {
    config.recursionLimit = options.entry.recursionLimit
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
): AsyncGenerator<AgentStreamChunk> {
  const streamable = runnable as AgentLike & {
    streamEvents?: (
      input: unknown,
      options: Record<string, unknown>,
    ) => AsyncIterable<LangChainStreamEvent>
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

  interface PassResult {
    readonly finalOutput: unknown
    readonly interrupts: readonly RawInterruptEntry[]
  }

  // Process a single streamEvents iterator: yield AgentStreamChunks and
  // return whatever __interrupt__ entries appeared in the graph's final
  // on_chain_end output.
  async function* processEventStream(
    invocationInput: unknown,
    invocationConfig: Record<string, unknown>,
    allowRetryOnError: boolean,
  ): AsyncGenerator<AgentStreamChunk, PassResult, void> {
    let finalOutput: unknown
    let capturedInterrupts: readonly RawInterruptEntry[] = []
    let emittedInterruptIds = new Set<string>()
    let hasYielded = false

    const maxStreamAttempts = allowRetryOnError ? (retryConfig?.maxAttempts ?? 3) : 1

    for (let attempt = 0; attempt < maxStreamAttempts; attempt++) {
      hasYielded = false
      finalOutput = undefined
      capturedInterrupts = []
      emittedInterruptIds = new Set()
      const subagentToolRuns: SubagentToolRunContexts = { contextsByToolRunId: new Map() }

      try {
        for await (const event of streamEventsFn(invocationInput, {
          ...invocationConfig,
          version: "v2",
        })) {
          const projection = classifyStreamEvent(event, subagentToolRuns)
          if (projection.capturesFinalOutput) {
            finalOutput = projection.finalOutput
          }
          for (const chunk of projection.chunks) {
            hasYielded = true
            yield chunk
          }
          if (projection.interrupts.length > 0) {
            capturedInterrupts = projection.interrupts
          }
          for (const entry of projection.interrupts) {
            if (entry.id && emittedInterruptIds.has(entry.id)) continue
            if (entry.id) emittedInterruptIds.add(entry.id)
            hasYielded = true
            if (process.env.DAWN_DEBUG_INTERRUPTS === "1") {
              if (!isRecord(entry.value) || typeof entry.value.interruptId !== "string") {
                console.warn(
                  "[dawn] interrupt entry.value missing interruptId — capability bug:",
                  JSON.stringify(entry).slice(0, 300),
                )
              }
            }
            yield {
              type: "interrupt",
              data: projectInterruptValue(entry, projection.child),
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

  // Invoke the stream. After yielding any interrupt envelopes, return cleanly.
  // Resume is state-based: the caller posts to /threads/:id/resume with the
  // decision, which opens a new SSE stream with Command({resume: decision}) as
  // input. The adapter does NOT park here waiting for an in-process promise.
  const pass = yield* processEventStream(input, config, /* allowRetryOnError */ true)

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
