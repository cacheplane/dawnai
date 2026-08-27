import { describe, expect, it } from "vitest"
import { createSseFrameParser } from "../src/lib/threads/sse-frames.js"

describe("createSseFrameParser", () => {
  it("emits a frame per complete block and buffers partial ones", () => {
    const parser = createSseFrameParser()
    expect(parser.push('event: state\ndata: {"live":false}\n\n')).toEqual([
      { event: "state", data: { live: false } },
    ])
    // A block split across two chunks yields nothing until it completes.
    expect(parser.push('event: chunk\ndata: "he')).toEqual([])
    expect(parser.push('llo"\n\n')).toEqual([{ event: "chunk", data: "hello" }])
  })

  it("ignores comment heartbeats and surfaces a bare retry block", () => {
    const parser = createSseFrameParser()
    expect(parser.push(": ping\n\n")).toEqual([])
    expect(parser.push("retry: 2100\n\n")).toEqual([{ event: "message", retry: 2100 }])
  })

  it("folds multi-line data per the SSE spec", () => {
    const parser = createSseFrameParser()
    // Two data: lines join with \n before parsing — the server does not emit this
    // today, but a spec-correct client must not silently drop the first line.
    expect(parser.push('event: note\ndata: "a\ndata: b"\n\n')).toEqual([
      { event: "note", data: "a\nb" },
    ])
  })

  it("reports unparseable data rather than throwing", () => {
    const parser = createSseFrameParser()
    expect(parser.push("event: state\ndata: {not json}\n\n")).toEqual([
      { event: "state", raw: "{not json}", malformed: true },
    ])
  })
})
