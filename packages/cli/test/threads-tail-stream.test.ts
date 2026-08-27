import { describe, expect, it } from "vitest"
import { consumeAttachStream } from "../src/lib/threads/tail-stream.js"

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(text))
      c.close()
    },
  })
}
const DURABLE =
  'event: state\ndata: {"live":false,"status":"idle","interrupts":[],"turn":null,"values":null}\n\n' +
  'event: done\ndata: {"output":null}\n\n' +
  "retry: 2100\n\n"

describe("consumeAttachStream", () => {
  it("ends cleanly on done and reports the retry hint", async () => {
    const out: string[] = []
    const result = await consumeAttachStream({ body: bodyOf(DURABLE), write: (l) => out.push(l) })
    expect(result.outcome).toBe("done")
    expect(result.retryMs).toBe(2100)
    expect(out.join("\n")).toContain("idle")
  })

  it("reports a stream that ends without done as truncated", async () => {
    const result = await consumeAttachStream({
      body: bodyOf('event: state\ndata: {"live":true,"turn":[]}\n\n'),
      write: () => {},
    })
    expect(result.outcome).toBe("truncated")
  })

  it("reports a detached stream with its reason", async () => {
    const result = await consumeAttachStream({
      body: bodyOf('event: detached\ndata: {"reason":"capacity"}\n\n'),
      write: () => {},
    })
    expect(result.outcome).toBe("detached")
    expect(result.reason).toBe("capacity")
  })

  it("emits raw frames when json mode is on", async () => {
    const out: string[] = []
    await consumeAttachStream({ body: bodyOf(DURABLE), json: true, write: (l) => out.push(l) })
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({ event: "state" })
  })
})
