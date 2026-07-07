import { describe, expect, it } from "vitest"
import { fuseHybrid, rankKeywordCandidates } from "../src/hybrid.js"
import type { MemoryRecord } from "../src/types.js"

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content">): MemoryRecord {
  return {
    kind: "semantic",
    namespace: "ns",
    data: {},
    source: { type: "run", id: "r" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

describe("rankKeywordCandidates", () => {
  it("ranks by IDF relevance; rare-token match beats common-token match", () => {
    const cands = [
      rec({ id: "rare", content: "acme threshold" }),
      rec({ id: "common", content: "acme owner jordan" }),
    ]
    const df = new Map([
      ["acme", 2],
      ["threshold", 1],
    ])
    const out = rankKeywordCandidates(
      cands,
      df,
      2,
      ["acme", "threshold"],
      "2026-07-05T00:00:00.000Z",
    )
    expect(out[0]?.id).toBe("rare")
  })
  it("relevance-only weights ignore recency (for the hybrid keyword list)", () => {
    const cands = [
      rec({ id: "old", content: "billing threshold", updatedAt: "2026-05-01T00:00:00.000Z" }),
      rec({ id: "new", content: "billing note", updatedAt: "2026-07-01T00:00:00.000Z" }),
    ]
    const df = new Map([
      ["billing", 2],
      ["threshold", 1],
    ])
    const out = rankKeywordCandidates(
      cands,
      df,
      2,
      ["billing", "threshold"],
      "2026-07-05T00:00:00.000Z",
      { weights: { relevance: 1, recency: 0, confidence: 0 } },
    )
    expect(out[0]?.id).toBe("old") // 2/2 tokens beats 1/2 despite being older
  })
})

describe("fuseHybrid", () => {
  it("a semantic-only match (only in the vector list) is fused into the results", () => {
    const kw = [rec({ id: "kwonly", content: "acme billing" })]
    const vec = [
      rec({ id: "semonly", content: "faster shipping" }),
      rec({ id: "kwonly", content: "acme billing" }),
    ]
    const out = fuseHybrid({
      keywordRanked: kw,
      vectorRanked: vec,
      now: "2026-07-05T00:00:00.000Z",
    })
    // A vector-only match (absent from the keyword list) is unioned in via RRF.
    // Under co-equal RRF, kwonly (rank1 keyword + rank2 vector) outscores semonly
    // (rank1 vector only), matching the pre-extraction sqlite fusion exactly.
    expect(out.map((r) => r.id)).toContain("semonly")
    expect(out[0]?.id).toBe("kwonly")
  })
  it("co-equal RRF: an exact keyword hit is not buried by a strong vector list", () => {
    const kw = [rec({ id: "exact", content: "order ALPHA-111" })]
    const vec = [
      rec({ id: "near", content: "delivery" }),
      rec({ id: "exact", content: "order ALPHA-111" }),
    ]
    const out = fuseHybrid({
      keywordRanked: kw,
      vectorRanked: vec,
      now: "2026-07-05T00:00:00.000Z",
    })
    expect(out.map((r) => r.id)).toContain("exact")
  })
  it("NaN tuning weights degrade to defaults (finite, deterministic order)", () => {
    const kw = [rec({ id: "a", content: "x" })]
    const vec = [rec({ id: "a", content: "x" })]
    const out = fuseHybrid({
      keywordRanked: kw,
      vectorRanked: vec,
      now: "2026-07-05T00:00:00.000Z",
      options: { recencyWeight: Number.NaN },
    })
    expect(out.map((r) => r.id)).toEqual(["a"])
  })
})
