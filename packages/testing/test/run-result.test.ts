import { expect, it } from "vitest"
import { collectRunResult } from "../src/run-result.js"

async function* fakeStream() {
  yield { type: "tool_call", name: "applyFilter", input: { status: "open" } }
  yield { type: "tool_result", name: "applyFilter", output: { matched: 2 } }
  yield { type: "chunk", data: "Found " }
  yield { type: "chunk", data: "2." }
  yield {
    type: "done",
    output: {
      messages: [{ id: ["x", "y", "AIMessage"], kwargs: { content: "Found 2." } }],
      runningSummary: null,
    },
  }
}

it("reduces a stream into an AgentRunResult", async () => {
  const r = await collectRunResult(fakeStream() as never, "thread-1")
  expect(r.threadId).toBe("thread-1")
  expect(r.tokens).toEqual(["Found ", "2."])
  expect(r.finalMessage).toBe("Found 2.")
  expect(r.toolCalls).toEqual([{ name: "applyFilter", args: { status: "open" }, id: undefined }])
  expect(r.messages).toHaveLength(1)
})

it("handles an empty/aborted stream", async () => {
  async function* empty() {}
  const r = await collectRunResult(empty() as never, "t")
  expect(r.tokens).toEqual([])
  expect(r.finalMessage).toBe("")
  expect(r.messages).toEqual([])
})

it("normalizes wrapped/stringified tool-call args", async () => {
  async function* s() {
    yield { type: "tool_call", name: "applyFilter", input: { input: '{"status":"open"}' } }
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.toolCalls[0]).toMatchObject({ name: "applyFilter", args: { status: "open" } })
})

it("passes through already-parsed tool-call args", async () => {
  async function* s() {
    yield { type: "tool_call", name: "t", input: { a: 1 } }
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.toolCalls[0]?.args).toEqual({ a: 1 })
})

it("captures interrupts, plan updates, and folds subagent events", async () => {
  async function* s() {
    yield { type: "interrupt", data: { interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } } }
    yield { type: "plan_update", data: { todos: [{ content: "A", status: "pending" }] } }
    yield { type: "plan_update", data: { todos: [{ content: "A", status: "completed" }] } }
    yield { type: "subagent.start", data: { call_id: "c1", subagent: "research" } }
    yield { type: "subagent.tool_call", data: { call_id: "c1", tool: "webSearch", input: { q: "x" } } }
    yield { type: "subagent.end", data: { call_id: "c1", final_message: "found it" } }
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.interrupts).toEqual([{ interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } }])
  expect(r.planUpdates).toHaveLength(2)
  expect(r.todos).toEqual([{ content: "A", status: "completed" }])
  expect(r.subagents).toHaveLength(1)
  expect(r.subagents[0]).toMatchObject({ name: "research", callId: "c1", finalMessage: "found it" })
  expect(r.subagents[0]?.toolCalls).toEqual([{ name: "webSearch", args: { q: "x" } }])
  expect(r.subagentEvents.length).toBeGreaterThanOrEqual(3)
})
it("captures a subagent error end", async () => {
  async function* s() {
    yield { type: "subagent.start", data: { call_id: "c1", subagent: "research" } }
    yield { type: "subagent.end", data: { call_id: "c1", error: "boom" } }
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.subagents[0]).toMatchObject({ name: "research", error: "boom" })
})
it("defaults the new fields to empty when absent", async () => {
  async function* s() { yield { type: "done", output: { messages: [] } } }
  const r = await collectRunResult(s() as never, "t")
  expect(r.interrupts).toEqual([]); expect(r.planUpdates).toEqual([]); expect(r.todos).toEqual([])
  expect(r.subagents).toEqual([]); expect(r.systemPrompt).toBe("")
})
