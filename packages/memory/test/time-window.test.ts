import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MemoryRecord, sqliteMemoryStore } from "../src/index.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-tw-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  return {
    kind: "episodic",
    namespace: "route=/n",
    content: over.id,
    data: {},
    source: { type: "run", id: "r" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}
const D = (day: number) => `2026-08-0${day}T00:00:00.000Z`

describe("search time windows", () => {
  it("filters on effectiveAt with inclusive since / exclusive until", async () => {
    const s = makeStore()
    await s.put(rec({ id: "d1", effectiveAt: D(1) }))
    await s.put(rec({ id: "d2", effectiveAt: D(2) }))
    await s.put(rec({ id: "d3", effectiveAt: D(3) }))
    const out = await s.search({ namespace: "route=/n", since: D(2), until: D(3) })
    expect(out.map((r) => r.id)).toEqual(["d2"]) // since inclusive, until exclusive
  })
  it("falls back to createdAt for legacy rows without effectiveAt", async () => {
    const s = makeStore()
    await s.put(rec({ id: "legacy", createdAt: D(2), updatedAt: D(2) })) // no effectiveAt
    await s.put(rec({ id: "outside", createdAt: D(5), updatedAt: D(5) }))
    const out = await s.search({ namespace: "route=/n", since: D(1), until: D(3) })
    expect(out.map((r) => r.id)).toEqual(["legacy"])
  })
  it("windowed query-less search returns event-time order (effectiveAt DESC, id ASC)", async () => {
    const s = makeStore()
    // updatedAt order is DELIBERATELY the reverse of effectiveAt order —
    // proves windowed ordering uses event time, not update time.
    await s.put(rec({ id: "b", effectiveAt: D(3), updatedAt: D(1) }))
    await s.put(rec({ id: "a", effectiveAt: D(1), updatedAt: D(3) }))
    await s.put(rec({ id: "c", effectiveAt: D(3), updatedAt: D(2) }))
    const out = await s.search({ namespace: "route=/n", since: D(1) })
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]) // D3 pair id-ASC, then D1
  })
})

describe("expiry exclusion", () => {
  it("search with now excludes expired rows; without now shows everything", async () => {
    const s = makeStore()
    await s.put(rec({ id: "live", expiresAt: D(9) }))
    await s.put(rec({ id: "dead", expiresAt: D(2) }))
    const withNow = await s.search({ namespace: "route=/n", now: D(5) })
    expect(withNow.map((r) => r.id)).toEqual(["live"])
    const withoutNow = await s.search({ namespace: "route=/n" })
    expect(withoutNow.map((r) => r.id).sort()).toEqual(["dead", "live"])
  })
  it("boundary: expiresAt exactly equal to now is excluded", async () => {
    const s = makeStore()
    await s.put(rec({ id: "edge", expiresAt: D(5) }))
    expect((await s.search({ namespace: "route=/n", now: D(5) })).length).toBe(0)
  })
  it("browse honors now + since/until the same way", async () => {
    const s = makeStore()
    await s.put(rec({ id: "live", effectiveAt: D(2), expiresAt: D(9) }))
    await s.put(rec({ id: "dead", effectiveAt: D(2), expiresAt: D(3) }))
    const page = await s.browse({ since: D(1), until: D(4), now: D(5) })
    expect(page.records.map((r) => r.id)).toEqual(["live"])
    expect(page.total).toBe(1) // COUNT shares the full WHERE incl. expiry+window
  })
  it("ranked (query) search also excludes expired and honors the window", async () => {
    const s = makeStore()
    await s.put(
      rec({ id: "hit", content: "deploy failed on staging", effectiveAt: D(2), expiresAt: D(9) }),
    )
    await s.put(
      rec({ id: "expired", content: "deploy failed on prod", effectiveAt: D(2), expiresAt: D(3) }),
    )
    await s.put(rec({ id: "outside", content: "deploy failed early", effectiveAt: D(1) }))
    const out = await s.search({ namespace: "route=/n", query: "deploy failed", since: D(2), now: D(5) })
    expect(out.map((r) => r.id)).toEqual(["hit"])
  })
})
