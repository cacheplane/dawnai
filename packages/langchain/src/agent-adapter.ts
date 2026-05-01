import { HumanMessage } from "@langchain/core/messages"
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

export async function executeAgent(options: {
  readonly entry: unknown
  readonly input: unknown
  readonly routeParamNames: readonly string[]
  readonly signal: AbortSignal
  readonly tools: readonly DawnToolDefinition[]
}): Promise<unknown> {
  assertAgentLike(options.entry)

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

  const langchainTools = options.tools.map((tool) => convertToolToLangChain(tool))

  const config: Record<string, unknown> = {
    signal: options.signal,
  }

  if (Object.keys(params).length > 0) {
    config.configurable = params
  }

  if (langchainTools.length > 0) {
    config.tools = langchainTools
  }

  const messages = [new HumanMessage(formatAgentMessage(agentInput))]

  return await options.entry.invoke({ messages }, config)
}

function formatAgentMessage(input: Record<string, unknown>): string {
  const entries = Object.entries(input)

  if (entries.length === 0) {
    return ""
  }

  if (entries.length === 1) {
    return String(entries[0]![1])
  }

  return entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n")
}
