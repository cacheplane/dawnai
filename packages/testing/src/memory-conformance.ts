import type { MemoryRecord, MemoryStore } from "@dawn-ai/memory"
import { expect, test } from "vitest"

function rec(
  over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace" | "content">,
): MemoryRecord {
  return {
    kind: "semantic",
    data: {},
    source: { type: "eval", id: "seed" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}
const vec = (...xs: number[]) => new Float32Array(xs)

/**
 * The contract every MemoryStore must satisfy. Run against sqlite (in-process,
 * always) and pgvector (real Postgres, gated) so backends cannot drift. Pass
 * vitest's `describe`; `makeStore` returns a FRESH empty store per call.
 */
export function runMemoryStoreConformance(opts: {
  readonly name: string
  readonly makeStore: () => Promise<MemoryStore> | MemoryStore
  readonly describe: (name: string, fn: () => void) => void
  readonly close?: (store: MemoryStore) => Promise<void> | void
}): void {
  const { name, makeStore, describe, close } = opts
  describe(`MemoryStore conformance: ${name}`, () => {
    test("put + get round-trips", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns", content: "hello billing" }))
        expect((await s.get("a"))?.content).toBe("hello billing")
      } finally {
        await close?.(s)
      }
    })
    test("search is namespace-isolated", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns1", content: "billing escalation" }))
        await s.put(rec({ id: "b", namespace: "ns2", content: "billing escalation" }))
        expect((await s.search({ namespace: "ns1", query: "billing" })).map((r) => r.id)).toEqual([
          "a",
        ])
      } finally {
        await close?.(s)
      }
    })
    test("query-less search is pure recency order", async () => {
      const s = await makeStore()
      try {
        await s.put(
          rec({ id: "old", namespace: "ns", content: "x", updatedAt: "2026-07-01T00:00:00.000Z" }),
        )
        await s.put(
          rec({ id: "new", namespace: "ns", content: "y", updatedAt: "2026-07-04T00:00:00.000Z" }),
        )
        expect((await s.search({ namespace: "ns" })).map((r) => r.id)).toEqual(["new", "old"])
      } finally {
        await close?.(s)
      }
    })
    test("supersede: old→superseded, new active, link recorded", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "old", namespace: "ns", content: "v1" }))
        await s.put(rec({ id: "new", namespace: "ns", content: "v2" }))
        await s.supersede("old", "new")
        expect((await s.get("old"))?.status).toBe("superseded")
        expect((await s.get("new"))?.supersedes).toContain("old")
      } finally {
        await close?.(s)
      }
    })
    test("candidate listing + delete", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "c", namespace: "ns", content: "cand", status: "candidate" }))
        expect((await s.listCandidates("")).map((r) => r.id)).toContain("c")
        await s.delete("c")
        expect(await s.get("c")).toBeNull()
      } finally {
        await close?.(s)
      }
    })
    test("update preserves the stored embedding (vector recall still finds it)", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "e", namespace: "ns", content: "faster shipping" }), {
          embedding: vec(1, 0, 0),
          embeddingModel: "fake:test",
        })
        await s.update("e", { confidence: 0.5 })
        const out = await s.search({
          namespace: "ns",
          query: "expedite delivery",
          queryEmbedding: vec(1, 0, 0),
          embedderId: "fake:test",
          now: "2026-07-05T00:00:00.000Z",
        })
        expect(out.map((r) => r.id)).toContain("e")
      } finally {
        await close?.(s)
      }
    })
    test("hybrid: a 0-shared-token semantic match is recalled via the vector list", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "sem", namespace: "ns", content: "faster shipping preferred" }), {
          embedding: vec(1, 0, 0),
          embeddingModel: "fake:test",
        })
        await s.put(rec({ id: "kw", namespace: "ns", content: "acme billing" }), {
          embedding: vec(0, 1, 0),
          embeddingModel: "fake:test",
        })
        const out = await s.search({
          namespace: "ns",
          query: "expedite delivery",
          queryEmbedding: vec(0.95, 0.05, 0),
          embedderId: "fake:test",
          now: "2026-07-05T00:00:00.000Z",
        })
        expect(out.map((r) => r.id)).toContain("sem")
        expect(out[0]?.id).toBe("sem")
      } finally {
        await close?.(s)
      }
    })
    test("browse lists across namespaces and statuses, newest first, with total", async () => {
      const s = await makeStore()
      try {
        await s.put(
          rec({
            id: "a",
            namespace: "route=/x",
            content: "a",
            updatedAt: "2026-07-03T00:00:00.000Z",
          }),
        )
        await s.put(
          rec({
            id: "b",
            namespace: "route=/y",
            content: "b",
            status: "candidate",
            updatedAt: "2026-07-02T00:00:00.000Z",
          }),
        )
        await s.put(
          rec({
            id: "c",
            namespace: "route=/x",
            content: "c",
            status: "superseded",
            updatedAt: "2026-07-01T00:00:00.000Z",
          }),
        )
        const page = await s.browse()
        expect(page.total).toBe(3)
        expect(page.records.map((r) => r.id)).toEqual(["a", "b", "c"])
      } finally {
        await close?.(s)
      }
    })
    test("browse orders equal-updated_at rows by id ASC", async () => {
      const s = await makeStore()
      try {
        // Same updatedAt on every row: id ASC is the sole tiebreak, and both
        // backends must agree byte-for-byte (BINARY / C collation). Mixed case
        // distinguishes codepoint order ("B10" < "a9") from locale collation.
        for (const id of ["b2", "B10", "a9"]) {
          await s.put(rec({ id, namespace: "ns", content: id }))
        }
        expect((await s.browse()).records.map((r) => r.id)).toEqual(["B10", "a9", "b2"])
      } finally {
        await close?.(s)
      }
    })
    test("browse filters by namespacePrefix, status, kind, and sourceType individually", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        await s.put(rec({ id: "b", namespace: "route=/y", content: "b", status: "candidate" }))
        await s.put(
          rec({ id: "h", namespace: "route=/x", content: "h", source: { type: "human", id: "u" } }),
        )
        await s.put(rec({ id: "e", namespace: "other", content: "e", kind: "episodic" }))
        expect(
          (await s.browse({ namespacePrefix: "route=/x" })).records.map((r) => r.id).sort(),
        ).toEqual(["a", "h"])
        expect((await s.browse({ status: "candidate" })).records.map((r) => r.id)).toEqual(["b"])
        expect((await s.browse({ kind: "episodic" })).records.map((r) => r.id)).toEqual(["e"])
        expect((await s.browse({ sourceType: "human" })).records.map((r) => r.id)).toEqual(["h"])
      } finally {
        await close?.(s)
      }
    })
    test("browse combines multiple filters with AND (COUNT shares the clause)", async () => {
      const s = await makeStore()
      try {
        // Strict-subset construction: each of b/h/y passes two of the three
        // clauses but fails the third, so only "a" survives — and total:1
        // proves the COUNT query applies the same WHERE as the row query.
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        await s.put(rec({ id: "b", namespace: "route=/x", content: "b", status: "candidate" }))
        await s.put(
          rec({ id: "h", namespace: "route=/x", content: "h", source: { type: "human", id: "u" } }),
        )
        await s.put(rec({ id: "y", namespace: "route=/y", content: "y" }))
        const page = await s.browse({
          namespacePrefix: "route=/x",
          status: "active",
          sourceType: "eval",
        })
        expect(page.records.map((r) => r.id)).toEqual(["a"])
        expect(page.total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("browse pages with limit/offset while total stays full", async () => {
      const s = await makeStore()
      try {
        for (let i = 0; i < 5; i++) {
          await s.put(
            rec({
              id: `r${i}`,
              namespace: "ns",
              content: `r${i}`,
              updatedAt: `2026-07-0${i + 1}T00:00:00.000Z`,
            }),
          )
        }
        const page = await s.browse({ limit: 2, offset: 2 })
        expect(page.total).toBe(5)
        expect(page.records.map((r) => r.id)).toEqual(["r2", "r1"])
      } finally {
        await close?.(s)
      }
    })
    test("browse returns an empty page on an empty store", async () => {
      const s = await makeStore()
      try {
        expect(await s.browse()).toEqual({ records: [], total: 0 })
      } finally {
        await close?.(s)
      }
    })
    test("browse returns empty records but full total when offset exceeds total", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns", content: "a" }))
        const page = await s.browse({ limit: 10, offset: 99 })
        expect(page.records).toEqual([])
        expect(page.total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("browse/stats namespacePrefix treats LIKE metacharacters literally", async () => {
      const s = await makeStore()
      try {
        // Underscore: "route=/foo_" must NOT also match "route=/fooXbar".
        await s.put(rec({ id: "u", namespace: "route=/foo_bar", content: "u" }))
        await s.put(rec({ id: "x", namespace: "route=/fooXbar", content: "x" }))
        // Percent + trailing backslash: "50%_off\\" must match only the
        // literal namespace, never wildcard-expand.
        await s.put(rec({ id: "p", namespace: "50%_off\\x", content: "p" }))
        await s.put(rec({ id: "q", namespace: "50Y_offx", content: "q" }))
        const page = await s.browse({ namespacePrefix: "route=/foo_" })
        expect(page.records.map((r) => r.id)).toEqual(["u"])
        expect(page.total).toBe(1)
        expect((await s.stats({ namespacePrefix: "route=/foo_" })).total).toBe(1)
        const pct = await s.browse({ namespacePrefix: "50%" })
        expect(pct.records.map((r) => r.id)).toEqual(["p"])
        expect(pct.total).toBe(1)
        const bs = await s.browse({ namespacePrefix: "50%_off\\" })
        expect(bs.records.map((r) => r.id)).toEqual(["p"])
        expect(bs.total).toBe(1)
        expect((await s.stats({ namespacePrefix: "50%_off\\" })).total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("browse namespacePrefix is case-sensitive", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        expect(await s.browse({ namespacePrefix: "Route=/X" })).toEqual({ records: [], total: 0 })
        expect((await s.stats({ namespacePrefix: "Route=/X" })).total).toBe(0)
      } finally {
        await close?.(s)
      }
    })
    test("stats returns count maps by status/kind/namespace/sourceType plus total", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        await s.put(rec({ id: "b", namespace: "route=/y", content: "b", status: "candidate" }))
        await s.put(
          rec({ id: "h", namespace: "route=/x", content: "h", source: { type: "human", id: "u" } }),
        )
        const st = await s.stats()
        expect(st.total).toBe(3)
        expect(st.byStatus).toEqual({ active: 2, candidate: 1 })
        expect(st.byKind).toEqual({ semantic: 3 })
        expect(st.byNamespace).toEqual({ "route=/x": 2, "route=/y": 1 })
        expect(st.bySourceType).toEqual({ eval: 2, human: 1 })
      } finally {
        await close?.(s)
      }
    })
    test("stats honors namespacePrefix", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        await s.put(rec({ id: "b", namespace: "route=/y", content: "b" }))
        expect((await s.stats({ namespacePrefix: "route=/x" })).total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("stats returns zero total and empty maps on an empty store", async () => {
      const s = await makeStore()
      try {
        expect(await s.stats()).toEqual({
          total: 0,
          byStatus: {},
          byKind: {},
          byNamespace: {},
          bySourceType: {},
        })
      } finally {
        await close?.(s)
      }
    })
    test("hybrid: mismatched embedder tag is excluded from the vector list", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "stale", namespace: "ns", content: "faster shipping" }), {
          embedding: vec(1, 0, 0),
          embeddingModel: "old:model",
        })
        const out = await s.search({
          namespace: "ns",
          query: "expedite delivery",
          queryEmbedding: vec(1, 0, 0),
          embedderId: "fake:test",
          now: "2026-07-05T00:00:00.000Z",
        })
        expect(out.map((r) => r.id)).not.toContain("stale")
      } finally {
        await close?.(s)
      }
    })
  })
}
