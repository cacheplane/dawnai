// Guard tests for the distillation engine. Unlike distill-engine.test.ts (which
// pins the engine's behavioural contract), this file exists solely to pin three
// findings from the D5 robustness review, so that the defensive code they cover
// is never deleted as "redundant". `resolveDistillConfig` does NO range
// validation by design — every bound is enforced at use-site in
// src/lib/memory/distill.ts, and each guard below prevents a specific hazard
// that was reproduced before the guard was written:
//
//   1. `maxBatchSize` < 1 HANGS THE PROCESS. selectConsolidationBatches advances
//      its chunk loop with `i += maxBatchSize`, so 0 or a negative never
//      terminates. It is a synchronous loop, so vitest's per-test timeout cannot
//      interrupt it — the observed failure mode is a run that produces no output
//      and never exits, not a failing test. Hence `positiveInt` (integer >= 1,
//      non-finite falls back to the documented default).
//   2. A negative `maxBatches` SLICES FROM THE WRONG END. `batches.slice(0, -2)`
//      silently drops the tail and processes a different set than requested,
//      spending model calls the operator did not ask for. `batchLimit` therefore
//      clamps to >= 0 (0 and negatives mean "do nothing"; NaN fails closed so a
//      config typo cannot authorize an unbounded model spend; Infinity stays
//      unlimited). A negative `reflect.maxRecords` has the same wrong-end bug
//      inside selectReflectionInput's `slice(0, n)`.
//   3. BROWSE TRUNCATION DROPS THE OLDEST RECORDS. `browse` orders
//      `updated_at DESC`, so capping a scan at MAX_SCAN_RECORDS keeps the NEWEST
//      window and silently skips the oldest rows — exactly the ones most due for
//      consolidation. `gatherRecords` detects truncation and re-queries with
//      `offset: total - MAX_SCAN_RECORDS` to take the oldest window instead,
//      reporting the skip on stderr. Reflection deliberately keeps the newest
//      window (selectReflectionInput caps to the newest `maxRecords` anyway).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BrowseQuery, type MemoryRecord, sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runConsolidation, runReflection } from "../src/lib/memory/distill.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-distill-clamp-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function ep(id: string, day: number, namespace = "route=/a"): MemoryRecord {
  const at = `2026-07-0${day}T09:00:00.000Z`
  return {
    id,
    kind: "episodic",
    namespace,
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

async function seedThreeNamespaces() {
  const store = makeStore()
  for (const ns of ["route=/a", "route=/b", "route=/c"]) {
    for (const d of [7, 8]) await store.put(ep(`${ns}-${d}`, d, ns))
  }
  return store
}

describe("maxBatches clamping", () => {
  it("treats 0 as an off switch — no batches, no model call", async () => {
    const store = await seedThreeNamespaces()
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, maxBatches: 0 },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(res).toMatchObject({ batches: 0, written: 0, failed: 0 })
  })
  it("treats a negative as 0 rather than slicing from the end", async () => {
    const store = await seedThreeNamespaces()
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, maxBatches: -2 },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(res.batches).toBe(0)
  })
  it("truncates a non-integer", async () => {
    const store = await seedThreeNamespaces()
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, maxBatches: 2.7 },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(res.batches).toBe(2)
  })
  it("fails closed on NaN — no unbounded model spend on a typo", async () => {
    const store = await seedThreeNamespaces()
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, maxBatches: Number.NaN },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(res.batches).toBe(0)
  })
  it("caps reflection namespaces too — a namespace is a batch", async () => {
    const store = await seedThreeNamespaces()
    const invoke = vi.fn(async () => ({
      content: '{"insights":[{"insight":"x","confidence":0.5,"tags":[]}]}',
    }))
    const res = await runReflection({
      store,
      config: { ...CONFIG, maxBatches: 1 },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
  })
})

