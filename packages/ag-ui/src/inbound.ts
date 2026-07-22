import type { Message, RunAgentInput } from "@ag-ui/core"
import { type DawnResumeRequest, fromAguiResume } from "./interrupts.js"

export interface DawnMessage {
  readonly role: "user" | "assistant" | "system" | "developer" | "tool"
  readonly content: string
  readonly id?: string
  readonly toolCallId?: string
}

export interface DawnRunInput {
  readonly messages: DawnMessage[]
  readonly resume?: DawnResumeRequest[]
  /** The untouched AG-UI input, so a consumer can reach tools/state/context. */
  readonly raw: RunAgentInput
}

type AguiToolMessage = Extract<Message, { role: "tool" }>

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  try {
    const json = JSON.stringify(content)
    return typeof json === "string" ? json : String(content)
  } catch {
    return String(content)
  }
}

function toDawnToolMessage(message: AguiToolMessage, content: string): DawnMessage {
  return {
    role: "tool",
    content,
    id: message.id,
    toolCallId: message.toolCallId,
  }
}

function toDawnMessage(message: Message): DawnMessage {
  const content = coerceContent(message.content)
  switch (message.role) {
    case "tool":
      return toDawnToolMessage(message, content)
    case "user":
    case "assistant":
    case "system":
    case "developer":
      return { role: message.role, content, id: message.id }
    case "activity":
    case "reasoning":
      return { role: "assistant", content, id: message.id }
  }
}

/**
 * Map an AG-UI `RunAgentInput` to a Dawn run input. Messages are translated
 * structurally; a `resume` array becomes vocabulary-agnostic Dawn resume
 * requests (see `fromAguiResume`). `tools`/`state`/`context` are not
 * interpreted in v1 - reach them via `raw`.
 */
export function fromRunAgentInput(input: RunAgentInput): DawnRunInput {
  const messages = input.messages.map(toDawnMessage)
  const resume = input.resume && input.resume.length > 0 ? fromAguiResume(input.resume) : undefined
  return { messages, ...(resume ? { resume } : {}), raw: input }
}
