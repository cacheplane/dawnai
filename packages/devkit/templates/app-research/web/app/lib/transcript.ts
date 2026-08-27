/**
 * Turning `agent.messages` into the list the transcript renders.
 *
 * This is deliberately a pure module with no React and no CopilotKit import:
 * the pairing rules below (an assistant message can carry text AND tool calls,
 * a tool result lives in a *separate* message that has to be matched back by
 * `toolCallId`) are the only real logic in the transcript, and a hook-free
 * function is the only way to test them without a live agent.
 *
 * The message shapes are declared structurally rather than imported from
 * `@ag-ui/core`. Two copies of that package are installed — the app depends on
 * `@ag-ui/client@0.0.57`, `@copilotkit/react-core` on its own — and the union
 * below is a supertype of the real one, so `agent.messages` assigns to it
 * whichever copy the hook's types come from. Verified against
 * `MessageSchema` in `@ag-ui/core`: the seven roles are user, assistant, tool,
 * activity, reasoning, system and developer.
 */

/** As published in `ToolCallSchema` — args arrive as a JSON *string*. */
export interface TranscriptToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

/** A tool result. Structurally the `ToolMessage` `useRenderToolCall` wants. */
export interface ToolResultMessage {
  readonly id: string
  readonly role: "tool"
  readonly content: string
  readonly toolCallId: string
}

export type TranscriptMessage =
  /**
   * `content` is `string | Array<{type:"text",text} | {type:"image",…}>`, and
   * the array form only appears with attachments (which this app does not
   * enable). Typed `unknown` so the union stays a supertype of both installed
   * copies; `userText` below does the narrowing.
   */
  | { readonly id: string; readonly role: "user"; readonly content: unknown }
  | {
      readonly id: string
      readonly role: "assistant"
      readonly content?: string | undefined
      readonly toolCalls?: readonly TranscriptToolCall[] | undefined
    }
  | ToolResultMessage
  | {
      readonly id: string
      readonly role: "activity"
      readonly activityType: string
      readonly content: Record<string, unknown>
    }
  | {
      readonly id: string
      readonly role: "reasoning" | "system" | "developer"
      readonly content: string
    }

export type TranscriptItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string }
  | {
      readonly kind: "activity"
      readonly id: string
      readonly activityType: string
      readonly content: Record<string, unknown>
    }
  | {
      readonly kind: "toolCall"
      readonly id: string
      readonly toolCall: TranscriptToolCall
      readonly toolResult?: ToolResultMessage
    }

/**
 * A user message's displayable text. Multimodal content is an array of parts;
 * everything that is not a `text` part (an image, say) has no text to show, so
 * it contributes nothing rather than `[object Object]`.
 */
export function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return ""
      const candidate = part as { type?: unknown; text?: unknown }
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
    })
    .join("")
}

/**
 * Flattens the message list into render-order items.
 *
 * - An assistant message yields its text (when non-empty) and then one item per
 *   tool call, in the order the model emitted them.
 * - A `role:"tool"` message is NOT an item of its own: it is folded into the
 *   tool-call item it answers, because that is the pairing
 *   `useRenderToolCall({ toolCall, toolMessage })` expects. Tool results are
 *   indexed up-front, so a result that arrives before its call (it shouldn't,
 *   but the transport does not guarantee it) still pairs.
 * - System and developer messages are dropped: they are prompt plumbing, and
 *   showing them in a transcript would leak instructions into the UI.
 */
export function buildTranscriptItems(
  messages: readonly TranscriptMessage[],
): readonly TranscriptItem[] {
  const resultsByToolCallId = new Map<string, ToolResultMessage>()
  for (const message of messages) {
    if (message.role === "tool") resultsByToolCallId.set(message.toolCallId, message)
  }

  const items: TranscriptItem[] = []
  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const text = userText(message.content)
        if (text.length > 0) items.push({ kind: "user", id: message.id, text })
        break
      }
      case "assistant": {
        const text = message.content ?? ""
        if (text.length > 0) items.push({ kind: "assistant", id: message.id, text })
        for (const toolCall of message.toolCalls ?? []) {
          const toolResult = resultsByToolCallId.get(toolCall.id)
          items.push({
            kind: "toolCall",
            id: toolCall.id,
            toolCall,
            ...(toolResult ? { toolResult } : {}),
          })
        }
        break
      }
      case "activity":
        items.push({
          kind: "activity",
          id: message.id,
          activityType: message.activityType,
          content: message.content,
        })
        break
      case "reasoning": {
        if (message.content.length > 0) {
          items.push({ kind: "reasoning", id: message.id, text: message.content })
        }
        break
      }
      default:
        break
    }
  }
  return items
}
