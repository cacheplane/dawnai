import { describe, expect, it } from "vitest"
import { normalizeScore } from "../src/score.js"

describe("normalizeScore", () => {
  it("maps booleans to 1/0", () => {
    expect(normalizeScore(true)).toEqual({ score: 1 })
    expect(normalizeScore(false)).toEqual({ score: 0 })
  })
  it("clamps numbers to [0,1]", () => {
    expect(normalizeScore(0.5)).toEqual({ score: 0.5 })
    expect(normalizeScore(2)).toEqual({ score: 1 })
    expect(normalizeScore(-1)).toEqual({ score: 0 })
  })
  it("passes through rich verdicts, clamping score and keeping label/reason", () => {
    expect(normalizeScore({ score: 1.4, label: "good", reason: "why" })).toEqual({
      score: 1,
      label: "good",
      reason: "why",
    })
  })
  it("treats NaN as 0", () => {
    expect(normalizeScore(Number.NaN)).toEqual({ score: 0 })
  })
})
