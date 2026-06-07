import { describe, expect, it } from "vitest"
import { defineEval } from "../src/define-eval.js"
import type { Scorer } from "../src/types.js"

const scorer: Scorer = { name: "s", score: () => 1 }

describe("defineEval", () => {
  it("returns the definition unchanged when valid", () => {
    const def = defineEval({ name: "e", dataset: [{ input: "hi" }], scorers: [scorer] })
    expect(def.name).toBe("e")
  })
  it("throws on empty name", () => {
    expect(() => defineEval({ name: "", dataset: [{ input: "x" }], scorers: [scorer] })).toThrow(
      /name/,
    )
  })
  it("throws on no scorers", () => {
    expect(() => defineEval({ name: "e", dataset: [{ input: "x" }], scorers: [] })).toThrow(
      /scorer/,
    )
  })
  it("throws on an empty inline dataset", () => {
    expect(() => defineEval({ name: "e", dataset: [], scorers: [scorer] })).toThrow(/dataset/)
  })
  it("allows a string or function dataset (resolved later)", () => {
    expect(defineEval({ name: "e", dataset: "cases.jsonl", scorers: [scorer] }).dataset).toBe(
      "cases.jsonl",
    )
    expect(typeof defineEval({ name: "e", dataset: () => [{ input: "x" }], scorers: [scorer] }).dataset).toBe(
      "function",
    )
  })
})
