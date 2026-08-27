/**
 * Plain-text line rendering for the Agent Protocol attach stream.
 *
 * `renderSnapshot` renders a durable/live `state` frame's transcript
 * (`values.messages`, then `input` when applicable, then `turn[]`), and
 * `renderFrame` renders one live-tail frame. `renderSnapshot` feeds every
 * `turn[]` entry through `renderFrame` after projecting it with
 * `projectTurnChunk` — the same function the live tail uses — so a snapshot
 * followed by the live tail concatenates cleanly by construction.
 */
import { type AttachState, projectTurnChunk } from "./attach-state.js"

/** The minimal shape `renderFrame` needs — an SSE frame's event and payload. */
export interface RenderableFrame {
  readonly event: string
  readonly data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function renderMessages(value: unknown, lines: string[]): void {
  if (!isRecord(value)) return
  const messages = Object.hasOwn(value, "messages") ? value.messages : undefined
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = typeof message.role === "string" ? message.role : "message"
    const content = Object.hasOwn(message, "content") ? message.content : undefined
    lines.push(`${role}: ${stringifyContent(content)}`)
  }
}

/** Render one live-tail (or projected turn[]) frame as plain-text lines. */
export function renderFrame(frame: RenderableFrame): string[] {
  switch (frame.event) {
    case "chunk": {
      const text = typeof frame.data === "string" ? frame.data : stringifyContent(frame.data)
      return [text]
    }
    case "tool_call": {
      const data = isRecord(frame.data) ? frame.data : {}
      const name = typeof data.name === "string" ? data.name : "unknown"
      return [`[tool_call] ${name} ${stringifyContent(data.input)}`]
    }
    case "tool_result": {
      const data = isRecord(frame.data) ? frame.data : {}
      const name = typeof data.name === "string" ? data.name : "unknown"
      return [`[tool_result] ${name} ${stringifyContent(data.output)}`]
    }
    case "done":
      return [`[done] ${stringifyContent(frame.data)}`]
    default:
      return [`[${frame.event}] ${stringifyContent(frame.data)}`]
  }
}

/** Render a full `state` frame snapshot: transcript, then turn[], then warnings. */
export function renderSnapshot(state: AttachState): string[] {
  const lines: string[] = []
  lines.push(
    `-- status: ${state.status} live: ${state.live} run_started_at: ${state.runStartedAt ?? "-"} anchor: ${
      state.anchor ?? "-"
    } --`,
  )

  renderMessages(state.values, lines)

  // Apply `input` as a user message only when this is not a resume turn. During
  // a resume, `input` is the resume payload — echoed for correlation below via
  // `turn`/interrupts, never applied to the transcript.
  if (!state.resume && isRecord(state.input)) {
    const content = Object.hasOwn(state.input, "content") ? state.input.content : undefined
    if (content !== undefined) {
      lines.push(`user: ${stringifyContent(content)}`)
    } else {
      renderMessages(state.input, lines)
    }
  }

  if (state.turn) {
    // Adjacent `chunk` frames are streamed tokens meant to read as one line of
    // text; merge their rendered output onto the previous line rather than
    // starting a new line per token, the way the live tail would read.
    let lastWasChunk = false
    for (const chunk of state.turn) {
      const projected = projectTurnChunk(chunk)
      const rendered = renderFrame(projected)
      if (projected.event === "chunk") {
        for (const text of rendered) {
          if (lastWasChunk && lines.length > 0) lines[lines.length - 1] += text
          else lines.push(text)
        }
        lastWasChunk = true
      } else {
        lines.push(...rendered)
        lastWasChunk = false
      }
    }
  }

  if (state.truncated) {
    lines.push("[warning] the in-flight turn's history was truncated; live tail continues")
  }

  for (const interrupt of state.interrupts) {
    lines.push(`[interrupt] ${interrupt.interruptId} ${stringifyContent(interrupt.value)}`)
  }

  return lines
}
