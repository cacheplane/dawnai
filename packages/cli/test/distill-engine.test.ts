import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MemoryRecord, sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runConsolidation, runReflection } from "../src/lib/memory/distill.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-distill-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function ep(id: string, day: number): MemoryRecord {
  const at = `2026-07-0${day}T09:00:00.000Z`
  return {
    id,
    kind: "episodic",
    namespace: "route=/a",
    content: `run ${id}`,
    data: {},
    source: { type: "run", id },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: at,
    updatedAt: at,
    effectiveAt: at,
  }
}
const CONFIG = {
  model: "stub",
  provider: "openai",
  maxBatches: 5,
  consolidate: { olderThanMs: 0, minBatchSize: 2, maxBatchSize: 50 },
  reflect: { minNewRecords: 2, maxRecords: 100, writes: "candidate" as const },
}
const NOW = "2026-07-20T00:00:00.000Z"
const io = { stdout: () => {}, stderr: () => {} }

describe("runConsolidation", () => {
  it("dry-run makes ZERO model calls and writes nothing", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn()
    const res = await runConsolidation({
      store,
      config: CONFIG,
      now: NOW,
      io,
      dryRun: true,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(res.written).toBe(0)
    expect((await store.browse({ kind: "episodic" })).total).toBe(2)
    expect(res.batches).toBe(1)
  })
  it("exits cleanly when nothing qualifies", async () => {
    const store = makeStore()
    await store.put(ep("only", 7)) // below minBatchSize
    const invoke = vi.fn()
    const res = await runConsolidation({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(res).toMatchObject({ batches: 0, written: 0, failed: 0 })
  })
  it("writes the summary and supersedes EXACTLY the batch's sources", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    await store.put({ ...ep("other", 9), namespace: "route=/b" }) // different namespace, untouched
    const invoke = vi.fn(async () => ({ content: '{"summary":"two runs"}' }))
    const res = await runConsolidation({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await store.get("e1"))?.status).toBe("superseded")
    expect((await store.get("e2"))?.status).toBe("superseded")
    expect((await store.get("other"))?.status).toBe("active")
    const summaries = (await store.browse({ status: "active", kind: "episodic" })).records.filter(
      (r) => r.tags.includes("consolidated"),
    )
    expect(summaries.length).toBe(1)
    expect(summaries[0]?.data.derivedFrom).toEqual(["e1", "e2"])
  })
  it("write-then-link: a supersede failure leaves the summary written and sources ACTIVE, and reports failure", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const broken = {
      ...store,
      supersede: async () => {
        throw new Error("supersede boom")
      },
    }
    const invoke = vi.fn(async () => ({ content: '{"summary":"s"}' }))
    const res = await runConsolidation({
      store: broken as typeof store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(res.failed).toBe(1)
    expect((await store.get("e1"))?.status).toBe("active")
    // …and UNTOUCHED: expiry is stamped only on a source that was actually
    // superseded. Stamping a still-active source would schedule the deletion of
    // a record nothing summarizes.
    expect((await store.get("e1"))?.expiresAt).toBeUndefined()
    expect((await store.get("e2"))?.expiresAt).toBeUndefined()
    const summaries = (await store.browse({ kind: "episodic" })).records.filter((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summaries.length).toBe(1) // the write survived; only linking failed
  })
  // Without this, superseded sources keep their slice of the per-namespace cap
  // budget forever (nothing else stamps an expiry on them), so the cap keeps
  // reaping rows even though the batch has already been compacted.
  it("stamps the default source TTL on every superseded source, and none on the summary", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"summary":"two runs"}' }))
    await runConsolidation({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    const expected = new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString()
    expect((await store.get("e1"))?.expiresAt).toBe(expected)
    expect((await store.get("e2"))?.expiresAt).toBe(expected)
    // The expiry rides alongside the supersede — it does not undo it.
    expect((await store.get("e1"))?.status).toBe("superseded")
    const summary = (await store.browse({ kind: "episodic" })).records.find((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summary?.expiresAt).toBeUndefined() // no consolidate.ttlMs configured
  })
  it("honors a configured consolidate.sourceTtlMs", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"summary":"two runs"}' }))
    await runConsolidation({
      store,
      config: { ...CONFIG, consolidate: { ...CONFIG.consolidate, sourceTtlMs: 3_600_000 } },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect((await store.get("e1"))?.expiresAt).toBe(
      new Date(Date.parse(NOW) + 3_600_000).toISOString(),
    )
  })
  it("isolates a failing batch and still processes the next", async () => {
    const store = makeStore()
    for (const r of [ep("a1", 7), ep("a2", 8)]) await store.put(r)
    for (const r of [
      { ...ep("b1", 7), namespace: "route=/b" },
      { ...ep("b2", 8), namespace: "route=/b" },
    ])
      await store.put(r)
    let call = 0
    const invoke = vi.fn(async () => {
      call += 1
      if (call === 1) throw new Error("model boom")
      return { content: '{"summary":"ok"}' }
    })
    const res = await runConsolidation({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(res).toMatchObject({ batches: 2, written: 1, failed: 1 })
  })
  it("honors maxBatches", async () => {
    const store = makeStore()
    for (const ns of ["route=/a", "route=/b", "route=/c"]) {
      for (const d of [7, 8]) await store.put({ ...ep(`${ns}-${d}`, d), namespace: ns })
    }
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, maxBatches: 2 },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(res.written).toBe(2)
  })
  it("is idempotent — a second identical run writes no duplicate summary", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"summary":"same"}' }))
    const args = { store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) }
    await runConsolidation(args)
    const second = await runConsolidation(args) // sources now superseded → nothing qualifies
    expect(second.batches).toBe(0)
    const summaries = (await store.browse({ kind: "episodic" })).records.filter((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summaries.length).toBe(1)
  })
})

describe("runReflection", () => {
  it("writes candidate insights carrying the watermark and skips below threshold on re-run", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({
      content: '{"insights":[{"insight":"fridays are risky","confidence":0.6,"tags":["ops"]}]}',
    }))
    const first = await runReflection({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(first.written).toBe(1)
    const insights = (await store.browse({ kind: "reflection" })).records
    expect(insights[0]?.status).toBe("candidate")
    expect(insights[0]?.data.coveredUntil).toBe("2026-07-08T09:00:00.000Z")
    const second = await runReflection({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(second.written).toBe(0) // watermark consumed the input
  })
  it("writes active insights when configured", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({
      content: '{"insights":[{"insight":"x","confidence":0.5,"tags":[]}]}',
    }))
    await runReflection({
      store,
      config: { ...CONFIG, reflect: { ...CONFIG.reflect, writes: "auto" } },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect((await store.browse({ kind: "reflection" })).records[0]?.status).toBe("active")
  })
  it("an empty insight list is a clean no-write", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"insights":[]}' }))
    const res = await runReflection({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(res).toMatchObject({ written: 0, failed: 0 })
  })
})
