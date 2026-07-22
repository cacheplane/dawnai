import { describe, expect, test } from "vitest"
import { asToolCallData, asToolResultData, type DawnAgentStreamChunk } from "../src/types.js"

describe("DawnAgentStreamChunk", () => {
  test("accepts canonical chunks and open extension chunks", () => {
    const chunks = [
      { type: "token", data: "hello" },
      { type: "tool_call", data: { name: "greet", input: { name: "Dawn" } } },
      { type: "tool_result", data: { name: "greet", output: "hello" } },
      { type: "interrupt", data: { interruptId: "perm-1" } },
      { type: "done" },
      { type: "plan_update", data: { steps: [] } },
    ] satisfies DawnAgentStreamChunk[]

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "token",
      "tool_call",
      "tool_result",
      "interrupt",
      "done",
      "plan_update",
    ])
  })
})

describe("asToolCallData", () => {
  test("extracts id/name/input when shape is valid", () => {
    expect(asToolCallData({ id: "run-1", name: "greet", input: { x: 1 } })).toEqual({
      id: "run-1",
      name: "greet",
      input: { x: 1 },
    })
  })

  test("returns undefined id when absent", () => {
    expect(asToolCallData({ name: "greet", input: {} })).toEqual({
      id: undefined,
      name: "greet",
      input: {},
    })
  })

  test("returns null when name missing or data not an object", () => {
    expect(asToolCallData({ input: {} })).toBeNull()
    expect(asToolCallData("nope")).toBeNull()
    expect(asToolCallData(null)).toBeNull()
  })
})

describe("asToolResultData", () => {
  test("extracts id/name/output", () => {
    expect(asToolResultData({ id: "run-1", name: "greet", output: "hi" })).toEqual({
      id: "run-1",
      name: "greet",
      output: "hi",
    })
  })

  test("returns undefined id when absent", () => {
    expect(asToolResultData({ name: "greet", output: "hi" })).toEqual({
      id: undefined,
      name: "greet",
      output: "hi",
    })
  })

  test("returns null when name missing", () => {
    expect(asToolResultData({ output: "hi" })).toBeNull()
  })

  test("returns null when data not an object", () => {
    expect(asToolResultData("nope")).toBeNull()
    expect(asToolResultData(null)).toBeNull()
  })
})
