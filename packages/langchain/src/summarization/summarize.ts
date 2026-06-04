import type { BaseMessage } from "@langchain/core/messages"
import { createChatModel } from "../chat-model-factory.js"
import { resolveProvider } from "../model-provider-resolver.js"

function renderMessages(messages: readonly BaseMessage[]): string {
  return messages
    .map((m) => {
      const getType = (m as { getType?: () => string }).getType
      const role = typeof getType === "function" ? getType.call(m) : "message"
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      const toolCalls = (m as { tool_calls?: unknown[] }).tool_calls
      const tc =
        toolCalls && toolCalls.length > 0 ? `\n[tool_calls: ${JSON.stringify(toolCalls)}]` : ""
      return `${role}: ${content}${tc}`
    })
    .join("\n")
}

function buildPrompt(messages: readonly BaseMessage[], previousSummary?: string): string {
  const prior = previousSummary ? `Existing running summary so far:\n${previousSummary}\n\n` : ""
  return (
    `${prior}New conversation messages to fold into the summary:\n${renderMessages(messages)}\n\n` +
    `Write an updated, concise running summary of the ENTIRE conversation so far. ` +
    `Preserve concrete facts, decisions, user goals, tool results, identifiers, and open questions. ` +
    `Do not invent information. Output only the summary text.`
  )
}

export async function defaultSummarize(args: {
  readonly messages: readonly BaseMessage[]
  readonly model: string
  readonly previousSummary?: string
  readonly signal: AbortSignal
  /** Test seam: override the model invocation. */
  readonly invokeModel?: (prompt: string) => Promise<string>
}): Promise<string> {
  const prompt = buildPrompt(args.messages, args.previousSummary)
  if (args.invokeModel) return args.invokeModel(prompt)

  const provider = resolveProvider({ model: args.model })
  const llm = (await createChatModel({ model: args.model, provider })) as {
    invoke: (input: unknown, options?: unknown) => Promise<{ content: unknown }>
  }
  const res = await llm.invoke([{ role: "user", content: prompt }], { signal: args.signal })
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content)
}
