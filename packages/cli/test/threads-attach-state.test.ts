import { describe, expect, it } from "vitest"
import { parseStateFrame, projectTurnChunk } from "../src/lib/threads/attach-state.js"

describe("parseStateFrame", () => {
  it("reads the durable-path frame", () => {
    const state = parseStateFrame({
      anchor: null,
      input: null,
      interrupts: [{ interruptId: "i1", resumeKey: "r1", value: { q: "ok?" } }],
      live: false,
      resume: false,
      run_started_at: null,
      status: "interrupted",
      turn: null,
      values: { messages: [] },
    })
    expect(state.live).toBe(false)
    expect(state.status).toBe("interrupted")
    expect(state.interrupts).toHaveLength(1)
    expect(state.interrupts[0]?.interruptId).toBe("i1")
    expect(state.turn).toBeNull()
    expect(state.truncated).toBe(false)
  })

  it("reads the live-path frame including truncation", () => {
    const state = parseStateFrame({
      anchor: "cp-1",
      input: { messages: [] },
      interrupts: [],
      live: true,
      resume: true,
      run_started_at: "2020-01-01T00:00:00.000Z",
      status: "busy",
      turn: null,
      turn_truncated: true,
      values: null,
    })
    expect(state.live).toBe(true)
    expect(state.resume).toBe(true)
    expect(state.anchor).toBe("cp-1")
    expect(state.runStartedAt).toBe("2020-01-01T00:00:00.000Z")
    expect(state.truncated).toBe(true)
  })

  it("tolerates a garbage payload instead of throwing", () => {
    const state = parseStateFrame("not an object")
    expect(state.live).toBe(false)
    expect(state.interrupts).toEqual([])
    expect(state.turn).toBeNull()
  })
})

describe("projectTurnChunk", () => {
  it("re-wraps a data-only chunk and passes named-field chunks through", () => {
    // Mirrors the server's toSseEvent split: `chunk` carries its payload
    // unwrapped, `tool_result` carries named fields.
    expect(projectTurnChunk({ type: "chunk", data: "hi" })).toEqual({ event: "chunk", data: "hi" })
    expect(
      projectTurnChunk({ type: "tool_result", id: "c1", name: "ping", output: "pong" }),
    ).toEqual({
      event: "tool_result",
      data: { id: "c1", name: "ping", output: "pong" },
    })
  })
})
