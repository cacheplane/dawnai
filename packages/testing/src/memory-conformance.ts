import { approveWithReconcile, type MemoryRecord, type MemoryStore } from "@dawn-ai/memory"
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
const D = (day: number) => `2026-08-0${day}T00:00:00.000Z`

/** Episodic event fixture — the append-only kind windows/expiry/prune govern. */
function ep(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return rec({
    namespace: "route=/n",
    content: over.id,
    kind: "episodic",
    source: { type: "run", id: "r" },
    createdAt: D(1),
    updatedAt: D(1),
    ...over,
  })
}

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
    test("search window: since is inclusive, until is exclusive on effectiveAt", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "d1", effectiveAt: D(1) }))
        await s.put(ep({ id: "d2", effectiveAt: D(2) }))
        await s.put(ep({ id: "d3", effectiveAt: D(3) }))
        const out = await s.search({ namespace: "route=/n", since: D(2), until: D(3) })
        expect(out.map((r) => r.id)).toEqual(["d2"])
      } finally {
        await close?.(s)
      }
    })
    test("search window falls back to createdAt for legacy rows without effectiveAt", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "legacy", createdAt: D(2), updatedAt: D(2) })) // no effectiveAt
        await s.put(ep({ id: "outside", createdAt: D(5), updatedAt: D(5) }))
        const out = await s.search({ namespace: "route=/n", since: D(1), until: D(3) })
        expect(out.map((r) => r.id)).toEqual(["legacy"])
      } finally {
        await close?.(s)
      }
    })
    test("windowed query-less search orders by event time, not update time", async () => {
      const s = await makeStore()
      try {
        // updatedAt order is DELIBERATELY the reverse of effectiveAt order —
        // proves windowed ordering uses event time, not update time.
        await s.put(ep({ id: "b", effectiveAt: D(3), updatedAt: D(1) }))
        await s.put(ep({ id: "a", effectiveAt: D(1), updatedAt: D(3) }))
        await s.put(ep({ id: "c", effectiveAt: D(3), updatedAt: D(2) }))
        const out = await s.search({ namespace: "route=/n", since: D(1) })
        expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]) // D3 pair id-ASC, then D1
      } finally {
        await close?.(s)
      }
    })
    test("windowed query-less equal event times order by codepoint id (C collation)", async () => {
      const s = await makeStore()
      try {
        // Same effectiveAt on every row: id ASC is the sole tiebreak, and both
        // backends must agree byte-for-byte (BINARY / C collation). Mixed case
        // distinguishes codepoint order ("B10" < "a9") from locale collation.
        for (const id of ["b2", "B10", "a9"]) {
          await s.put(ep({ id, effectiveAt: D(2) }))
        }
        const out = await s.search({ namespace: "route=/n", since: D(1) })
        expect(out.map((r) => r.id)).toEqual(["B10", "a9", "b2"])
      } finally {
        await close?.(s)
      }
    })
    test("search with now excludes expired rows; without now shows everything", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "live", expiresAt: D(9) }))
        await s.put(ep({ id: "dead", expiresAt: D(2) }))
        const withNow = await s.search({ namespace: "route=/n", now: D(5) })
        expect(withNow.map((r) => r.id)).toEqual(["live"])
        const withoutNow = await s.search({ namespace: "route=/n" })
        expect(withoutNow.map((r) => r.id).sort()).toEqual(["dead", "live"])
      } finally {
        await close?.(s)
      }
    })
    test("expiry boundary: expiresAt exactly equal to now is excluded", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "edge", expiresAt: D(5) }))
        expect((await s.search({ namespace: "route=/n", now: D(5) })).length).toBe(0)
      } finally {
        await close?.(s)
      }
    })
    test("ranked (query) search shares the window + expiry clause", async () => {
      const s = await makeStore()
      try {
        await s.put(
          ep({
            id: "hit",
            content: "deploy failed on staging",
            effectiveAt: D(2),
            expiresAt: D(9),
          }),
        )
        await s.put(
          ep({
            id: "expired",
            content: "deploy failed on prod",
            effectiveAt: D(2),
            expiresAt: D(3),
          }),
        )
        await s.put(ep({ id: "outside", content: "deploy failed early", effectiveAt: D(1) }))
        const out = await s.search({
          namespace: "route=/n",
          query: "deploy failed",
          since: D(2),
          now: D(5),
        })
        expect(out.map((r) => r.id)).toEqual(["hit"])
      } finally {
        await close?.(s)
      }
    })
    test("browse honors since/until + now, with total sharing the clause", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "live", effectiveAt: D(2), expiresAt: D(9) }))
        await s.put(ep({ id: "dead", effectiveAt: D(2), expiresAt: D(3) }))
        await s.put(ep({ id: "early", effectiveAt: D(1), expiresAt: D(9) }))
        const page = await s.browse({ since: D(2), until: D(4), now: D(5) })
        expect(page.records.map((r) => r.id)).toEqual(["live"])
        expect(page.total).toBe(1) // COUNT shares the full WHERE incl. expiry+window
      } finally {
        await close?.(s)
      }
    })
    test("prune deletes expired rows of any kind and reports the count", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "sem-dead", kind: "semantic", expiresAt: D(2) }))
        await s.put(ep({ id: "ep-dead", expiresAt: D(2) }))
        await s.put(ep({ id: "ep-live", expiresAt: D(9) }))
        const res = await s.prune({ now: D(5) })
        expect(res).toEqual({ deletedExpired: 2, deletedOverCap: 0 })
        expect(await s.get("sem-dead")).toBeNull()
        expect((await s.get("ep-live"))?.id).toBe("ep-live")
      } finally {
        await close?.(s)
      }
    })
    test("prune caps episodic rows per namespace, keeping the newest by event time", async () => {
      const s = await makeStore()
      try {
        for (let i = 1; i <= 5; i++) await s.put(ep({ id: `e${i}`, effectiveAt: D(i) }))
        const res = await s.prune({ now: D(9), cap: 3 })
        expect(res.deletedOverCap).toBe(2)
        expect((await s.browse({ kind: "episodic" })).records.map((r) => r.id).sort()).toEqual([
          "e3",
          "e4",
          "e5",
        ])
      } finally {
        await close?.(s)
      }
    })
    test("prune cap is PER namespace and never touches non-episodic rows", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "sem", kind: "semantic" }))
        for (let i = 1; i <= 3; i++) {
          await s.put(ep({ id: `a${i}`, namespace: "route=/a", effectiveAt: D(i) }))
        }
        for (let i = 1; i <= 3; i++) {
          await s.put(ep({ id: `b${i}`, namespace: "route=/b", effectiveAt: D(i) }))
        }
        const res = await s.prune({ now: D(9), cap: 2 })
        expect(res.deletedOverCap).toBe(2) // one from each namespace
        expect(await s.get("a1")).toBeNull()
        expect(await s.get("b1")).toBeNull()
        expect((await s.get("sem"))?.id).toBe("sem")
      } finally {
        await close?.(s)
      }
    })
    test("prune cap ranks episodic rows regardless of status (superseded counts)", async () => {
      const s = await makeStore()
      try {
        // A superseded episodic row sits between two actives by event time. The
        // cap pass ranks ALL episodic rows — status never exempts a row from the
        // budget — so cap=2 keeps the two newest (one of them superseded) and
        // evicts the oldest ACTIVE row.
        await s.put(ep({ id: "new-active", effectiveAt: D(3) }))
        await s.put(ep({ id: "mid-superseded", effectiveAt: D(2), status: "superseded" }))
        await s.put(ep({ id: "old-active", effectiveAt: D(1) }))
        const res = await s.prune({ now: D(9), cap: 2 })
        expect(res.deletedOverCap).toBe(1)
        expect(await s.get("old-active")).toBeNull()
        expect((await s.get("mid-superseded"))?.id).toBe("mid-superseded")
        expect((await s.get("new-active"))?.id).toBe("new-active")
      } finally {
        await close?.(s)
      }
    })
    test("prune equal event times evict by codepoint id order (deterministic tiebreak)", async () => {
      const s = await makeStore()
      try {
        // Same effectiveAt; codepoint id order decides. Keep the NEWEST 2 under
        // (effective DESC, id ASC) ordering ⇒ evict the last in that ordering:
        // "b2" (0x62 highest codepoint sorts last among equals).
        await s.put(ep({ id: "B10", effectiveAt: D(2) }))
        await s.put(ep({ id: "a9", effectiveAt: D(2) }))
        await s.put(ep({ id: "b2", effectiveAt: D(2) }))
        await s.prune({ now: D(9), cap: 2 })
        expect(await s.get("b2")).toBeNull()
        expect((await s.get("B10"))?.id).toBe("B10")
        expect((await s.get("a9"))?.id).toBe("a9")
      } finally {
        await close?.(s)
      }
    })
    test("prune namespacePrefix narrows both TTL and cap passes", async () => {
      const s = await makeStore()
      try {
        await s.put(ep({ id: "in", namespace: "route=/a", expiresAt: D(2) }))
        await s.put(ep({ id: "out", namespace: "route=/b", expiresAt: D(2) }))
        for (let i = 1; i <= 3; i++) {
          await s.put(ep({ id: `ka${i}`, namespace: "route=/a", effectiveAt: D(i + 2) }))
        }
        for (let i = 1; i <= 3; i++) {
          await s.put(ep({ id: `kb${i}`, namespace: "route=/b", effectiveAt: D(i + 2) }))
        }
        const res = await s.prune({ now: D(5), cap: 2, namespacePrefix: "route=/a" })
        expect(res.deletedExpired).toBe(1)
        expect(res.deletedOverCap).toBe(1)
        expect((await s.get("out"))?.id).toBe("out")
        expect(await s.get("ka1")).toBeNull()
        expect((await s.get("kb1"))?.id).toBe("kb1")
      } finally {
        await close?.(s)
      }
    })
    test("prune is idempotent — a second identical prune deletes nothing", async () => {
      const s = await makeStore()
      try {
        for (let i = 1; i <= 4; i++) {
          await s.put(
            ep({ id: `e${i}`, effectiveAt: D(i), ...(i === 1 ? { expiresAt: D(2) } : {}) }),
          )
        }
        await s.prune({ now: D(5), cap: 2 })
        const second = await s.prune({ now: D(5), cap: 2 })
        expect(second).toEqual({ deletedExpired: 0, deletedOverCap: 0 })
      } finally {
        await close?.(s)
      }
    })
    test("episodic candidate approval is plain activation — no reconcile against actives", async () => {
      const s = await makeStore()
      try {
        // Identical data to an existing active row: a reconcile policy would
        // dedupe (delete the candidate); the episodic append policy activates it.
        await s.put(ep({ id: "prior", data: { event: "deploy" }, effectiveAt: D(1) }))
        await s.put(
          ep({ id: "cand", data: { event: "deploy" }, status: "candidate", effectiveAt: D(2) }),
        )
        const res = await approveWithReconcile(s, "cand", {
          identityKeys: ["event"],
          now: D(3),
        })
        expect(res.action).toBe("activated")
        expect(res.superseded).toEqual([])
        expect((await s.get("cand"))?.status).toBe("active")
        expect((await s.get("prior"))?.status).toBe("active")
      } finally {
        await close?.(s)
      }
    })
  })
}
