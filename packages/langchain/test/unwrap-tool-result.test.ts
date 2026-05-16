import { describe, expect, it } from "vitest"
import { unwrapToolResult } from "../src/unwrap-tool-result.js"

describe("unwrapToolResult", () => {
  it("treats a string as plain — content is JSON-stringified", () => {
    expect(unwrapToolResult("hello")).toEqual({
      content: JSON.stringify("hello"),
      stateUpdates: undefined,
    })
  })

  it("treats a number as plain", () => {
    expect(unwrapToolResult(42)).toEqual({
      content: JSON.stringify(42),
      stateUpdates: undefined,
    })
  })

  it("treats null as plain", () => {
    expect(unwrapToolResult(null)).toEqual({
      content: JSON.stringify(null),
      stateUpdates: undefined,
    })
  })

  it("treats a plain object as plain (no `result` key)", () => {
    expect(unwrapToolResult({ a: 1, b: 2 })).toEqual({
      content: JSON.stringify({ a: 1, b: 2 }),
      stateUpdates: undefined,
    })
  })

  it("treats an array as plain", () => {
    expect(unwrapToolResult([1, 2, 3])).toEqual({
      content: JSON.stringify([1, 2, 3]),
      stateUpdates: undefined,
    })
  })

  it("unwraps { result } — object result is JSON-stringified, no state", () => {
    expect(unwrapToolResult({ result: { todos: [] } })).toEqual({
      content: JSON.stringify({ todos: [] }),
      stateUpdates: undefined,
    })
  })

  it("unwraps { result } where result is a string — content is verbatim", () => {
    expect(unwrapToolResult({ result: "done" })).toEqual({
      content: "done",
      stateUpdates: undefined,
    })
  })

  it("unwraps { result, state } — object result JSON-stringified, state passed through", () => {
    const value = {
      result: { todos: [{ content: "x", status: "pending" }] },
      state: { todos: [{ content: "x", status: "pending" }] },
    }
    expect(unwrapToolResult(value)).toEqual({
      content: JSON.stringify({ todos: [{ content: "x", status: "pending" }] }),
      stateUpdates: { todos: [{ content: "x", status: "pending" }] },
    })
  })

  it("unwraps { result, state } with string result — content is verbatim", () => {
    const value = { result: "ok", state: { foo: 1 } }
    expect(unwrapToolResult(value)).toEqual({
      content: "ok",
      stateUpdates: { foo: 1 },
    })
  })

  it("treats { result, state, extra } as plain (extra keys = not the wrapper shape)", () => {
    const value = { result: "x", state: { foo: 1 }, extra: "ignored" }
    expect(unwrapToolResult(value)).toEqual({
      content: JSON.stringify(value),
      stateUpdates: undefined,
    })
  })

  it("treats { state } (no result) as plain", () => {
    expect(unwrapToolResult({ state: { foo: 1 } })).toEqual({
      content: JSON.stringify({ state: { foo: 1 } }),
      stateUpdates: undefined,
    })
  })

  it("treats { result: undefined } as plain-ish (defined wrapper shape but undefined content)", () => {
    const value: unknown = { result: undefined }
    const out = unwrapToolResult(value)
    expect(out).toEqual({
      content: JSON.stringify({ result: undefined }),
      stateUpdates: undefined,
    })
  })

  it("treats { result, state: undefined } as wrapper with no state", () => {
    const value = { result: "ok", state: undefined }
    expect(unwrapToolResult(value)).toEqual({
      content: "ok",
      stateUpdates: undefined,
    })
  })
})
