import { describe, expect, it } from "vitest"
import {
  DEFAULT_CANDIDATE_POOL,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  idf,
  scoreMemory,
} from "../src/score.js"

const NOW = "2026-07-05T00:00:00.000Z"
const DAY = 24 * 60 * 60 * 1000
function ago(ms: number): string {
  return new Date(Date.parse(NOW) - ms).toISOString()
}

describe("idf", () => {
  it("is monotonically decreasing in df and always positive", () => {
    const n = 10
    const values = [0, 1, 5, 10].map((df) => idf(df, n))
    expect(values[0]).toBeGreaterThan(values[1]!)
    expect(values[1]).toBeGreaterThan(values[2]!)
    expect(values[2]).toBeGreaterThan(values[3]!)
    for (const v of values) expect(v).toBeGreaterThan(0) // smoothed: df=N still > 0
  })
  it("clamps df above corpusSize instead of going negative", () => {
    expect(idf(12, 10)).toBeGreaterThan(0)
  })
})

describe("scoreMemory", () => {
  const base = {
    corpusSize: 6,
    updatedAt: NOW,
    confidence: 1,
    referenceNow: NOW,
  }
  it("rare-token match outranks common-token match (IDF dominance)", () => {
    const df = new Map([
      ["acme", 6], // in every memory — uninformative
      ["threshold", 1], // rare — informative
    ])
    const queryTokens = ["acme", "threshold"]
    const matchesRare = scoreMemory({
      ...base,
      memoryTokens: new Set(["threshold"]),
      queryTokens,
      dfByToken: df,
    })
    const matchesCommon = scoreMemory({
      ...base,
      memoryTokens: new Set(["acme"]),
      queryTokens,
      dfByToken: df,
    })
    expect(matchesRare).toBeGreaterThan(matchesCommon)
  })
  it("matching more query tokens scores higher (overlap fraction)", () => {
    const df = new Map([
      ["billing", 2],
      ["threshold", 2],
    ])
    const queryTokens = ["billing", "threshold"]
    const two = scoreMemory({
      ...base,
      memoryTokens: new Set(["billing", "threshold"]),
      queryTokens,
      dfByToken: df,
    })
    const one = scoreMemory({
      ...base,
      memoryTokens: new Set(["billing"]),
      queryTokens,
      dfByToken: df,
    })
    expect(two).toBeGreaterThan(one)
    expect(two).toBeCloseTo(0.6 * 1 + 0.3 * 1 + 0.1 * 1, 10) // full match, age 0, conf 1
  })
  it("recency component halves at exactly one half-life", () => {
    const df = new Map([["x", 1]])
    const args = {
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      confidence: 1,
      referenceNow: NOW,
      options: { weights: { relevance: 0, recency: 1, confidence: 0 } },
    }
    const fresh = scoreMemory({ ...args, updatedAt: NOW })
    const halfLife = scoreMemory({ ...args, updatedAt: ago(DEFAULT_RECENCY_HALF_LIFE_MS) })
    expect(fresh).toBeCloseTo(1, 10)
    expect(halfLife).toBeCloseTo(0.5, 10)
  })
  it("confidence is clamped to [0,1]", () => {
    const df = new Map([["x", 1]])
    const args = {
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      updatedAt: NOW,
      referenceNow: NOW,
      options: { weights: { relevance: 0, recency: 0, confidence: 1 } },
    }
    expect(scoreMemory({ ...args, confidence: 1.5 })).toBeCloseTo(1, 10)
    expect(scoreMemory({ ...args, confidence: -0.2 })).toBeCloseTo(0, 10)
  })
  it("invalid timestamps degrade to age 0 (recency 1), never throw", () => {
    const df = new Map([["x", 1]])
    const score = scoreMemory({
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      updatedAt: "not-a-date",
      confidence: 1,
      referenceNow: "also-not-a-date",
      options: { weights: { relevance: 0, recency: 1, confidence: 0 } },
    })
    expect(score).toBeCloseTo(1, 10)
  })
  it("weight overrides merge with defaults (partial weights allowed)", () => {
    const df = new Map([["x", 1]])
    const score = scoreMemory({
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      updatedAt: NOW,
      confidence: 0,
      referenceNow: NOW,
      options: { weights: { confidence: 0.5 } }, // relevance/recency keep defaults 0.6/0.3
    })
    expect(score).toBeCloseTo(0.6 + 0.3 + 0, 10)
  })
  it("non-positive or non-finite recencyHalfLifeMs falls back to the default", () => {
    const df = new Map([["x", 1]])
    const args = {
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      confidence: 1,
      referenceNow: NOW,
      updatedAt: ago(DEFAULT_RECENCY_HALF_LIFE_MS),
    }
    const weights = { relevance: 0, recency: 1, confidence: 0 }
    const withDefault = scoreMemory({ ...args, options: { weights } })
    const zero = scoreMemory({ ...args, options: { weights, recencyHalfLifeMs: 0 } })
    const negative = scoreMemory({ ...args, options: { weights, recencyHalfLifeMs: -5 } })
    expect(Number.isFinite(zero)).toBe(true)
    expect(Number.isFinite(negative)).toBe(true)
    expect(zero).toBeCloseTo(withDefault, 10)
    expect(negative).toBeCloseTo(withDefault, 10)
    // age 0 with half-life 0 would be 0/0 → NaN without the fallback
    const freshZero = scoreMemory({
      ...args,
      updatedAt: NOW,
      options: { weights, recencyHalfLifeMs: 0 },
    })
    expect(freshZero).toBeCloseTo(1, 10)
  })
  it("NaN confidence is treated as 0", () => {
    const df = new Map([["x", 1]])
    const score = scoreMemory({
      memoryTokens: new Set(["x"]),
      queryTokens: ["x"],
      dfByToken: df,
      corpusSize: 1,
      updatedAt: NOW,
      confidence: Number.NaN,
      referenceNow: NOW,
      options: { weights: { relevance: 0, recency: 0, confidence: 1 } },
    })
    expect(score).toBeCloseTo(0, 10)
  })
  it("empty queryTokens yields relevance 0 (score = recency + confidence terms)", () => {
    const score = scoreMemory({
      memoryTokens: new Set(["x"]),
      queryTokens: [],
      dfByToken: new Map(),
      corpusSize: 1,
      updatedAt: NOW,
      confidence: 1,
      referenceNow: NOW,
    })
    expect(score).toBeCloseTo(0.3 * 1 + 0.1 * 1, 10) // default weights, age 0, conf 1
  })
  it("exposes the documented defaults", () => {
    expect(DEFAULT_RECENCY_HALF_LIFE_MS).toBe(14 * DAY)
    expect(DEFAULT_CANDIDATE_POOL).toBe(256)
  })
})
