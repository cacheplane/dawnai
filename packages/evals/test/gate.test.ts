import { describe, expect, it } from "vitest"
import { gate, resolveGate } from "../src/gate.js"
import type { ScoredReport } from "../src/types.js"

const report: ScoredReport = {
  name: "e",
  mean: 0.75,
  cases: [
    { name: "a", mean: 1, passed: true, scores: [] },
    { name: "b", mean: 0.5, passed: false, scores: [] },
  ],
  byScorer: [
    { scorer: "x", mean: 1, threshold: 1 },
    { scorer: "y", mean: 0.5, threshold: 0.8 },
  ],
}

describe("gate policies", () => {
  it("mean(n) checks the overall mean", () => {
    expect(gate.mean(0.7)(report).passed).toBe(true)
    expect(gate.mean(0.8)(report).passed).toBe(false)
  })
  it("passRate(n) checks the fraction of passing cases", () => {
    expect(gate.passRate(0.5)(report).passed).toBe(true)
    expect(gate.passRate(0.6)(report).passed).toBe(false)
  })
  it("everyCase(n) requires all case means ≥ n", () => {
    expect(gate.everyCase(0.5)(report).passed).toBe(true)
    expect(gate.everyCase(0.6)(report).passed).toBe(false)
  })
  it("perScorer() requires each scorer with a threshold to meet it", () => {
    expect(gate.perScorer()(report).passed).toBe(false) // y: 0.5 < 0.8
  })
  it("all() requires every policy; any() requires one", () => {
    expect(gate.all(gate.mean(0.7), gate.everyCase(0.5))(report).passed).toBe(true)
    expect(gate.all(gate.mean(0.7), gate.everyCase(0.6))(report).passed).toBe(false)
    expect(gate.any(gate.mean(0.9), gate.everyCase(0.5))(report).passed).toBe(true)
  })
  it("resolveGate prefers gate, then threshold sugar, then informational", () => {
    expect(resolveGate({ name: "e", dataset: [], scorers: [], gate: gate.mean(0.9) })(report).passed).toBe(false)
    expect(resolveGate({ name: "e", dataset: [], scorers: [], threshold: 0.7 })(report).passed).toBe(true)
    expect(resolveGate({ name: "e", dataset: [], scorers: [] })(report).passed).toBe(true) // informational
  })
})
