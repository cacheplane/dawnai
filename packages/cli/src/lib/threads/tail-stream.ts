/**
 * Drives the Agent Protocol attach stream's body to completion, rendering
 * (or, in `json` mode, echoing) each frame and classifying how the stream
 * ended so the caller can map that onto a CLI exit code.
 */
import { parseStateFrame } from "./attach-state.js"
import { createSseFrameParser, type SseFrame } from "./sse-frames.js"
import { renderFrame, renderSnapshot } from "./tail-render.js"

export type AttachOutcome = "done" | "detached" | "truncated"

export interface ConsumeAttachStreamResult {
  readonly outcome: AttachOutcome
  readonly reason?: string
  readonly retryMs?: number
}

export interface ConsumeAttachStreamOptions {
  readonly body: ReadableStream<Uint8Array>
  readonly write: (line: string) => void
  readonly json?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readDetachReason(payload: unknown): string {
  if (isRecord(payload) && typeof payload.reason === "string") return payload.reason
  return "unknown"
}

/** Consume the attach stream's body until it ends, `done`, or `detached`. */
export async function consumeAttachStream(
  options: ConsumeAttachStreamOptions,
): Promise<ConsumeAttachStreamResult> {
  const { body, write, json = false } = options
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseFrameParser()

  let retryMs: number | undefined
  let outcome: AttachOutcome | undefined
  let reason: string | undefined

  const handleFrame = (frame: SseFrame): void => {
    if (frame.retry !== undefined) retryMs = frame.retry

    if (json) {
      write(JSON.stringify(frame))
    } else if (frame.event === "state") {
      for (const line of renderSnapshot(parseStateFrame(frame.data))) write(line)
    } else if (frame.data !== undefined || frame.raw !== undefined) {
      for (const line of renderFrame(frame)) write(line)
    }

    if (frame.event === "detached") {
      outcome = "detached"
      reason = readDetachReason(frame.data)
    } else if (frame.event === "done") {
      outcome = "done"
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const frames = parser.push(decoder.decode(value, { stream: true }))
    for (const frame of frames) handleFrame(frame)
  }

  if (outcome === "detached") {
    return retryMs === undefined
      ? { outcome: "detached", reason: reason ?? "unknown" }
      : { outcome: "detached", reason: reason ?? "unknown", retryMs }
  }
  if (outcome === "done") {
    return retryMs === undefined ? { outcome: "done" } : { outcome: "done", retryMs }
  }
  return retryMs === undefined ? { outcome: "truncated" } : { outcome: "truncated", retryMs }
}
