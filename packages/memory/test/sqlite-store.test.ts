import { describe, expect, it } from "vitest"
import { sqliteMemoryStore } from "../src/sqlite-store.js"
import type { MemoryRecord } from "../src/types.js"

function rec(
  over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace" | "content">,
): MemoryRecord {
  return {
    kind: "semantic",
    data: {},
    source: { type: "run", id: "r" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

describe("sqliteMemoryStore", () => {
  it("put + get round-trips a record", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns1", content: "hello billing" }))
    expect((await s.get("a"))?.content).toBe("hello billing")
  })
  it("search is namespace-isolated", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns1", content: "billing escalation" }))
    await s.put(rec({ id: "b", namespace: "ns2", content: "billing escalation" }))
    expect((await s.search({ namespace: "ns1", query: "billing" })).map((r) => r.id)).toEqual(["a"])
  })
  it("search matches tokenized keywords and orders by recency (updatedAt desc)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "old",
        namespace: "ns",
        content: "escalate billing",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "new",
        namespace: "ns",
        content: "escalate billing",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
    )
    await s.put(rec({ id: "other", namespace: "ns", content: "unrelated note" }))
    expect((await s.search({ namespace: "ns", query: "billing" })).map((r) => r.id)).toEqual([
      "new",
      "old",
    ])
  })
  it("search defaults to active status (excludes candidate/superseded)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns", content: "billing", status: "candidate" }))
    expect(await s.search({ namespace: "ns", query: "billing" })).toHaveLength(0)
    expect(await s.search({ namespace: "ns", query: "billing", status: "candidate" })).toHaveLength(
      1,
    )
  })
  it("supersede flips the old record status and links it", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "old", namespace: "ns", content: "v1" }))
    await s.put(rec({ id: "new", namespace: "ns", content: "v2" }))
    await s.supersede("old", "new")
    expect((await s.get("old"))?.status).toBe("superseded")
  })
  it("ranked recall: relevant-but-old beats recent-but-marginal (headline)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    // Several acme memories so "acme" is common (low idf) in the namespace.
    await s.put(
      rec({
        id: "m1",
        namespace: "ns",
        content: "acme invoice format is pdf",
        updatedAt: "2026-06-30T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "m2",
        namespace: "ns",
        content: "acme owner is jordan",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "target",
        namespace: "ns",
        content: "acme billing escalation threshold is 500 dollars",
        updatedAt: "2026-05-20T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "distractor",
        namespace: "ns",
        content: "acme contact jordan prefers slack",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    const out = await s.search({
      namespace: "ns",
      query: "acme billing escalation threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    // Pure recency (old behavior) would put "distractor" first; ranking must not.
    expect(out[0]?.id).toBe("target")
  })
  it("ranked recall: same relevance ties break by recency then id", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "b_old",
        namespace: "ns",
        content: "billing threshold fact",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "a_new",
        namespace: "ns",
        content: "billing threshold fact",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    const out = await s.search({
      namespace: "ns",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    expect(out.map((r) => r.id)).toEqual(["a_new", "b_old"])
  })
  it("ranked recall: omitted `now` is accepted and produces a stable order", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "x",
        namespace: "ns",
        content: "billing threshold",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "y",
        namespace: "ns",
        content: "billing note",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    const a = await s.search({ namespace: "ns", query: "billing threshold" })
    const b = await s.search({ namespace: "ns", query: "billing threshold" })
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id)) // same inputs → same order
    expect(a[0]?.id).toBe("x") // matches 2/2 tokens; y matches 1/2
  })
  it("ranked recall: confidence breaks ties at equal relevance and recency", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "hedged",
        namespace: "ns",
        content: "billing threshold fact",
        confidence: 0.4,
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "sure",
        namespace: "ns",
        content: "billing threshold fact",
        confidence: 1,
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    const out = await s.search({
      namespace: "ns",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    expect(out[0]?.id).toBe("sure")
  })
  it("ranked recall: candidatePool caps scored candidates by recency, deterministically", async () => {
    const s = sqliteMemoryStore({ path: ":memory:", recall: { candidatePool: 1 } })
    await s.put(
      rec({
        id: "older",
        namespace: "ns",
        content: "billing threshold exact",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "newer",
        namespace: "ns",
        content: "billing note",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    const out = await s.search({
      namespace: "ns",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    // Pool of 1 keeps only the NEWEST token-match; "older" never gets scored.
    expect(out.map((r) => r.id)).toEqual(["newer"])
  })
  it("ranked recall: candidatePool of 0 falls back to the default (recall not silently dead)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:", recall: { candidatePool: 0 } })
    await s.put(
      rec({
        id: "older",
        namespace: "ns",
        content: "billing threshold exact",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "newer",
        namespace: "ns",
        content: "billing note",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    const out = await s.search({
      namespace: "ns",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    // A 0 pool would be LIMIT 0 → always [] — the guard must default it instead,
    // so both matches are scored and ranked (full match first).
    expect(out.map((r) => r.id)).toEqual(["older", "newer"])
  })
  it("query-less search is unchanged: pure recency order", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "old",
        namespace: "ns",
        content: "billing threshold exact match",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "new",
        namespace: "ns",
        content: "unrelated note",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    const out = await s.search({ namespace: "ns" })
    expect(out.map((r) => r.id)).toEqual(["new", "old"])
  })
  it("kind filter scopes corpus stats and candidates", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "sem_full",
        namespace: "ns",
        kind: "semantic",
        content: "billing threshold is 500",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "sem_partial",
        namespace: "ns",
        kind: "semantic",
        content: "billing contact note",
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "epi",
        namespace: "ns",
        kind: "episodic",
        content: "billing threshold discussed in standup",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    const out = await s.search({
      namespace: "ns",
      kind: "semantic",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    // Episodic record matches every query token but must be excluded by kind.
    expect(out.map((r) => r.kind)).toEqual(["semantic", "semantic"])
    expect(out.map((r) => r.id)).not.toContain("epi")
    expect(out[0]?.id).toBe("sem_full") // full match outranks partial within the kind
  })
  it("id tiebreak: identical score and updatedAt orders by id ascending", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "b",
        namespace: "ns",
        content: "billing threshold fact",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "a",
        namespace: "ns",
        content: "billing threshold fact",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    const out = await s.search({
      namespace: "ns",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    expect(out.map((r) => r.id)).toEqual(["a", "b"])
  })
  it("all-tokens-dropped query takes the recency path", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "older_match",
        namespace: "ns",
        content: "a real billing threshold fact",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "newer_unrelated",
        namespace: "ns",
        content: "unrelated note",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    )
    // "a" is a 1-char token — tokenize() drops it, leaving zero query tokens.
    const out = await s.search({ namespace: "ns", query: "a" })
    // Zero-token queries must behave exactly like no query: pure recency,
    // no token filter — both records come back, newest first.
    expect(out.map((r) => r.id)).toEqual(["newer_unrelated", "older_match"])
  })

  // --- vector / hybrid recall ---
  const EM = "fake:test" // embedder id tag used by these tests
  function vec(...xs: number[]) {
    return new Float32Array(xs)
  }

  it("hybrid: a semantic-only match (0 shared words) is recalled via the vector list", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    // "delivery" query will share NO tokens with this content, but its vector is near.
    await s.put(
      rec({
        id: "sem",
        namespace: "ns",
        content: "faster shipping preferred",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: vec(1, 0, 0), embeddingModel: EM },
    )
    await s.put(
      rec({
        id: "kw",
        namespace: "ns",
        content: "acme billing threshold",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: vec(0, 1, 0), embeddingModel: EM },
    )
    const out = await s.search({
      namespace: "ns",
      query: "expedite delivery", // shares no tokens with "sem"
      queryEmbedding: vec(0.95, 0.05, 0),
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
    })
    // "sem" enters ONLY via the vector list (no keyword overlap) and must be recalled.
    expect(out.map((r) => r.id)).toContain("sem")
    expect(out[0]?.id).toBe("sem")
  })

  it("hybrid: an exact keyword hit still ranks even with a poor vector", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "exact",
        namespace: "ns",
        content: "order ALPHA-111 status shipped",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: vec(0, 0, 1), embeddingModel: EM },
    )
    await s.put(
      rec({
        id: "near",
        namespace: "ns",
        content: "delivery timing note",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: vec(1, 0, 0), embeddingModel: EM },
    )
    const out = await s.search({
      namespace: "ns",
      query: "ALPHA-111", // exact token only "exact" has
      queryEmbedding: vec(0.9, 0.1, 0), // vector-near "near", far from "exact"
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
    })
    // Co-equal RRF: the exact keyword match is present and must be recalled (not buried).
    expect(out.map((r) => r.id)).toContain("exact")
  })

  it("hybrid: rows with a mismatched embedder tag are ignored by the vector list", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "stale",
        namespace: "ns",
        content: "faster shipping",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: vec(1, 0, 0), embeddingModel: "old:model" }, // different embedder
    )
    const out = await s.search({
      namespace: "ns",
      query: "expedite delivery",
      queryEmbedding: vec(1, 0, 0),
      embedderId: EM, // does not match "old:model"
      now: "2026-07-05T00:00:00.000Z",
    })
    // No keyword overlap AND embedder mismatch → "stale" is not vector-eligible → not recalled.
    expect(out.map((r) => r.id)).not.toContain("stale")
  })

  it("no queryEmbedding → keyword path unchanged (vector columns ignored)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns", content: "billing threshold" }), {
      embedding: vec(1, 0, 0),
      embeddingModel: EM,
    })
    const out = await s.search({
      namespace: "ns",
      query: "billing threshold",
      now: "2026-07-05T00:00:00.000Z",
    })
    expect(out.map((r) => r.id)).toEqual(["a"]) // pure keyword path still works with embeddings present
  })

  it("put without embedding opts persists a keyword-only row (back-compat)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns", content: "billing threshold" })) // no opts
    expect((await s.search({ namespace: "ns", query: "billing" })).map((r) => r.id)).toEqual(["a"])
  })

  it("update() preserves the stored embedding (vector recall still finds it)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(
      rec({
        id: "sem",
        namespace: "ns",
        content: "faster shipping preferred",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: vec(1, 0, 0), embeddingModel: EM },
    )
    // Unrelated field update — must NOT drop the embedding.
    await s.update("sem", { confidence: 0.5 })
    const out = await s.search({
      namespace: "ns",
      query: "expedite delivery", // no keyword overlap → only vector list can surface "sem"
      queryEmbedding: vec(0.95, 0.05, 0),
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
    })
    expect(out.map((r) => r.id)).toContain("sem")
  })

  it("hybrid: stores a sub-view Float32Array embedding without corruption", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    const backing = new Float32Array([9, 9, 1, 0, 0, 7, 7]) // the [1,0,0] embedding is a sub-view at offset 2
    const view = backing.subarray(2, 5) // Float32Array view: byteOffset 8, length 3, values [1,0,0]
    await s.put(
      rec({
        id: "sub",
        namespace: "ns",
        content: "faster shipping preferred",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: view, embeddingModel: EM },
    )
    // A decoy that is a poor (orthogonal) vector match. If the sub-view write
    // corrupts "sub" (stores all 7 floats → length-mismatch → cosine 0), the
    // decoy wins and "sub" no longer ranks first — that's the regression guard.
    await s.put(
      rec({
        id: "decoy",
        namespace: "ns",
        content: "acme billing threshold",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
      { embedding: vec(0.5, 0.5, 0), embeddingModel: EM }, // cosine ≈0.71 with query — beats a corrupt "sub" (cosine 0), loses to a correct one (1.0)
    )
    const out = await s.search({
      namespace: "ns",
      query: "expedite delivery",
      queryEmbedding: vec(1, 0, 0),
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
    })
    // If the write corrupted the view (stored all 7 floats), the stored vector wouldn't be [1,0,0] and cosine≈1 wouldn't hold → "sub" wouldn't rank first / be recalled.
    expect(out.map((r) => r.id)).toContain("sub")
    expect(out[0]?.id).toBe("sub")
  })

  it("hybrid: a NaN tuning weight degrades to the default (no NaN-poisoned ordering)", async () => {
    const seed = async (store: ReturnType<typeof sqliteMemoryStore>) => {
      await store.put(
        rec({
          id: "sem",
          namespace: "ns",
          content: "faster shipping preferred",
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
        { embedding: vec(1, 0, 0), embeddingModel: EM },
      )
      await store.put(
        rec({
          id: "kw",
          namespace: "ns",
          content: "acme billing threshold",
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
        { embedding: vec(0, 1, 0), embeddingModel: EM },
      )
    }
    const query = {
      namespace: "ns",
      query: "expedite delivery",
      queryEmbedding: vec(0.95, 0.05, 0),
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
    } as const

    const baseline = sqliteMemoryStore({ path: ":memory:" })
    await seed(baseline)
    const expected = (await baseline.search(query)).map((r) => r.id)

    const nan = sqliteMemoryStore({ path: ":memory:" })
    await seed(nan)
    const withNaN = (await nan.search({ ...query, vector: { recencyWeight: Number.NaN } })).map(
      (r) => r.id,
    )

    // A NaN weight must not poison the score → same finite ordering as the default.
    expect(withNaN).toEqual(expected)
    expect(withNaN[0]).toBe("sem")
  })

  it("hybrid: recall.recencyHalfLifeMs reaches the hybrid second stage (flips ordering)", async () => {
    // "old" wins the RRF base race (keyword rank1 + vector rank1); "new" only
    // enters via the vector list (rank2) but is the newest. With a heavy recency
    // weight, a TINY half-life collapses old's recency multiplier so new wins —
    // but ONLY if recall.recencyHalfLifeMs is actually threaded into the hybrid
    // recencyDecay. Under the default 14d half-life old's small age barely
    // penalizes it, so old stays first.
    const seed = async (store: ReturnType<typeof sqliteMemoryStore>) => {
      await store.put(
        rec({
          id: "old",
          namespace: "ns",
          content: "expedite delivery route", // matches the query → keyword rank1
          updatedAt: "2026-07-04T00:00:00.000Z", // 1 day old
        }),
        { embedding: vec(1, 0, 0), embeddingModel: EM }, // cosine 1 → vector rank1
      )
      await store.put(
        rec({
          id: "new",
          namespace: "ns",
          content: "warehouse note", // no query token → absent from keyword list
          updatedAt: "2026-07-05T00:00:00.000Z", // newest (age 0 at `now`)
        }),
        { embedding: vec(0.6, 0.8, 0), embeddingModel: EM }, // cosine 0.6 → vector rank2
      )
    }
    const query = {
      namespace: "ns",
      query: "expedite delivery",
      queryEmbedding: vec(1, 0, 0),
      embedderId: EM,
      now: "2026-07-05T00:00:00.000Z",
      vector: { recencyWeight: 3 }, // heavy recency so half-life meaningfully moves ranking
    } as const

    const dfl = sqliteMemoryStore({ path: ":memory:" }) // default 14d half-life
    await seed(dfl)
    const defaultOrder = (await dfl.search(query)).map((r) => r.id)

    const tiny = sqliteMemoryStore({ path: ":memory:", recall: { recencyHalfLifeMs: 1000 } })
    await seed(tiny)
    const tinyOrder = (await tiny.search(query)).map((r) => r.id)

    // Knob honored: the tiny recall half-life must change the hybrid ordering.
    expect(defaultOrder[0]).toBe("old")
    expect(tinyOrder[0]).toBe("new")
    expect(tinyOrder).not.toEqual(defaultOrder)
  })
})
