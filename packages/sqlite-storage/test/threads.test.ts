import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createThreadsStore } from "../src/threads/index.js"

describe("createThreadsStore", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-threads-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function newStore() { return createThreadsStore({ path: join(dir, "threads.sqlite") }) }

  it("create + get round-trips metadata and assigns timestamps", async () => {
    const store = newStore()
    const t = await store.createThread({ metadata: { user: "brian" } })
    expect(t.thread_id).toMatch(/^t-/)
    expect(t.status).toBe("idle")
    expect(t.metadata).toEqual({ user: "brian" })
    const fetched = await store.getThread(t.thread_id)
    expect(fetched?.thread_id).toBe(t.thread_id)
    expect(fetched?.metadata).toEqual({ user: "brian" })
  })

  it("accepts explicit thread_id", async () => {
    const store = newStore()
    const t = await store.createThread({ thread_id: "t-explicit" })
    expect(t.thread_id).toBe("t-explicit")
  })

  it("getThread returns undefined for unknown id", async () => {
    const store = newStore()
    expect(await store.getThread("t-missing")).toBeUndefined()
  })

  it("deleteThread removes the thread", async () => {
    const store = newStore()
    const t = await store.createThread({})
    await store.deleteThread(t.thread_id)
    expect(await store.getThread(t.thread_id)).toBeUndefined()
  })

  it("listThreads returns most-recently-updated first", async () => {
    const store = newStore()
    const a = await store.createThread({ thread_id: "t-a" })
    await new Promise((r) => setTimeout(r, 10))
    const b = await store.createThread({ thread_id: "t-b" })
    const list = await store.listThreads()
    expect(list[0]?.thread_id).toBe(b.thread_id)
    expect(list[1]?.thread_id).toBe(a.thread_id)
  })
})
