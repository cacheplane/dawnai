import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sqliteCheckpointer } from "../src/checkpointer/index.js"

describe("DawnSqliteSaver", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-ckpt-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function newSaver() { return sqliteCheckpointer({ path: join(dir, "ckpt.sqlite") }) }

  it("put + getTuple round-trip preserves checkpoint payload", async () => {
    const saver = newSaver()
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const checkpoint = {
      v: 1,
      id: "ckpt-1",
      ts: "2026-05-22T00:00:00Z",
      channel_values: { messages: ["hi"] },
      channel_versions: { messages: 1 },
      versions_seen: {},
      pending_sends: [],
    }
    const metadata = { source: "input", step: 0, writes: null, parents: {} }
    await saver.put(config, checkpoint as never, metadata as never, {})
    const tuple = await saver.getTuple({
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "ckpt-1" },
    })
    expect(tuple).toBeDefined()
    expect(tuple?.checkpoint.id).toBe("ckpt-1")
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["hi"] })
  })

  it("getTuple without checkpoint_id returns the latest by checkpoint_id desc", async () => {
    const saver = newSaver()
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const mk = (id: string) => ({
      v: 1, id, ts: "x", channel_values: {}, channel_versions: {}, versions_seen: {}, pending_sends: [],
    })
    await saver.put(cfg, mk("a") as never, { source: "input", step: 0, writes: null, parents: {} } as never, {})
    await saver.put(cfg, mk("b") as never, { source: "input", step: 1, writes: null, parents: {} } as never, {})
    const t = await saver.getTuple(cfg)
    expect(t?.checkpoint.id).toBe("b")
  })

  it("list yields checkpoints in reverse id order", async () => {
    const saver = newSaver()
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const mk = (id: string) => ({
      v: 1, id, ts: "x", channel_values: {}, channel_versions: {}, versions_seen: {}, pending_sends: [],
    })
    await saver.put(cfg, mk("a") as never, { source: "input", step: 0, writes: null, parents: {} } as never, {})
    await saver.put(cfg, mk("b") as never, { source: "input", step: 1, writes: null, parents: {} } as never, {})
    const ids: string[] = []
    for await (const t of saver.list(cfg)) ids.push(t.checkpoint.id)
    expect(ids).toEqual(["b", "a"])
  })

  it("putWrites is idempotent on (thread_id, ns, ckpt_id, task_id, idx)", async () => {
    const saver = newSaver()
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "ckpt-1" } }
    await saver.putWrites(cfg, [["messages", "a"]], "task-1")
    await saver.putWrites(cfg, [["messages", "a"]], "task-1") // must not throw
    expect(true).toBe(true)
  })

  it("persists across saver instances (file-backed)", async () => {
    const path = join(dir, "ckpt.sqlite")
    const s1 = sqliteCheckpointer({ path })
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const c = { v: 1, id: "c1", ts: "x", channel_values: { x: 1 }, channel_versions: {}, versions_seen: {}, pending_sends: [] }
    await s1.put(cfg, c as never, { source: "input", step: 0, writes: null, parents: {} } as never, {})
    const s2 = sqliteCheckpointer({ path })
    const t = await s2.getTuple({ configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "c1" } })
    expect(t?.checkpoint.channel_values).toEqual({ x: 1 })
  })
})
