/**
 * Incremental Server-Sent Events parser for the Agent Protocol attach stream.
 *
 * Deliberately structural: it knows the SSE framing and nothing about Dawn's
 * frame vocabulary, so `dawn threads tail` consumes the documented wire the way
 * any third-party client would rather than importing the server's own types.
 */
export interface SseFrame {
  /** The `event:` name, or SSE's default `"message"` when the block omits one. */
  readonly event: string
  /** Parsed `data:` payload. Absent on a bare `retry:` block. */
  readonly data?: unknown
  /** Present on a block carrying `retry:`. */
  readonly retry?: number
  /** The raw data text, present only when it could not be parsed as JSON. */
  readonly raw?: string
  readonly malformed?: boolean
}

export interface SseFrameParser {
  /** Feed decoded text; returns every frame completed by this chunk. */
  push(text: string): SseFrame[]
}

export function createSseFrameParser(): SseFrameParser {
  let buffer = ""
  return {
    push(text) {
      buffer += text
      const frames: SseFrame[] = []
      for (;;) {
        const end = buffer.indexOf("\n\n")
        if (end === -1) return frames
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)

        let event: string | undefined
        let retry: number | undefined
        const dataLines: string[] = []
        for (const line of block.split("\n")) {
          // A leading colon is a comment — this is how the server's keepalive
          // (`: ping`) arrives. Never a frame.
          if (line.startsWith(":")) continue
          if (line.startsWith("event:")) event = line.slice("event:".length).trimStart()
          else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart())
          else if (line.startsWith("retry:")) {
            const value = Number(line.slice("retry:".length).trim())
            if (Number.isFinite(value)) retry = value
          }
          // `id:` and unknown fields are ignored: this wire carries no ids, and
          // reconnect is a fresh snapshot rather than a cursor resume.
        }
        if (dataLines.length === 0 && retry === undefined) continue

        const name = event ?? "message"
        if (dataLines.length === 0) {
          frames.push(retry === undefined ? { event: name } : { event: name, retry })
          continue
        }
        // Multi-line data folds per the SSE spec: each `data:` line becomes
        // part of one logical text field. A literal newline joiner would
        // produce invalid JSON (raw control characters are illegal inside a
        // JSON string literal), so the fold uses the JSON escape sequence —
        // JSON.parse then unescapes it back to a real newline in the value.
        const raw = dataLines.join("\\n")
        try {
          const parsed: unknown = JSON.parse(raw)
          frames.push(
            retry === undefined
              ? { event: name, data: parsed }
              : { event: name, data: parsed, retry },
          )
        } catch {
          frames.push({ event: name, malformed: true, raw })
        }
      }
    },
  }
}
