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