describe("batch-size clamping", () => {
  it("does not hang when maxBatchSize is 0 (chunk loop would never advance)", async () => {
    const store = makeStore()
    for (const d of [7, 8]) await store.put(ep(`e${d}`, d))
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, consolidate: { ...CONFIG.consolidate, maxBatchSize: 0 } },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    // Clamped to 1 → one single-record batch per record, both processed.
    expect(res).toMatchObject({ batches: 2, written: 2, failed: 0 })
  }, 10_000)
  it("does not hang when maxBatchSize is negative", async () => {
    const store = makeStore()
    for (const d of [7, 8]) await store.put(ep(`e${d}`, d))
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, consolidate: { ...CONFIG.consolidate, maxBatchSize: -5 } },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(res.failed).toBe(0)
    expect(res.written).toBe(2)
  }, 10_000)
  it("falls back to the documented default when a size is NaN", async () => {
    const store = makeStore()
    for (const d of [7, 8]) await store.put(ep(`e${d}`, d))
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: {
        ...CONFIG,
        consolidate: { ...CONFIG.consolidate, maxBatchSize: Number.NaN },
      },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    // default maxBatchSize 50 → the two records stay in one batch
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
  }, 10_000)
  it("keeps reflection input when maxRecords is negative (slice from the wrong end)", async () => {
    const store = makeStore()
    for (const d of [7, 8]) await store.put(ep(`e${d}`, d))
    const invoke = vi.fn(async () => ({
      content: '{"insights":[{"insight":"x","confidence":0.5,"tags":[]}]}',
    }))
    const res = await runReflection({
      store,
      config: { ...CONFIG, reflect: { ...CONFIG.reflect, maxRecords: -5 } },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
  })
  it("does not throw on a non-finite olderThanMs", async () => {
    const store = makeStore()
    for (const d of [7, 8]) await store.put(ep(`e${d}`, d))
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, consolidate: { ...CONFIG.consolidate, olderThanMs: Number.NaN } },
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    // falls back to the 7-day default; the records are ~12 days old → still eligible
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
  })
})

describe("browse ceiling", () => {
  it("seeks the OLDEST window when the scan ceiling truncates, and says so", async () => {
    const real = makeStore()
    for (const d of [7, 8]) await real.put(ep(`e${d}`, d))
    const queries: BrowseQuery[] = []
    // Pretend the store holds far more matching rows than the ceiling: browse is
    // updated_at DESC, so the first page is the NEWEST window and the oldest rows
    // — the ones most due for consolidation — would silently never be considered.
    const truncating = {
      ...real,
      browse: async (q: BrowseQuery = {}) => {
        queries.push(q)
        const page = await real.browse(q)
        return { records: page.records, total: 10_002 }
      },
    }
    const errors: string[] = []
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    await runConsolidation({
      store: truncating as typeof real,
      config: CONFIG,
      now: NOW,
      io: { stdout: () => {}, stderr: (m) => errors.push(m) },
      createModel: async () => ({ invoke }),
    })
    expect(queries.length).toBe(2)
    expect(queries[0]?.limit).toBe(10_000)
    expect(queries[0]?.offset).toBeUndefined()
    expect(queries[1]?.offset).toBe(2) // total - ceiling → the oldest window
    expect(errors.join("")).toMatch(/only the oldest .* were considered/)
  })

  it("does not issue a second query when nothing is truncated", async () => {
    const real = makeStore()
    for (const d of [7, 8]) await real.put(ep(`e${d}`, d))
    const queries: BrowseQuery[] = []
    const counting = {
      ...real,
      browse: async (q: BrowseQuery = {}) => {
        queries.push(q)
        return await real.browse(q)
      },
    }
    const errors: string[] = []
    const invoke = vi.fn(async () => ({ content: '{"summary":"ok"}' }))
    const res = await runConsolidation({
      store: counting as typeof real,
      config: CONFIG,
      now: NOW,
      io: { stdout: () => {}, stderr: (m) => errors.push(m) },
      createModel: async () => ({ invoke }),
    })
    expect(queries.length).toBe(1)
    expect(errors).toEqual([])
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
  })
})
