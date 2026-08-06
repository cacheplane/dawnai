import { describe, expect, it } from "vitest"
import { collectRunResult, deriveToolResults } from "../src/run-result.js"

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
    yield {
      type: "interrupt",
      data: { interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } },
    }
    yield { type: "plan_update", data: { todos: [{ content: "A", status: "pending" }] } }
    yield { type: "plan_update", data: { todos: [{ content: "A", status: "completed" }] } }
    const child = { call_id: "c1", subagent: "research", route_id: "/research", depth: 1 }
    yield { type: "subagent.start", data: child }
    yield {
      type: "subagent.tool_call",
      data: { ...child, id: "tool-run-1", tool: "webSearch", input: { q: "x" } },
    }
    yield { type: "subagent.message", data: { ...child, chunk: "Inspecting" } }
    yield {
      type: "subagent.tool_result",
      data: { ...child, id: "tool-run-1", tool: "webSearch", output: ["result"] },
    }
    yield {
      type: "subagent.memory.recalled",
      data: { ...child, memories: [{ id: "memory-1" }] },
    }
    yield { type: "subagent.end", data: { ...child, final_message: "found it" } }
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.interrupts).toEqual([
    { interruptId: "perm-1", kind: "command", detail: { command: "rm -rf tmp" } },
  ])
  expect(r.planUpdates).toHaveLength(2)
  expect(r.todos).toEqual([{ content: "A", status: "completed" }])
  expect(r.subagents).toHaveLength(1)
  expect(r.subagents[0]).toMatchObject({ name: "research", callId: "c1", finalMessage: "found it" })
  expect(r.subagents[0]?.toolCalls).toEqual([{ name: "webSearch", args: { q: "x" } }])
  expect(r.subagentEvents).toEqual([
    {
      type: "subagent.start",
      data: { call_id: "c1", subagent: "research", route_id: "/research", depth: 1 },
    },
    {
      type: "subagent.tool_call",
      data: {
        call_id: "c1",
        subagent: "research",
        route_id: "/research",
        depth: 1,
        id: "tool-run-1",
        tool: "webSearch",
        input: { q: "x" },
      },
    },
    {
      type: "subagent.message",
      data: {
        call_id: "c1",
        subagent: "research",
        route_id: "/research",
        depth: 1,
        chunk: "Inspecting",
      },
    },
    {
      type: "subagent.tool_result",
      data: {
        call_id: "c1",
        subagent: "research",
        route_id: "/research",
        depth: 1,
        id: "tool-run-1",
        tool: "webSearch",
        output: ["result"],
      },
    },
    {
      type: "subagent.memory.recalled",
      data: {
        call_id: "c1",
        subagent: "research",
        route_id: "/research",
        depth: 1,
        memories: [{ id: "memory-1" }],
      },
    },
    {
      type: "subagent.end",
      data: {
        call_id: "c1",
        subagent: "research",
        route_id: "/research",
        depth: 1,
        final_message: "found it",
      },
    },
  ])
})

it("retains distinct call ids for parallel child interrupts without changing root interrupts", async () => {
  async function* s() {
    yield {
      type: "interrupt",
      data: {
        interruptId: "perm-alpha",
        kind: "tool",
        callId: "call-alpha",
        detail: { toolName: "readFile" },
      },
    }
    yield {
      type: "interrupt",
      data: {
        interruptId: "perm-beta",
        kind: "command",
        callId: "call-beta",
        detail: { command: "pwd" },
      },
    }
    yield {
      type: "interrupt",
      data: { interruptId: "perm-root", kind: "memory", detail: { namespace: "facts" } },
    }
  }

  const r = await collectRunResult(s() as never, "t")

  expect(r.interrupts).toEqual([
    {
      interruptId: "perm-alpha",
      kind: "tool",
      callId: "call-alpha",
      detail: { toolName: "readFile" },
    },
    {
      interruptId: "perm-beta",
      kind: "command",
      callId: "call-beta",
      detail: { command: "pwd" },
    },
    { interruptId: "perm-root", kind: "memory", detail: { namespace: "facts" } },
  ])
})

it("retains subagent approval identity and typed detail", async () => {
  const envelope = {
    interruptId: "perm-1",
    type: "permission-request",
    kind: "subagent",
    callId: "task-1",
    detail: {
      parentRouteId: "/support",
      subagentName: "writer",
      subagentRouteId: "/support/subagents/writer",
      inputPreview: "Draft the response",
      reason: "Drafts require review.",
      suggestedPattern: JSON.stringify(["/support", "writer"]),
    },
  } as const

  async function* s() {
    yield { type: "interrupt", data: envelope }
  }

  const r = await collectRunResult(s() as never, "t")
  const interrupt = r.interrupts[0]

  expect(interrupt).toEqual({
    interruptId: envelope.interruptId,
    kind: envelope.kind,
    callId: envelope.callId,
    detail: envelope.detail,
  })
  if (interrupt?.kind !== "subagent") throw new Error("expected a subagent interrupt")
  const detail = interrupt.detail
  if (!detail) throw new Error("expected subagent interrupt detail")
  expect(detail.parentRouteId).toBe("/support")
  expect(detail.subagentName).toBe("writer")
  expect(detail.subagentRouteId).toBe("/support/subagents/writer")
  expect(detail.inputPreview).toBe("Draft the response")
  expect(detail.reason).toBe("Drafts require review.")
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
describe("deriveToolResults", () => {
  it("extracts tool results from serialized ToolMessages and flags errors", () => {
    const messages = [
      { id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "hi" } },
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: { name: "searchCorpus", status: "success", content: "[...]" },
      },
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: { name: "writeTodos", content: "{}" },
      },
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          name: "readDoc",
          status: "error",
          content: "Error: ENOENT no such file\n Please fix your mistakes.",
        },
      },
    ]
    const results = deriveToolResults(messages)
    expect(results.map((r) => r.name)).toEqual(["searchCorpus", "writeTodos", "readDoc"])
    expect(results.map((r) => r.isError)).toEqual([false, false, true])
    expect(results[0].status).toBe("success")
    expect(results[1].status).toBeUndefined()
  })
})

it("defaults the new fields to empty when absent", async () => {
  async function* s() {
    yield { type: "done", output: { messages: [] } }
  }
  const r = await collectRunResult(s() as never, "t")
  expect(r.interrupts).toEqual([])
  expect(r.planUpdates).toEqual([])
  expect(r.todos).toEqual([])
  expect(r.subagents).toEqual([])
  expect(r.systemPrompt).toBe("")
})
