import { EventType, type RunAgentInput } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import {
  createCounterIdFactory,
  type DawnAgentStreamChunk,
  fromRunAgentInput,
  toAguiEvents,
} from "../src/index.js"

async function* one(chunk: DawnAgentStreamChunk) {
  yield chunk
  yield { type: "done", data: {} } satisfies DawnAgentStreamChunk
}

describe("interrupt round-trip", () => {
  test("a Dawn interrupt's id survives outbound -> AG-UI -> resume input -> Dawn resume", async () => {
    // 1. Dawn emits an interrupt; map it outbound.
    const events = []
    for await (const ev of toAguiEvents(
      one({ type: "interrupt", data: { interruptId: "perm-42", kind: "command" } }),
      { threadId: "th", runId: "rn" },
      { idFactory: createCounterIdFactory() },
    )) {
      events.push(ev)
    }
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as {
      outcome: { type: string; interrupts: Array<{ id: string }> }
    }
    expect(finished.outcome.type).toBe("interrupt")
    const interruptId = finished.outcome.interrupts[0]?.id
    expect(interruptId).toBe("perm-42")

    // 2. The client answers with a resume RunAgentInput addressing that id.
    const resumeInput = {
      threadId: "th",
      runId: "rn-2",
      messages: [],
      tools: [],
      context: [],
      resume: [{ interruptId, status: "resolved", payload: "once" }],
    } as unknown as RunAgentInput

    // 3. Map it back to Dawn -- the interruptId must survive.
    const dawn = fromRunAgentInput(resumeInput)
    expect(dawn.resume).toEqual([{ interruptId: "perm-42", status: "resolved", payload: "once" }])
  })
})
