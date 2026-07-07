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
