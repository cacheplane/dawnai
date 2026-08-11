import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildSummaryRecord,
  type MemoryRecord,
  selectConsolidationBatches,
  sqliteMemoryStore,
} from "../src/index.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-prune-"))
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

describe("prune", () => {
  it("deletes expired rows of any kind and reports the count", async () => {
    const s = makeStore()
    await s.put(rec({ id: "sem-dead", kind: "semantic", expiresAt: D(2) }))
    await s.put(rec({ id: "ep-dead", expiresAt: D(2) }))
    await s.put(rec({ id: "ep-live", expiresAt: D(9) }))
    const res = await s.prune({ now: D(5) })
    expect(res).toEqual({ deletedExpired: 2, deletedOverCap: 0 })
    expect(await s.get("sem-dead")).toBeNull()
    expect((await s.get("ep-live"))?.id).toBe("ep-live")
  })
  it("caps episodic rows per namespace, keeping the newest by event time", async () => {
    const s = makeStore()
    for (let i = 1; i <= 5; i++) await s.put(rec({ id: `e${i}`, effectiveAt: D(i) }))
    const res = await s.prune({ now: D(9), cap: 3 })
    expect(res.deletedOverCap).toBe(2)
    expect((await s.browse({ kind: "episodic" })).records.map((r) => r.id).sort()).toEqual([
      "e3",
      "e4",
      "e5",
    ])
  })
  it("cap is PER namespace and never touches non-episodic rows", async () => {
    const s = makeStore()
    await s.put(rec({ id: "sem", kind: "semantic", namespace: "route=/n" }))
    for (let i = 1; i <= 3; i++)
      await s.put(rec({ id: `a${i}`, namespace: "route=/a", effectiveAt: D(i) }))
    for (let i = 1; i <= 3; i++)
      await s.put(rec({ id: `b${i}`, namespace: "route=/b", effectiveAt: D(i) }))
    const res = await s.prune({ now: D(9), cap: 2 })
    expect(res.deletedOverCap).toBe(2) // one from each namespace
    expect(await s.get("a1")).toBeNull()
    expect(await s.get("b1")).toBeNull()
    expect((await s.get("sem"))?.id).toBe("sem")
  })
  it("equal event times evict by id order (deterministic tiebreak)", async () => {
    const s = makeStore()
    // Same effectiveAt; codepoint id order decides. Oldest = LOWEST id first out.
    await s.put(rec({ id: "B10", effectiveAt: D(2) }))
    await s.put(rec({ id: "a9", effectiveAt: D(2) }))
    await s.put(rec({ id: "b2", effectiveAt: D(2) }))
    await s.prune({ now: D(9), cap: 2 })
    // Keep the NEWEST 2 under (effective DESC, id ASC) ordering ⇒ evict the last
    // in that ordering: "b2" (0x62 highest codepoint sorts last among equals).
    expect(await s.get("b2")).toBeNull()
    expect((await s.get("B10"))?.id).toBe("B10")
    expect((await s.get("a9"))?.id).toBe("a9")
  })
  it("namespacePrefix narrows both TTL and cap passes", async () => {
    const s = makeStore()
    await s.put(rec({ id: "in", namespace: "route=/a", expiresAt: D(2) }))
    await s.put(rec({ id: "out", namespace: "route=/b", expiresAt: D(2) }))
    const res = await s.prune({ now: D(5), namespacePrefix: "route=/a" })
    expect(res.deletedExpired).toBe(1)
    expect((await s.get("out"))?.id).toBe("out")
  })
  // Regression: consolidation writes a dense summary and supersedes its sources,
  // but the cap pass is STATUS-AGNOSTIC — it ranks every episodic row. A summary
  // stamped with its period's START sorts as the oldest row of its own batch, so
  // the cap evicted the summary and kept the superseded sources that recall can
  // no longer see: the compaction destroyed data instead of compacting it.
  it("a summary outranks its own sources under the cap", async () => {
    const s = makeStore()
    const sources = [1, 2, 3].map((i) => rec({ id: `e${i}`, effectiveAt: D(i) }))
    for (const r of sources) await s.put(r)
    const batch = selectConsolidationBatches(sources, { minBatchSize: 2, maxBatchSize: 50 })[0]!
    const summary = buildSummaryRecord(batch, "the week in one paragraph", D(4))
    await s.put(summary)
    for (const r of sources) await s.supersede(r.id, summary.id)

    // 4 episodic rows, cap 3 ⇒ exactly one eviction.
    const res = await s.prune({ now: D(9), cap: 3 })
    expect(res.deletedOverCap).toBe(1)
    // The summary survives; the OLDEST source is what goes.
    expect((await s.get(summary.id))?.id).toBe(summary.id)
    expect(await s.get("e1")).toBeNull()
    expect((await s.get("e2"))?.id).toBe("e2")
    expect((await s.get("e3"))?.id).toBe("e3")
  })
  it("is idempotent — a second identical prune deletes nothing", async () => {
    const s = makeStore()
    for (let i = 1; i <= 4; i++)
      await s.put(rec({ id: `e${i}`, effectiveAt: D(i), ...(i === 1 ? { expiresAt: D(2) } : {}) }))
    await s.prune({ now: D(5), cap: 2 })
    const second = await s.prune({ now: D(5), cap: 2 })
    expect(second).toEqual({ deletedExpired: 0, deletedOverCap: 0 })
  })
})
