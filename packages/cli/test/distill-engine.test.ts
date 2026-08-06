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
  // A batch is an ATOM for idempotency: its summary id hashes its own source-id
  // list. If one source's link throws and aborts the rest, the survivors form a
  // DIFFERENT chunk next run — a different id, a second overlapping summary over
  // records the first one already covers. One transient error must not be able
  // to split a batch, so each source's link is isolated from its siblings.
  it("isolates a failing source link and still links the rest of the batch", async () => {
    const store = makeStore()
    for (const d of [1, 2, 3, 4, 5]) await store.put(ep(`e${d}`, d))
    const flaky = {
      ...store,
      supersede: async (id: string, by: string) => {
        if (id === "e2") throw new Error("link boom")
        await store.supersede(id, by)
      },
    }
    const invoke = vi.fn(async () => ({ content: '{"summary":"five runs"}' }))
    const res = await runConsolidation({
      store: flaky as typeof store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 1 }) // still a failed batch
    const expiry = new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString()
    for (const id of ["e1", "e3", "e4", "e5"]) {
      expect((await store.get(id))?.status).toBe("superseded")
      expect((await store.get(id))?.expiresAt).toBe(expiry)
    }
    // Only the source that actually failed is left behind — active (so recall
    // still sees it) and unstamped (nothing summarizes it, so nothing may reap it).
    expect((await store.get("e2"))?.status).toBe("active")
    expect((await store.get("e2"))?.expiresAt).toBeUndefined()
  })
  it("a failed source link cannot split the batch into a second overlapping summary", async () => {
    const store = makeStore()
    for (const d of [1, 2, 3, 4, 5]) await store.put(ep(`e${d}`, d))
    const flaky = {
      ...store,
      supersede: async (id: string, by: string) => {
        if (id === "e2") throw new Error("link boom")
        await store.supersede(id, by)
      },
    }
    const invoke = vi.fn(async () => ({ content: '{"summary":"five runs"}' }))
    const base = { config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) }
    await runConsolidation({ ...base, store: flaky as typeof store })
    await runConsolidation({ ...base, store }) // the store has healed
    const summaries = (await store.browse({ kind: "episodic" })).records.filter((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summaries.length).toBe(1) // no split chunk, no second overlapping summary
    expect(summaries[0]?.data.derivedFrom).toEqual(["e1", "e2", "e3", "e4", "e5"])
  })
  it("a wholly failed link phase re-runs as the SAME batch (same id, upsert) and completes", async () => {
    const store = makeStore()
    for (const d of [1, 2, 3, 4, 5]) await store.put(ep(`e${d}`, d))
    const broken = {
      ...store,
      supersede: async () => {
        throw new Error("link boom")
      },
    }
    const invoke = vi.fn(async () => ({ content: '{"summary":"five runs"}' }))
    const base = { config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) }
    const first = await runConsolidation({ ...base, store: broken as typeof store })
    expect(first.failed).toBe(1)
    const idAfterFirst = (await store.browse({ kind: "episodic" })).records.find((r) =>
      r.tags.includes("consolidated"),
    )?.id
    const second = await runConsolidation({ ...base, store }) // healed
    expect(second).toMatchObject({ batches: 1, written: 1, failed: 0 })
    const summaries = (await store.browse({ kind: "episodic" })).records.filter((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summaries.length).toBe(1)
    expect(summaries[0]?.id).toBe(idAfterFirst) // same batch → same id → upsert
    for (const d of [1, 2, 3, 4, 5]) expect((await store.get(`e${d}`))?.status).toBe("superseded")
  })
  // `--max-batches 0` is an explicit off switch, not an absence of work. Printing
  // "nothing to consolidate" over a real backlog tells the operator their memory
  // is compacted when it is not, and hides the one line that would explain why.
  it("--max-batches 0 reports the deferred work instead of claiming there is none", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn()
    const out: string[] = []
    const res = await runConsolidation({
      store,
      config: { ...CONFIG, maxBatches: 0 },
      now: NOW,
      io: { stdout: (m) => out.push(m), stderr: () => {} },
      createModel: async () => ({ invoke }),
    })
    expect(res).toMatchObject({ batches: 0, written: 0, failed: 0 })
    expect(invoke).not.toHaveBeenCalled()
    expect(out.join("\n")).toMatch(/1 more batch\(es\) not examined \(maxBatches\)/)
    expect(out.join("\n")).not.toMatch(/nothing to consolidate/)
  })
  it("still says nothing to consolidate when there is genuinely nothing", async () => {
    const store = makeStore()
    await store.put(ep("only", 7)) // below minBatchSize
    const out: string[] = []
    await runConsolidation({
      store,
      config: { ...CONFIG, maxBatches: 0 },
      now: NOW,
      io: { stdout: (m) => out.push(m), stderr: () => {} },
      createModel: async () => ({ invoke: vi.fn() }),
    })
    expect(out.join("\n")).toMatch(/nothing to consolidate/)
    expect(out.join("\n")).not.toMatch(/not examined/)
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
  // `browse`'s namespacePrefix is a PREFIX, not an equality filter, so a pass for
  // "route=/a" also sees every "route=/ab" row. Two independent guards keep the
  // namespaces apart — one in readWatermark, one in gatherNamespaceMemories — and
  // this test fails if EITHER is removed: delete the watermark guard and /ab's
  // far-future coveredUntil silences /a forever; delete the input guard and /ab's
  // memories get summarized into /a's insights.
  it("a sibling namespace sharing a prefix neither blocks nor pollutes this one", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    for (const r of [ep("b1", 7), ep("b2", 8)]) await store.put({ ...r, namespace: "route=/ab" })
    await store.put({
      id: "memory_rfl_sibling",
      kind: "reflection",
      namespace: "route=/ab",
      content: "a sibling insight",
      data: { coveredUntil: "2099-01-01T00:00:00.000Z" },
      source: { type: "tool", id: "reflect" },
      confidence: 0.9,
      tags: [],
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
      effectiveAt: NOW,
    })
    const prompts: string[] = []
    const invoke = vi.fn(async (p: string) => {
      prompts.push(p)
      return { content: '{"insights":[{"insight":"i","confidence":0.5,"tags":[]}]}' }
    })
    const res = await runReflection({
      store,
      config: CONFIG,
      now: NOW,
      io,
      createModel: async () => ({ invoke }),
    })
    // Guard 1 — /ab's 2099 watermark is not /a's: /a still reflects.
    expect(res).toMatchObject({ batches: 1, written: 1, failed: 0 })
    expect(invoke).toHaveBeenCalledTimes(1) // /ab itself IS silenced, by its own watermark
    const prompt = prompts[0] ?? ""
    expect(prompt).toContain("in namespace route=/a.")
    // Guard 2 — /ab's memories never enter /a's input.
    expect(prompt).toContain("run e1")
    expect(prompt).not.toContain("run b1")
    expect(prompt).not.toContain("run b2")
    expect(prompt).not.toContain("a sibling insight")
    const written = (await store.browse({ kind: "reflection", status: "candidate" })).records
    expect(written.map((r) => r.namespace)).toEqual(["route=/a"])
    expect(written[0]?.data.coveredUntil).toBe("2026-07-08T09:00:00.000Z")
  })
  it("--max-batches 0 reports the deferred namespaces instead of claiming there is none", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn()
    const out: string[] = []
    const res = await runReflection({
      store,
      config: { ...CONFIG, maxBatches: 0 },
      now: NOW,
      io: { stdout: (m) => out.push(m), stderr: () => {} },
      createModel: async () => ({ invoke }),
    })
    expect(res).toMatchObject({ batches: 0, written: 0, failed: 0 })
    expect(invoke).not.toHaveBeenCalled()
    expect(out.join("\n")).toMatch(/1 more namespace\(s\) not examined \(maxBatches\)/)
    expect(out.join("\n")).not.toMatch(/nothing to reflect on/)
  })
  it("still says nothing to reflect on when no namespace qualifies", async () => {
    const store = makeStore()
    await store.put(ep("only", 7)) // below minNewRecords
    const out: string[] = []
    await runReflection({
      store,
      config: CONFIG,
      now: NOW,
      io: { stdout: (m) => out.push(m), stderr: () => {} },
      createModel: async () => ({ invoke: vi.fn() }),
    })
    expect(out.join("\n")).toMatch(/nothing to reflect on/)
    expect(out.join("\n")).not.toMatch(/not examined/)
  })
  it("an empty insight list writes no insight", async () => {
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
    expect((await store.browse({ kind: "reflection", status: "active" })).total).toBe(0)
    expect((await store.browse({ kind: "reflection", status: "candidate" })).total).toBe(0)
  })
  // Without a watermark write, a namespace whose memories legitimately yield NO
  // durable insight is re-examined — and re-PAID for — on every single cron run,
  // forever. The pass is only cheap to re-run if it records that it happened.
  it("a zero-insight pass still advances the watermark, so the next pass makes no model call", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"insights":[]}' }))
    const args = { store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) }
    const first = await runReflection(args)
    expect(first).toMatchObject({ batches: 1, written: 0, failed: 0 })
    expect(invoke).toHaveBeenCalledTimes(1)
    const second = await runReflection(args)
    expect(second).toMatchObject({ batches: 0, written: 0, failed: 0 })
    expect(invoke).toHaveBeenCalledTimes(1) // the pass was NOT re-paid
    // The sentinel carries the watermark and nothing else: `superseded` keeps it
    // out of active-only recall, so it can never surface as a fake "insight".
    const reflections = (await store.browse({ kind: "reflection" })).records
    expect(reflections.length).toBe(1)
    expect(reflections[0]?.status).toBe("superseded")
    expect(reflections[0]?.data.coveredUntil).toBe("2026-07-08T09:00:00.000Z")
    expect(reflections[0]?.id).toMatch(/^memory_rfl_pass_[0-9a-f]{16}$/)
  })
  it("a later zero-insight pass advances the watermark again as new records arrive", async () => {
    const store = makeStore()
    for (const r of [ep("e1", 7), ep("e2", 8)]) await store.put(r)
    const invoke = vi.fn(async () => ({ content: '{"insights":[]}' }))
    const args = { store, config: CONFIG, now: NOW, io, createModel: async () => ({ invoke }) }
    await runReflection(args)
    for (const r of [ep("e3", 9), ep("e4", 9)]) await store.put({ ...r, id: `${r.id}x` })
    const second = await runReflection(args)
    expect(second.batches).toBe(1) // fresh records cross the threshold again
    const covered = (await store.browse({ kind: "reflection" })).records.map(
      (r) => r.data.coveredUntil,
    )
    expect(covered).toContain("2026-07-09T09:00:00.000Z")
  })
})
