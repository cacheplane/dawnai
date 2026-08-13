import type { Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import { expect, test } from "vitest"

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const GENERATED_ID = /^t-[0-9a-f]{8}$/

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Timestamps are app-generated ISO strings; compare as instants, not bytes. */
const at = (t: Thread | undefined, field: "created_at" | "updated_at"): number =>
  Date.parse((t as Thread)[field])

/**
 * The contract every ThreadsStore must satisfy. Run against the sqlite store
 * (in-process, always) and any other backend (e.g. Postgres, gated) so they
 * cannot drift. Pass vitest's `describe`; `makeStore` returns a FRESH empty
 * store per call.
 *
 * Everything here goes through the public interface — never the tables — so a
 * backend is free to choose its own column types (sqlite keeps `metadata` as a
 * TEXT blob, Postgres as `jsonb`) as long as the observable behavior matches.
 */
export function runThreadsStoreConformance(opts: {
  readonly name: string
  readonly makeStore: () => Promise<ThreadsStore> | ThreadsStore
  readonly describe: (name: string, fn: () => void) => void
  readonly close?: (store: ThreadsStore) => Promise<void> | void
}): void {
  const { name, makeStore, describe, close } = opts
  describe(`ThreadsStore conformance: ${name}`, () => {
    test("createThread + getThread round-trips id, metadata and status", async () => {
      const s = await makeStore()
      try {
        const created = await s.createThread({ metadata: { user: "brian" } })
        expect(created.status).toBe("idle")
        expect(created.metadata).toEqual({ user: "brian" })
        const fetched = await s.getThread(created.thread_id)
        expect(fetched?.thread_id).toBe(created.thread_id)
        expect(fetched?.metadata).toEqual({ user: "brian" })
        expect(fetched?.status).toBe("idle")
      } finally {
        await close?.(s)
      }
    })
    test("createThread's return value matches what getThread reads back", async () => {
      const s = await makeStore()
      try {
        // The store synthesizes the returned Thread rather than re-reading the
        // row; "synthesized" is only observable as exact equality with the
        // stored row, so that is what the contract pins.
        const created = await s.createThread({ thread_id: "t-synth", metadata: { a: 1 } })
        expect(await s.getThread("t-synth")).toEqual(created)
      } finally {
        await close?.(s)
      }
    })
    test("createThread honors an explicit thread_id", async () => {
      const s = await makeStore()
      try {
        const created = await s.createThread({ thread_id: "t-explicit" })
        expect(created.thread_id).toBe("t-explicit")
        expect((await s.getThread("t-explicit"))?.thread_id).toBe("t-explicit")
      } finally {
        await close?.(s)
      }
    })
    test("generated ids are t- plus 8 lowercase hex digits, and are unique", async () => {
      const s = await makeStore()
      try {
        const a = await s.createThread({})
        const b = await s.createThread({})
        expect(a.thread_id).toMatch(GENERATED_ID)
        expect(b.thread_id).toMatch(GENERATED_ID)
        expect(a.thread_id).not.toBe(b.thread_id)
      } finally {
        await close?.(s)
      }
    })
    test("metadata defaults to an empty object when omitted", async () => {
      const s = await makeStore()
      try {
        const created = await s.createThread({})
        expect(created.metadata).toEqual({})
        expect((await s.getThread(created.thread_id))?.metadata).toEqual({})
      } finally {
        await close?.(s)
      }
    })
    test("timestamps are ISO-8601 strings, equal at creation", async () => {
      const s = await makeStore()
      try {
        const created = await s.createThread({})
        expect(created.created_at).toMatch(ISO_MS)
        expect(created.updated_at).toMatch(ISO_MS)
        expect(created.updated_at).toBe(created.created_at)
        const fetched = await s.getThread(created.thread_id)
        expect(fetched?.created_at).toMatch(ISO_MS)
        expect(fetched?.updated_at).toMatch(ISO_MS)
      } finally {
        await close?.(s)
      }
    })
    test("getThread returns undefined for a missing id", async () => {
      const s = await makeStore()
      try {
        expect(await s.getThread("t-missing")).toBeUndefined()
      } finally {
        await close?.(s)
      }
    })
    test("deleteThread removes the thread and is idempotent", async () => {
      const s = await makeStore()
      try {
        const created = await s.createThread({})
        await s.deleteThread(created.thread_id)
        expect(await s.getThread(created.thread_id)).toBeUndefined()
        await s.deleteThread(created.thread_id) // second delete must not throw
        await s.deleteThread("t-never-existed") // nor must an unknown id
        expect(await s.listThreads()).toEqual([])
      } finally {
        await close?.(s)
      }
    })
    test("listThreads returns an empty list on an empty store", async () => {
      const s = await makeStore()
      try {
        expect(await s.listThreads()).toEqual([])
      } finally {
        await close?.(s)
      }
    })
    test("listThreads is ordered updated_at DESC and reorders after an update", async () => {
      const s = await makeStore()
      try {
        await s.createThread({ thread_id: "t-a" })
        await sleep(5)
        await s.createThread({ thread_id: "t-b" })
        expect((await s.listThreads()).map((t) => t.thread_id)).toEqual(["t-b", "t-a"])
        await sleep(5)
        await s.updateStatus("t-a", "busy")
        expect((await s.listThreads()).map((t) => t.thread_id)).toEqual(["t-a", "t-b"])
      } finally {
        await close?.(s)
      }
    })
    test("updateStatus changes the status and bumps updated_at, leaving created_at", async () => {
      const s = await makeStore()
      try {
        const created = await s.createThread({ thread_id: "t-st" })
        await sleep(5)
        await s.updateStatus("t-st", "interrupted")
        const fetched = await s.getThread("t-st")
        expect(fetched?.status).toBe("interrupted")
        expect(at(fetched, "updated_at")).toBeGreaterThan(Date.parse(created.updated_at))
        expect(fetched?.created_at).toBe(created.created_at)
      } finally {
        await close?.(s)
      }
    })
    test("updateStatus is a silent no-op for a missing thread", async () => {
      const s = await makeStore()
      try {
        await s.updateStatus("t-missing", "busy")
        expect(await s.getThread("t-missing")).toBeUndefined()
      } finally {
        await close?.(s)
      }
    })
    test("updateMetadata merges SHALLOWLY — a nested object is replaced wholesale", async () => {
      const s = await makeStore()
      try {
        await s.createThread({
          thread_id: "t-meta",
          metadata: { user: "brian", nested: { keep: 1, drop: 2 } },
        })
        await s.updateMetadata("t-meta", { route: "/chat#agent", nested: { keep: 9 } })
        // A deep merge would leave `drop: 2` behind. Shallow merge replaces the
        // whole `nested` value — that difference is the contract.
        expect((await s.getThread("t-meta"))?.metadata).toEqual({
          user: "brian",
          route: "/chat#agent",
          nested: { keep: 9 },
        })
      } finally {
        await close?.(s)
      }
    })
    test("updateMetadata bumps updated_at (so listThreads reorders)", async () => {
      const s = await makeStore()
      try {
        const created = await s.createThread({ thread_id: "t-mts" })
        await sleep(5)
        await s.updateMetadata("t-mts", { route: "/chat#agent" })
        const fetched = await s.getThread("t-mts")
        expect(at(fetched, "updated_at")).toBeGreaterThan(Date.parse(created.updated_at))
        expect(fetched?.created_at).toBe(created.created_at)
      } finally {
        await close?.(s)
      }
    })
    test("updateMetadata with an empty patch keeps the existing metadata", async () => {
      const s = await makeStore()
      try {
        await s.createThread({ thread_id: "t-empty", metadata: { user: "brian" } })
        await s.updateMetadata("t-empty", {})
        expect((await s.getThread("t-empty"))?.metadata).toEqual({ user: "brian" })
      } finally {
        await close?.(s)
      }
    })
    test("updateMetadata is a silent no-op for a missing thread", async () => {
      const s = await makeStore()
      try {
        await s.updateMetadata("t-missing", { route: "/chat#agent" })
        expect(await s.getThread("t-missing")).toBeUndefined()
      } finally {
        await close?.(s)
      }
    })
    test("a duplicate createThread does not corrupt state", async () => {
      const s = await makeStore()
      try {
        // DELIBERATELY not asserting that the second create throws. sqlite's
        // bare INSERT does, but callers check-then-create (a race across
        // instances), so a multi-writer backend is expected to use an atomic
        // upsert that returns the existing row instead. Both outcomes are
        // conformant; what must hold is that exactly one intact thread remains.
        await s.createThread({ thread_id: "t-dup", metadata: { v: 1 } })
        await s.createThread({ thread_id: "t-dup", metadata: { v: 2 } }).catch(() => undefined)
        const all = await s.listThreads()
        expect(all.filter((t) => t.thread_id === "t-dup")).toHaveLength(1)
        const fetched = await s.getThread("t-dup")
        expect(fetched?.status).toBe("idle")
        expect(fetched?.created_at).toMatch(ISO_MS)
        // WHICH metadata survives is not "either one" — it is pinned by the
        // next case, which is stricter than anything that belongs here.
      } finally {
        await close?.(s)
      }
    })
    test("a colliding createThread never applies the caller's metadata", async () => {
      const s = await makeStore()
      try {
        // The two conformant outcomes above diverge by backend: sqlite's bare
        // INSERT throws, a multi-writer backend upserts and hands back the row
        // that is already there. The THIRD outcome — the caller's metadata
        // overwriting the stored row's — is not conformant on either.
        //
        // Thread ids are `t-` plus four random bytes, so collisions are a
        // 32-bit birthday problem, not a hypothetical. Dawn stores each
        // thread's authorization stamp under a reserved metadata key, so a
        // store that let a second create rewrite metadata would let whoever
        // draws (or guesses) a live id restamp someone else's thread and then
        // read it legally.
        await s.createThread({ thread_id: "t-collide", metadata: { owner: "first" } })
        await s
          .createThread({ thread_id: "t-collide", metadata: { owner: "second" } })
          .catch(() => undefined)
        expect((await s.getThread("t-collide"))?.metadata).toEqual({ owner: "first" })
      } finally {
        await close?.(s)
      }
    })
    test("updateMetadata leaves a top-level key the patch does not name intact", async () => {
      const s = await makeStore()
      try {
        // The companion to the shallow-merge case above. That one pins what a
        // patch REPLACES; this one pins what it must not touch.
        //
        // `dawn:access` is the reserved key Dawn's thread-access stamp lives
        // under (`THREAD_ACCESS_METADATA_KEY`), written once at create and
        // never again. Every later `route` and `parked_route` write is a patch
        // like the two below. If a patch could drop an unrelated key, a thread
        // would silently lose its stamp on its next run and read back as an
        // unstamped legacy thread — which a policy is entitled to treat as
        // admin-only, or as nobody's.
        await s.createThread({
          thread_id: "t-untouched",
          metadata: { "dawn:access": { ownerId: "u-1" }, user: "brian" },
        })
        await s.updateMetadata("t-untouched", { route: "/chat#agent" })
        await s.updateMetadata("t-untouched", { parked_route: "/chat#agent" })
        expect((await s.getThread("t-untouched"))?.metadata).toEqual({
          "dawn:access": { ownerId: "u-1" },
          parked_route: "/chat#agent",
          route: "/chat#agent",
          user: "brian",
        })
      } finally {
        await close?.(s)
      }
    })
    test("threads are independent: deleting one leaves the others intact", async () => {
      const s = await makeStore()
      try {
        await s.createThread({ thread_id: "t-1", metadata: { keep: true } })
        await s.createThread({ thread_id: "t-2" })
        await s.deleteThread("t-2")
        expect((await s.getThread("t-1"))?.metadata).toEqual({ keep: true })
        expect((await s.listThreads()).map((t) => t.thread_id)).toEqual(["t-1"])
      } finally {
        await close?.(s)
      }
    })
  })
}
