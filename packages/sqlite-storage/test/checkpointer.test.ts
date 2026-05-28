import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, AIMessage } from "@langchain/core/messages"
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

  it("round-trips LangChain BaseMessage instances through checkpoint serde", async () => {
    // This test guards against the resume bug: plain JSON.parse loses BaseMessage
    // prototype chains, causing ToolNode.isMessagesState() to reject the input.
    // The saver must use JsonPlusSerializer (not plain JSON) to preserve instances.
    const saver = newSaver()
    const human = new HumanMessage("hello")
    const ai = new AIMessage({ content: "hi", tool_calls: [{ name: "runBash", args: { command: "echo hi" }, id: "call_1" }] })
    const cfg = { configurable: { thread_id: "t-msg", checkpoint_ns: "" } }
    const checkpoint = {
      v: 1,
      id: "ckpt-msg",
      ts: "2026-05-28T00:00:00Z",
      channel_values: { messages: [human, ai] },
      channel_versions: { messages: 3, "branch:to:tools": 3 },
      versions_seen: { agent: { "branch:to:agent": 2 } },
      pending_sends: [],
    }
    await saver.put(cfg, checkpoint as never, { source: "loop", step: 1, writes: null, parents: {} } as never, {})

    // Also store a pending write (the interrupt) — must also survive serde
    await saver.putWrites(
      { configurable: { thread_id: "t-msg", checkpoint_ns: "", checkpoint_id: "ckpt-msg" } },
      [["__interrupt__", { id: "test-interrupt", value: "perm-request" }]],
      "tools-task-1",
    )

    const tuple = await saver.getTuple({
      configurable: { thread_id: "t-msg", checkpoint_ns: "", checkpoint_id: "ckpt-msg" },
    })

    expect(tuple).toBeDefined()
    const msgs = tuple!.checkpoint.channel_values.messages as unknown[]
    expect(msgs).toHaveLength(2)

    // The deserialized messages must be actual BaseMessage instances
    // (not plain JSON objects) so that ToolNode's isBaseMessage() passes.
    const { isBaseMessage } = await import("@langchain/core/messages")
    expect(isBaseMessage(msgs[0])).toBe(true)
    expect(isBaseMessage(msgs[1])).toBe(true)

    // Check that the AI message still has its tool_calls intact
    const aiMsg = msgs[1] as AIMessage
    expect(aiMsg.tool_calls?.[0]?.name).toBe("runBash")

    // Pending writes must also round-trip correctly
    expect(tuple!.pendingWrites).toHaveLength(1)
    const [taskId, channel, value] = tuple!.pendingWrites![0]
    expect(taskId).toBe("tools-task-1")
    expect(channel).toBe("__interrupt__")
    expect((value as Record<string, unknown>).id).toBe("test-interrupt")
  })
})
