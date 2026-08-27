import { describe, expect, it } from "vitest"
import { parseStateFrame } from "../src/lib/threads/attach-state.js"
import { renderFrame, renderSnapshot } from "../src/lib/threads/tail-render.js"

const base = {
  anchor: null,
  input: null,
  interrupts: [],
  live: false,
  resume: false,
  run_started_at: null,
  status: "idle",
  turn: null,
  values: null,
}

describe("renderSnapshot", () => {
  it("renders committed messages, then applies input when this is not a resume", () => {
    const lines = renderSnapshot(
      parseStateFrame({
        ...base,
        live: true,
        status: "busy",
        anchor: "cp-1",
        run_started_at: "T0",
        input: { messages: [{ role: "user", content: "run it" }] },
        values: {
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hi there" },
          ],
        },
        turn: [
          { type: "chunk", data: "wor" },
          { type: "chunk", data: "king" },
        ],
      }),
    )
    const text = lines.join("\n")
    expect(text).toContain("hi there")
    expect(text).toContain("run it") // applied: resume is false
    expect(text).toContain("working") // turn[] rendered through renderFrame
  })

  it("does NOT apply input to the transcript during a resume turn", () => {
    const lines = renderSnapshot(
      parseStateFrame({
        ...base,
        live: true,
        resume: true,
        status: "busy",
        anchor: "cp-1",
        run_started_at: "T0",
        input: { resume: [{ interruptId: "i1", status: "resolved" }] },
        values: { messages: [{ role: "user", content: "hi" }] },
      }),
    )
    const text = lines.join("\n")
    expect(text).toContain("hi")
    expect(text).not.toContain('"resolved"') // echoed for correlation only, never applied
  })

  it("warns when the digest was truncated", () => {
    const lines = renderSnapshot(
      parseStateFrame({ ...base, live: true, turn: null, turn_truncated: true }),
    )
    expect(lines.join("\n")).toMatch(/truncat/i)
  })

  it("lists parked interrupts on the durable path", () => {
    const lines = renderSnapshot(
      parseStateFrame({
        ...base,
        status: "interrupted",
        interrupts: [{ interruptId: "i1", resumeKey: "r1", value: { tool: "deployProd" } }],
      }),
    )
    expect(lines.join("\n")).toContain("i1")
  })
})

describe("renderFrame", () => {
  it("renders each frame kind", () => {
    expect(renderFrame({ event: "chunk", data: "tok" }).join("")).toContain("tok")
    expect(
      renderFrame({ event: "tool_call", data: { name: "ping", input: {} } }).join(""),
    ).toContain("ping")
    expect(renderFrame({ event: "done", data: { output: null } }).join("")).toMatch(/done/i)
  })
})
