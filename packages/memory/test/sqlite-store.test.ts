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
})
