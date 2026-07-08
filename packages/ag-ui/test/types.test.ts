import { describe, expect, test } from "vitest"
import { asToolCallData, asToolResultData } from "../src/types.js"

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
