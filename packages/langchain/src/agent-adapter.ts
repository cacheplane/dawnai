import type { DawnAgent } from "@dawn-ai/sdk"
import { isDawnAgent } from "@dawn-ai/sdk"
import { HumanMessage } from "@langchain/core/messages"
import { materializeStateSchema, type ResolvedStateField } from "./state-adapter.js"
import { convertToolToLangChain } from "./tool-converter.js"

interface DawnToolDefinition {
  readonly description?: string
  readonly name: string
  readonly run: (
    input: unknown,
    context: { readonly signal: AbortSignal },
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

const materializedAgents = new WeakMap<DawnAgent, AgentLike>()

async function materializeAgent(
  descriptor: DawnAgent,
  tools: readonly DawnToolDefinition[],
  stateFields?: readonly ResolvedStateField[],
): Promise<AgentLike> {
  const cached = materializedAgents.get(descriptor)
  if (cached) {
    return cached
  }

  const { createReactAgent } = await import("@langchain/langgraph/prebuilt")
  const { ChatOpenAI } = await import("@langchain/openai")

  const langchainTools = tools.map((tool) => convertToolToLangChain(tool))

  const llm = new ChatOpenAI({
    model: descriptor.model,
  })

  const agentOptions: Record<string, unknown> = {
    llm,
    tools: langchainTools,
    prompt: descriptor.systemPrompt,
  }

  if (stateFields && stateFields.length > 0) {
    agentOptions.stateSchema = materializeStateSchema(stateFields)
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamically-built options don't satisfy strict StateDefinition type
  const compiled = createReactAgent(agentOptions as any)

  materializedAgents.set(descriptor, compiled as unknown as AgentLike)
  return compiled as unknown as AgentLike
}

export async function executeAgent(options: {
  readonly entry: unknown
  readonly input: unknown
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly stateFields?: readonly ResolvedStateField[]
  readonly tools: readonly DawnToolDefinition[]
}): Promise<unknown> {
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

  const messages = extractMessages(agentInput)

  // DawnAgent descriptor path — materialize on first use
  if (isDawnAgent(options.entry)) {
    const materializedAgent = await materializeAgent(
      options.entry,
      options.tools,
      options.stateFields,
    )
    return await materializedAgent.invoke({ messages }, config)
  }

  // Legacy path — raw Runnable with .invoke()
  assertAgentLike(options.entry)

  const langchainTools = options.tools.map((tool) => convertToolToLangChain(tool))
  if (langchainTools.length > 0) {
    config.tools = langchainTools
  }

  return await options.entry.invoke({ messages }, config)
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
