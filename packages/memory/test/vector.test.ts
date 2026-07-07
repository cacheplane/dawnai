import { describe, expect, it } from "vitest"
import { cosineSimilarity, DEFAULT_RRF_K, fuseRRF } from "../src/vector.js"

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, ~0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1, 10)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 10)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(
      -1,
      10,
    )
  })
  it("returns 0 when either vector has zero norm (no NaN)", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })
  it("returns 0 on length mismatch rather than throwing", () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2]))).toBe(0)
  })
})

describe("fuseRRF", () => {
  it("co-equal fusion: an item ranked high in BOTH lists beats items in one", () => {
    const scores = fuseRRF([{ ids: ["a", "b", "c"] }, { ids: ["b", "a", "d"] }])
    // b: 1/(60+2)+1/(60+1); a: 1/(60+1)+1/(60+2) — equal; both beat c and d (one list only)
    expect(scores.get("a")).toBeCloseTo(scores.get("b")!, 12)
    expect(scores.get("a")!).toBeGreaterThan(scores.get("c")!)
    expect(scores.get("d")!).toBeGreaterThan(0)
    expect(scores.get("c")! < scores.get("a")!).toBe(true)
  })
  it("an item present in only one list still gets a positive score", () => {
    const scores = fuseRRF([{ ids: ["x"] }, { ids: ["y"] }])
    expect(scores.get("x")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
    expect(scores.get("y")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
  })
  it("per-list weights bias the fusion", () => {
    const scores = fuseRRF([
      { ids: ["a", "b"], weight: 2 },
      { ids: ["b", "a"], weight: 1 },
    ])
    // a: 2/(61)+1/(62); b: 2/(62)+1/(61) — a should edge b due to weight on list 1's top
    expect(scores.get("a")! > scores.get("b")!).toBe(true)
  })
  it("smaller k separates top ranks more (larger score gap)", () => {
    const gapSmallK = fuseRRF([{ ids: ["a", "b"] }], { k: 1 })
    expect(gapSmallK.get("a")! - gapSmallK.get("b")!).toBeGreaterThan(
      fuseRRF([{ ids: ["a", "b"] }], { k: 1000 }).get("a")! -
        fuseRRF([{ ids: ["a", "b"] }], { k: 1000 }).get("b")!,
    )
  })
  it("non-positive/non-finite k falls back to the default", () => {
    expect(fuseRRF([{ ids: ["a"] }], { k: 0 }).get("a")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
    expect(fuseRRF([{ ids: ["a"] }], { k: -5 }).get("a")).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
  })
})
