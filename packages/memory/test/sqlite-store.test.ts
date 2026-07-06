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
})
