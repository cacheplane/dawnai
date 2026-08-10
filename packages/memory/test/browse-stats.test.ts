import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MemoryRecord, sqliteMemoryStore } from "../src/index.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-mem-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace">): MemoryRecord {
  return {
    kind: "semantic",
    content: over.id,
    data: {},
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }
}

describe("browse", () => {
  it("lists across namespaces and statuses, newest first, with total", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x", updatedAt: "2026-07-03T00:00:00.000Z" }))
    await s.put(
      rec({
        id: "b",
        namespace: "route=/y",
        status: "candidate",
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
    )
    await s.put(
      rec({
        id: "c",
        namespace: "route=/x",
        status: "superseded",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    )
    const page = await s.browse()
    expect(page.total).toBe(3)
    expect(page.records.map((r) => r.id)).toEqual(["a", "b", "c"])
  })
  it("filters by namespacePrefix, status, kind, sourceType", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x" }))
    await s.put(rec({ id: "b", namespace: "route=/y", status: "candidate" }))
    await s.put(rec({ id: "h", namespace: "route=/x", source: { type: "human", id: "u" } }))
    await s.put(rec({ id: "e", namespace: "other", kind: "episodic" }))
    expect(
      (await s.browse({ namespacePrefix: "route=/x" })).records.map((r) => r.id).sort(),
    ).toEqual(["a", "h"])
    expect((await s.browse({ status: "candidate" })).records.map((r) => r.id)).toEqual(["b"])
    expect((await s.browse({ kind: "episodic" })).records.map((r) => r.id)).toEqual(["e"])
    expect((await s.browse({ sourceType: "human" })).records.map((r) => r.id)).toEqual(["h"])
  })
  it("combines multiple filters with AND", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x" }))
    await s.put(rec({ id: "b", namespace: "route=/x", status: "candidate" }))
    await s.put(rec({ id: "h", namespace: "route=/x", source: { type: "human", id: "u" } }))
    await s.put(rec({ id: "y", namespace: "route=/y" }))
    const page = await s.browse({
      namespacePrefix: "route=/x",
      status: "active",
      sourceType: "tool",
    })
    expect(page.records.map((r) => r.id)).toEqual(["a"])
    expect(page.total).toBe(1)
  })
  it("returns an empty page on an empty store", async () => {
    const s = makeStore()
    expect(await s.browse()).toEqual({ records: [], total: 0, continuation: null })
  })
  it("returns empty records but full total when offset exceeds total", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "ns" }))
    const page = await s.browse({ limit: 10, offset: 99 })
    expect(page.records).toEqual([])
    expect(page.total).toBe(1)
  })
  it("pages with limit/offset while total stays full", async () => {
    const s = makeStore()
    for (let i = 0; i < 5; i++)
      await s.put(
        rec({ id: `r${i}`, namespace: "ns", updatedAt: `2026-07-0${i + 1}T00:00:00.000Z` }),
      )
    const page = await s.browse({ limit: 2, offset: 2 })
    expect(page.total).toBe(5)
    expect(page.records.map((r) => r.id)).toEqual(["r2", "r1"])
  })
})

describe("stats", () => {
  it("returns count maps by status/kind/namespace/sourceType", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x" }))
    await s.put(rec({ id: "b", namespace: "route=/y", status: "candidate" }))
    await s.put(rec({ id: "h", namespace: "route=/x", source: { type: "human", id: "u" } }))
    const st = await s.stats()
    expect(st.total).toBe(3)
    expect(st.byStatus).toEqual({ active: 2, candidate: 1 })
    expect(st.byKind).toEqual({ semantic: 3 })
    expect(st.byNamespace).toEqual({ "route=/x": 2, "route=/y": 1 })
    expect(st.bySourceType).toEqual({ tool: 2, human: 1 })
  })
  it("returns zero total and empty maps on an empty store", async () => {
    const s = makeStore()
    expect(await s.stats()).toEqual({
      total: 0,
      byStatus: {},
      byKind: {},
      byNamespace: {},
      bySourceType: {},
    })
  })
  it("honors namespacePrefix", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x" }))
    await s.put(rec({ id: "b", namespace: "route=/y" }))
    expect((await s.stats({ namespacePrefix: "route=/x" })).total).toBe(1)
  })
})
