import { describe, expect, it } from "vitest"
import {
  type StreamChunk,
  toNdjsonLine,
  toSseEvent,
} from "../src/lib/runtime/stream-types.js"

describe("toSseEvent", () => {
  it("emits a tool_call event with name + input as the payload", () => {
    const chunk: StreamChunk = {
      type: "tool_call",
      name: "listDir",
      input: { path: "." },
    }
    expect(toSseEvent(chunk)).toBe(
      `event: tool_call\ndata: ${JSON.stringify({ name: "listDir", input: { path: "." } })}\n\n`,
    )
  })

  it("emits a tool_result event with name + output as the payload", () => {
    const chunk: StreamChunk = {
      type: "tool_result",
      name: "readFile",
      output: "hi",
    }
    expect(toSseEvent(chunk)).toBe(
      `event: tool_result\ndata: ${JSON.stringify({ name: "readFile", output: "hi" })}\n\n`,
    )
  })

  it("emits a done event with output as the payload", () => {
    const chunk: StreamChunk = { type: "done", output: { final: true } }
    expect(toSseEvent(chunk)).toBe(
      `event: done\ndata: ${JSON.stringify({ output: { final: true } })}\n\n`,
    )
  })

  it("emits a chunk event with the chunk data directly (not double-wrapped)", () => {
    const chunk: StreamChunk = { type: "chunk", data: "hello" }
    expect(toSseEvent(chunk)).toBe(`event: chunk\ndata: ${JSON.stringify("hello")}\n\n`)
  })

  it("emits a capability-contributed event with its data directly (not double-wrapped)", () => {
    const chunk: StreamChunk = {
      type: "plan_update",
      data: { todos: [{ content: "x", status: "pending" }] },
    }
    expect(toSseEvent(chunk)).toBe(
      `event: plan_update\ndata: ${JSON.stringify({ todos: [{ content: "x", status: "pending" }] })}\n\n`,
    )
  })

  it("emits an object data payload directly when the only non-type field is `data`", () => {
    const chunk: StreamChunk = { type: "custom_event", data: { a: 1, b: 2 } }
    expect(toSseEvent(chunk)).toBe(
      `event: custom_event\ndata: ${JSON.stringify({ a: 1, b: 2 })}\n\n`,
    )
  })

  it("handles primitive data values (string, number, boolean, null)", () => {
    expect(toSseEvent({ type: "chunk", data: 42 })).toBe(`event: chunk\ndata: 42\n\n`)
    expect(toSseEvent({ type: "chunk", data: true })).toBe(`event: chunk\ndata: true\n\n`)
    expect(toSseEvent({ type: "chunk", data: null })).toBe(`event: chunk\ndata: null\n\n`)
  })
})

describe("toNdjsonLine", () => {
  it("preserves the full chunk shape including type (unchanged behavior)", () => {
    const chunk: StreamChunk = {
      type: "plan_update",
      data: { todos: [] },
    }
    expect(toNdjsonLine(chunk)).toBe(JSON.stringify(chunk))
  })
})
