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
const D = (day: number) => `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`

/** Record fixture with episodic defaults (kind overridable, e.g. for prune's
 *  non-episodic immunity cases). */
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
    test("browse accepts a set of statuses or kinds, matching any of them", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "act", namespace: "route=/x", content: "act" }))
        await s.put(
          rec({ id: "cand", namespace: "route=/x", content: "cand", status: "candidate" }),
        )
        await s.put(rec({ id: "sup", namespace: "route=/x", content: "sup", status: "superseded" }))
        await s.put(rec({ id: "ep", namespace: "route=/x", content: "ep", kind: "episodic" }))
        await s.put(rec({ id: "proc", namespace: "route=/x", content: "proc", kind: "procedural" }))

        expect(
          (await s.browse({ status: ["candidate", "superseded"] })).records.map((r) => r.id).sort(),
        ).toEqual(["cand", "sup"])
        expect(
          (await s.browse({ kind: ["episodic", "procedural"] })).records.map((r) => r.id).sort(),
        ).toEqual(["ep", "proc"])
      } finally {
        await close?.(s)
      }
    })
    test("browse treats a one-element set exactly like the bare value", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        await s.put(rec({ id: "b", namespace: "route=/x", content: "b", status: "candidate" }))
        const bare = await s.browse({ status: "candidate" })
        const set = await s.browse({ status: ["candidate"] })
        expect(set.records.map((r) => r.id)).toEqual(bare.records.map((r) => r.id))
        expect(set.total).toBe(bare.total)
      } finally {
        await close?.(s)
      }
    })
    test("browse matches nothing for an empty set — not everything", async () => {
      const s = await makeStore()
      try {
        // "none of these" is an OR over zero options, which is false. Reading it
        // as "no filter" would silently show every row to a UI that had just
        // unticked its last box.
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        await s.put(rec({ id: "b", namespace: "route=/x", content: "b", status: "candidate" }))
        const page = await s.browse({ status: [] })
        expect(page.records).toEqual([])
        expect(page.total).toBe(0)
      } finally {
        await close?.(s)
      }
    })
    test("browse counts a set with the same clause it selects with", async () => {
      const s = await makeStore()
      try {
        for (let i = 0; i < 5; i += 1) {
          await s.put(
            rec({ id: `c${i}`, namespace: "route=/x", content: `c${i}`, status: "candidate" }),
          )
        }
        await s.put(rec({ id: "keep", namespace: "route=/x", content: "keep" }))
        const page = await s.browse({ status: ["candidate", "superseded"], limit: 2 })
        expect(page.records).toHaveLength(2)
        // total reflects the whole matching set, not the page.
        expect(page.total).toBe(5)
      } finally {
        await close?.(s)
      }
    })
    test("browse ANDs a status set with the other filters", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "hit", namespace: "route=/x", content: "hit", status: "candidate" }))
        await s.put(
          rec({ id: "wrongNs", namespace: "route=/y", content: "n", status: "candidate" }),
        )
        await s.put(rec({ id: "wrongStatus", namespace: "route=/x", content: "s" }))
        const page = await s.browse({
          namespacePrefix: "route=/x",
          status: ["candidate", "superseded"],
        })
        expect(page.records.map((r) => r.id)).toEqual(["hit"])
        expect(page.total).toBe(1)
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
        expect(await s.browse()).toEqual({ records: [], total: 0, continuation: null })
      } finally {
        await close?.(s)
      }
    })
    // Deliberately temporary scaffold. It pins the CURRENT (unimplemented) continuation
    // behavior so "always null" is executable rather than only prose — without it, a
    // consumer reading BrowsePage's JSDoc as "null = no more rows" stops after page 1
    // and nothing fails. Task 14 (keyset continuation) MUST delete this test: it breaks
    // the moment a filled window starts issuing a continuation, which is the point.
    test("browse issues no continuation yet, even when the window fills", async () => {
      const s = await makeStore()
      try {
        for (const id of ["c0", "c1", "c2"]) {
          await s.put(rec({ id, namespace: "ns", content: id }))
        }
        const page = await s.browse({ limit: 2 })
        expect(page.records).toHaveLength(2)
        expect(page.total).toBe(3)
        expect(page.continuation).toBeNull()
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
        expect(await s.browse({ namespacePrefix: "Route=/X" })).toEqual({
          records: [],
          total: 0,
          continuation: null,
        })
        expect((await s.stats({ namespacePrefix: "Route=/X" })).total).toBe(0)
      } finally {
        await close?.(s)
      }
    })
    test("browse rejects an invalid query instead of silently matching zero rows", async () => {
      const s = await makeStore()
      try {
        // A store that quietly returns [] for a malformed filter teaches the caller
        // that its query was fine and the data was empty. Both are lies.
        // Identity, not wording: the HTTP boundary maps a rejection to 400 by `name`, so
        // a store that caught and rethrew a plain Error satisfies every regex below and
        // still 500s. Asserted by name rather than `instanceof`, which is false across the
        // two module copies a bundled route and a node_modules store resolve to.
        await expect(s.browse({ status: "bogus" as never })).rejects.toMatchObject({
          name: "BrowseQueryError",
          code: "invalid-query",
        })
        await expect(s.browse({ status: "bogus" as never })).rejects.toThrow(/invalid status/)
        await expect(
          s.browse({ filters: [{ field: "tags", op: "in", values: ["x"] }] as never }),
        ).rejects.toThrow(/unknown filter field/)
        await expect(
          s.browse({ filters: [{ field: "status", op: "in", values: [] }] }),
        ).rejects.toThrow(/must not be empty/)
        await expect(
          s.browse({ orderBy: [{ field: "content" as never, dir: "asc" }] }),
        ).rejects.toThrow(/unknown sort field/)
        await expect(s.browse({ limit: 0 })).rejects.toThrow(/limit must be an integer >= 1/)
        await expect(s.browse({ since: "2026-08-09" })).rejects.toThrow(/full ISO-8601/)
      } finally {
        await close?.(s)
      }
    })
    test("browse does NOT impose the HTTP limit ceiling on in-process callers", async () => {
      const s = await makeStore()
      try {
        // The CLI's consolidation scan browses with limit 10_000, so no store may pass
        // `maxLimit` into the validator. Only that rejection is visible here: with one row
        // seeded, a store that also clamped 10_000 down to the ceiling reads identically.
        await s.put(rec({ id: "a", namespace: "ns", content: "a" }))
        const page = await s.browse({ limit: 10_000 })
        expect(page.total).toBe(1)
        expect(page.records.map((r) => r.id)).toEqual(["a"])
      } finally {
        await close?.(s)
      }
    })
    test("browse filters[] narrows by status/kind set, ANDed with everything else", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "route=/x", content: "a" }))
        await s.put(rec({ id: "b", namespace: "route=/x", content: "b", status: "candidate" }))
        await s.put(rec({ id: "e", namespace: "route=/y", content: "e", kind: "episodic" }))
        const inSet = await s.browse({
          filters: [{ field: "status", op: "in", values: ["candidate", "superseded"] }],
        })
        expect(inSet.records.map((r) => r.id)).toEqual(["b"])
        expect(inSet.total).toBe(1)
        const notIn = await s.browse({
          filters: [{ field: "kind", op: "notIn", values: ["episodic"] }],
        })
        expect(notIn.records.map((r) => r.id).sort()).toEqual(["a", "b"])
        expect(notIn.total).toBe(2)
        const anded = await s.browse({
          namespacePrefix: "route=/x",
          filters: [{ field: "status", op: "in", values: ["candidate"] }],
        })
        expect(anded.records.map((r) => r.id)).toEqual(["b"])
        expect(anded.total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("browse content filters are case-insensitive substring matches, not LIKE patterns", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns", content: "Acme threshold is 500" }))
        await s.put(rec({ id: "b", namespace: "ns", content: "zed color is blue" }))
        await s.put(rec({ id: "pct", namespace: "ns", content: "50% off today" }))
        await s.put(rec({ id: "und", namespace: "ns", content: "50Xoff today" }))
        const contains = await s.browse({
          filters: [{ field: "content", op: "contains", value: "ACME" }],
        })
        expect(contains.records.map((r) => r.id)).toEqual(["a"])
        expect(contains.total).toBe(1)
        expect(
          (
            await s.browse({ filters: [{ field: "content", op: "notContains", value: "acme" }] })
          ).records
            .map((r) => r.id)
            .sort(),
        ).toEqual(["b", "pct", "und"])
        expect(
          (
            await s.browse({ filters: [{ field: "content", op: "startsWith", value: "acme " }] })
          ).records.map((r) => r.id),
        ).toEqual(["a"])
        expect(
          (
            await s.browse({ filters: [{ field: "content", op: "endsWith", value: "IS BLUE" }] })
          ).records.map((r) => r.id),
        ).toEqual(["b"])
        expect(
          (
            await s.browse({
              filters: [{ field: "content", op: "equals", value: "zed color is blue" }],
            })
          ).records.map((r) => r.id),
        ).toEqual(["b"])
        expect(
          (
            await s.browse({
              filters: [{ field: "content", op: "notEquals", value: "zed color is blue" }],
            })
          ).total,
        ).toBe(3)
        // "%" and "_" are literal characters, not wildcards: this is why the stores
        // use instr/position instead of LIKE. Both needles SEPARATE the two readings —
        // under LIKE, "%" is "anything" and "_" is "any one character", so both would
        // additionally admit "500" and "50Xoff". A needle either reading accepts (say
        // "50% o") asserts nothing here.
        expect(
          (
            await s.browse({ filters: [{ field: "content", op: "contains", value: "50%" }] })
          ).records.map((r) => r.id),
        ).toEqual(["pct"])
        expect(
          (
            await s.browse({ filters: [{ field: "content", op: "contains", value: "50_" }] })
          ).records.map((r) => r.id),
        ).toEqual([])
      } finally {
        await close?.(s)
      }
    })
    test("browse namespace is EXACT while namespacePrefix stays a prefix", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "exact", namespace: "route=/a", content: "exact" }))
        await s.put(rec({ id: "child", namespace: "route=/ab", content: "child" }))
        const byPrefix = await s.browse({ namespacePrefix: "route=/a" })
        expect(byPrefix.records.map((r) => r.id).sort()).toEqual(["child", "exact"])
        expect(byPrefix.total).toBe(2)
        // The exact field is what kills the Inspector's client-side narrowing, where
        // the server counted the prefix and the client displayed the equality.
        const byExact = await s.browse({ namespace: "route=/a" })
        expect(byExact.records.map((r) => r.id)).toEqual(["exact"])
        expect(byExact.total).toBe(1)
        const byFilter = await s.browse({
          filters: [{ field: "namespace", op: "equals", value: "route=/ab" }],
        })
        expect(byFilter.records.map((r) => r.id)).toEqual(["child"])
        expect(byFilter.total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("browse namespace startsWith keeps byte-exact, case-sensitive, metachar-literal semantics", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "u", namespace: "route=/foo_bar", content: "u" }))
        await s.put(rec({ id: "x", namespace: "route=/fooXbar", content: "x" }))
        await s.put(rec({ id: "unicode", namespace: "route=/日本語", content: "unicode" }))
        const underscore = await s.browse({
          filters: [{ field: "namespace", op: "startsWith", value: "route=/foo_" }],
        })
        expect(underscore.records.map((r) => r.id)).toEqual(["u"])
        expect(underscore.total).toBe(1)
        expect(
          (
            await s.browse({
              filters: [{ field: "namespace", op: "startsWith", value: "ROUTE=/foo" }],
            })
          ).total,
        ).toBe(0)
        // Multi-byte prefixes must not fall outside the computed range.
        const unicode = await s.browse({
          filters: [{ field: "namespace", op: "startsWith", value: "route=/日" }],
        })
        expect(unicode.records.map((r) => r.id)).toEqual(["unicode"])
        expect(unicode.total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("browse ANDs namespace with namespacePrefix instead of letting one win", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "exact", namespace: "route=/a", content: "exact" }))
        await s.put(rec({ id: "child", namespace: "route=/ab", content: "child" }))
        // The only query that binds both clauses at once, so it is the only one where
        // a parameter pushed out of step with its clause shows up as a wrong answer
        // rather than a bind error.
        const both = await s.browse({ namespace: "route=/ab", namespacePrefix: "route=/a" })
        expect(both.records.map((r) => r.id)).toEqual(["child"])
        expect(both.total).toBe(1)
        const disjoint = await s.browse({ namespace: "route=/a", namespacePrefix: "route=/ab" })
        expect(disjoint.records).toEqual([])
        expect(disjoint.total).toBe(0)
      } finally {
        await close?.(s)
      }
    })
    test("browse namespacePrefix above the last code point keeps only a lower bound", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "below", namespace: "route=/a", content: "below" }))
        await s.put(rec({ id: "top", namespace: "\u{10FFFF}top", content: "top" }))
        // Nothing sorts above U+10FFFF, so the prefix has no successor and the upper
        // bound must be OMITTED — binding an absent one matches nothing at all.
        const top = await s.browse({ namespacePrefix: "\u{10FFFF}" })
        expect(top.records.map((r) => r.id)).toEqual(["top"])
        expect(top.total).toBe(1)
        const viaFilter = await s.browse({
          filters: [{ field: "namespace", op: "startsWith", value: "\u{10FFFF}" }],
        })
        expect(viaFilter.records.map((r) => r.id)).toEqual(["top"])
        expect(viaFilter.total).toBe(1)
      } finally {
        await close?.(s)
      }
    })
    test("browse filters by confidence, with between inclusive on both ends", async () => {
      const s = await makeStore()
      try {
        // 0.9 is chosen deliberately: it is not representable in float4, so `eq`
        // is asserted against the value READ BACK, which is the only one a backend
        // that narrows on write can still match.
        await s.put(rec({ id: "low", namespace: "ns", content: "low", confidence: 0.2 }))
        await s.put(rec({ id: "mid", namespace: "ns", content: "mid", confidence: 0.5 }))
        await s.put(rec({ id: "high", namespace: "ns", content: "high", confidence: 0.9 }))
        const stored = (await s.get("high"))?.confidence as number
        expect(
          (
            await s.browse({ filters: [{ field: "confidence", op: "eq", value: stored }] })
          ).records.map((r) => r.id),
        ).toEqual(["high"])
        expect(
          (
            await s.browse({ filters: [{ field: "confidence", op: "gt", value: 0.5 }] })
          ).records.map((r) => r.id),
        ).toEqual(["high"])
        // Ids, not counts: at this spread `gte 0.5` and `lte 0.5` both match two rows,
        // so a count-only assertion passes with the two operators transposed.
        const gte = await s.browse({ filters: [{ field: "confidence", op: "gte", value: 0.5 }] })
        expect(gte.records.map((r) => r.id).sort()).toEqual(["high", "mid"])
        expect(gte.total).toBe(2)
        expect(
          (
            await s.browse({ filters: [{ field: "confidence", op: "lt", value: 0.5 }] })
          ).records.map((r) => r.id),
        ).toEqual(["low"])
        const lte = await s.browse({ filters: [{ field: "confidence", op: "lte", value: 0.5 }] })
        expect(lte.records.map((r) => r.id).sort()).toEqual(["low", "mid"])
        expect(lte.total).toBe(2)
        const neq = await s.browse({ filters: [{ field: "confidence", op: "neq", value: 0.5 }] })
        expect(neq.records.map((r) => r.id).sort()).toEqual(["high", "low"])
        expect(neq.total).toBe(2)
        const between = await s.browse({
          filters: [{ field: "confidence", op: "between", min: 0.2, max: 0.5 }],
        })
        expect(between.records.map((r) => r.id).sort()).toEqual(["low", "mid"])
        expect(between.total).toBe(2)
      } finally {
        await close?.(s)
      }
    })
    test("browse filters updatedAt by UTC day buckets", async () => {
      const s = await makeStore()
      try {
        await s.put(
          rec({ id: "d1", namespace: "ns", content: "d1", updatedAt: "2026-08-01T23:59:59.999Z" }),
        )
        await s.put(
          rec({ id: "d2", namespace: "ns", content: "d2", updatedAt: "2026-08-02T00:00:00.000Z" }),
        )
        await s.put(
          rec({ id: "d3", namespace: "ns", content: "d3", updatedAt: "2026-08-03T12:00:00.000Z" }),
        )
        const onDay = await s.browse({
          filters: [{ field: "updatedAt", op: "onDay", day: "2026-08-02" }],
        })
        expect(onDay.records.map((r) => r.id)).toEqual(["d2"])
        expect(onDay.total).toBe(1)
        expect(
          (
            await s.browse({
              filters: [{ field: "updatedAt", op: "beforeDay", day: "2026-08-02" }],
            })
          ).records.map((r) => r.id),
        ).toEqual(["d1"])
        expect(
          (
            await s.browse({ filters: [{ field: "updatedAt", op: "afterDay", day: "2026-08-02" }] })
          ).records.map((r) => r.id),
        ).toEqual(["d3"])
        const span = await s.browse({
          filters: [
            {
              field: "updatedAt",
              op: "betweenDays",
              fromDay: "2026-08-01",
              untilDay: "2026-08-02",
            },
          ],
        })
        expect(span.records.map((r) => r.id).sort()).toEqual(["d1", "d2"])
        expect(span.total).toBe(2)
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
    test("supersede links and demotes episodic records (consolidation's dependency)", async () => {
      const s = await makeStore()
      try {
        // Consolidation writes a summary then supersedes each source episode.
        // Both backends must fan MANY sources into ONE summary's link list, and
        // active-only browse must stop surfacing the sources — otherwise recall
        // double-counts the events the summary already covers.
        await s.put(ep({ id: "src1", namespace: "ns", content: "run one" }))
        await s.put(ep({ id: "src2", namespace: "ns", content: "run two" }))
        await s.put(ep({ id: "sum", namespace: "ns", content: "summary", tags: ["consolidated"] }))
        await s.supersede("src1", "sum")
        await s.supersede("src2", "sum")
        await s.supersede("src1", "sum") // repeat: links merge through a Set, never duplicate
        expect((await s.get("src1"))?.status).toBe("superseded")
        expect((await s.get("src2"))?.status).toBe("superseded")
        const links = (await s.get("sum"))?.supersedes
        expect(links).toEqual(expect.arrayContaining(["src1", "src2"]))
        expect(links).toHaveLength(2)
        // active-only browse no longer surfaces the sources
        expect(
          (await s.browse({ status: "active", kind: "episodic" })).records.map((r) => r.id),
        ).toEqual(["sum"])
      } finally {
        await close?.(s)
      }
    })
    test("browse applies orderBy in order and always terminates with the id tie-break", async () => {
      const s = await makeStore()
      try {
        // Deliberately tied on the leading key so the tie-break is the ONLY thing
        // deciding the order — and mixed-case ids so a locale collation would
        // disagree with byte order if the tie-break were not pinned.
        await s.put(
          rec({ id: "B", namespace: "ns", content: "B", confidence: 0.5, updatedAt: D(1) }),
        )
        await s.put(
          rec({ id: "a", namespace: "ns", content: "a", confidence: 0.5, updatedAt: D(1) }),
        )
        await s.put(
          rec({ id: "C", namespace: "ns", content: "C", confidence: 0.5, updatedAt: D(1) }),
        )
        await s.put(
          rec({ id: "z", namespace: "ns", content: "z", confidence: 0.9, updatedAt: D(2) }),
        )
        expect(
          (await s.browse({ orderBy: [{ field: "confidence", dir: "desc" }] })).records.map(
            (r) => r.id,
          ),
        ).toEqual(["z", "B", "C", "a"])
        expect(
          (await s.browse({ orderBy: [{ field: "confidence", dir: "asc" }] })).records.map(
            (r) => r.id,
          ),
        ).toEqual(["B", "C", "a", "z"])
      } finally {
        await close?.(s)
      }
    })
    test("browse honors a multi-key orderBy with mixed directions", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "1", namespace: "ns=b", content: "1", confidence: 0.1 }))
        await s.put(rec({ id: "2", namespace: "ns=a", content: "2", confidence: 0.9 }))
        await s.put(rec({ id: "3", namespace: "ns=a", content: "3", confidence: 0.1 }))
        expect(
          (
            await s.browse({
              orderBy: [
                { field: "namespace", dir: "asc" },
                { field: "confidence", dir: "desc" },
              ],
            })
          ).records.map((r) => r.id),
        ).toEqual(["2", "3", "1"])
      } finally {
        await close?.(s)
      }
    })
    test("browse with an empty orderBy is the documented default order", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "old", namespace: "ns", content: "old", updatedAt: D(1) }))
        await s.put(rec({ id: "new", namespace: "ns", content: "new", updatedAt: D(2) }))
        expect((await s.browse({ orderBy: [] })).records.map((r) => r.id)).toEqual(["new", "old"])
        expect((await s.browse()).records.map((r) => r.id)).toEqual(["new", "old"])
      } finally {
        await close?.(s)
      }
    })
  })
}
