import type { BaseMessage } from "@langchain/core/messages"

let encodeFn: ((text: string) => number[]) | undefined

/**
 * Default token counter. Lazily imports a single gpt-tokenizer encoding
 * (o200k_base — current OpenAI models) so apps that don't enable summarization
 * never load the large encoding tables. Async because of the lazy import.
 */
export async function defaultTokenCounter(text: string): Promise<number> {
  if (!encodeFn) {
    const mod = (await import("gpt-tokenizer/encoding/o200k_base")) as {
      encode: (t: string) => number[]
    }
    encodeFn = mod.encode
  }
  return encodeFn(text).length
}

function messageToText(m: BaseMessage): string {
  const parts: string[] = []
  parts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content))
  const toolCalls = (m as { tool_calls?: unknown }).tool_calls
  if (toolCalls) parts.push(JSON.stringify(toolCalls))
  return parts.join("\n")
}

/** Sum a (possibly async) token counter across a message list. */
export async function countMessagesTokens(
  messages: readonly BaseMessage[],
  counter: (text: string) => number | Promise<number>,
): Promise<number> {
  let total = 0
  for (const m of messages) {
    total += await counter(messageToText(m))
  }
  return total
}
