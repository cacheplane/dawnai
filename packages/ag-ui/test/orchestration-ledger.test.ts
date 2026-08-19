import { EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import {
  createOrchestrationLedger,
  MAX_DEFERRED_EVENTS,
  MAX_RETAINED_CHARS,
  MAX_TRACKED_CALLS,
} from "../src/orchestration-ledger.js"
import type { AguiOutboundEvent } from "../src/outbound.js"

function frames(id: string, name: string, args = "{}"): AguiOutboundEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ]
}

function result(id: string, content = "ok"): AguiOutboundEvent {
  return { type: EventType.TOOL_CALL_RESULT, messageId: `tr-${id}`, toolCallId: id, content }
}

function activity(messageId: string): AguiOutboundEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: "dawn.plan",
    replace: true,
    content: { todos: [] },
  }
}

function text(delta: string): AguiOutboundEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-1", delta }
}

/** Test-side model of the ledger's shallow char accounting. */
function measure(event: AguiOutboundEvent): number {
  let total = 0
  for (const value of Object.values(event as Record<string, unknown>)) {
    if (typeof value === "string") total += value.length
  }
  return total
}

describe("createOrchestrationLedger", () => {
  test("passes ordinary tools straight through", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_a", "searchCorpus")
    expect(ledger.onToolCall("call_a", "searchCorpus", callFrames)).toEqual(callFrames)
    const toolResult = result("call_a")
    expect(ledger.onToolResult("call_a", "searchCorpus", toolResult)).toEqual([toolResult])
  })

  test("holds a writeTodos call until its plan activity commits suppression", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_w", "writeTodos", frames("call_w", "writeTodos"))).toEqual([])
    const planActivity = activity("dawn:plan:run-1")
    expect(
      ledger.onActivity(planActivity, { toolCallId: "call_w", toolName: "writeTodos" }),
    ).toEqual([planActivity])
    expect(ledger.onToolResult("call_w", "writeTodos", result("call_w"))).toEqual([])
  })

  test("holds a task call until subagent.start commits suppression", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_t", "task", frames("call_t", "task"))).toEqual([])
    const subagentActivity = activity("dawn:subagent:call_t")
    expect(ledger.onActivity(subagentActivity, { toolCallId: "call_t", toolName: "task" })).toEqual(
      [subagentActivity],
    )
    expect(ledger.onToolResult("call_t", "task", result("call_t"))).toEqual([])
  })

  test("falls back when the result arrives with no correlation", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_t", "task")
    expect(ledger.onToolCall("call_t", "task", callFrames)).toEqual([])
    const toolResult = result("call_t")
    expect(ledger.onToolResult("call_t", "task", toolResult)).toEqual([...callFrames, toolResult])
  })

  test("defers unrelated events behind an unresolved candidate and releases them in order", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_w", "writeTodos", frames("call_w", "writeTodos"))).toEqual([])
    const deferredText = text("a")
    expect(ledger.onPassthrough(deferredText)).toEqual([])
    const searchFrames = frames("call_s", "searchCorpus")
    expect(ledger.onToolCall("call_s", "searchCorpus", searchFrames)).toEqual([])
    const planActivity = activity("dawn:plan:run-1")
    const released = ledger.onActivity(planActivity, {
      toolCallId: "call_w",
      toolName: "writeTodos",
    })
    // Source order: the deferred events precede the activity that released them,
    // and the suppressed candidate's frames are gone.
    expect(released).toEqual([deferredText, ...searchFrames, planActivity])
  })

  test("a correlation for an unknown id emits the activity and holds the candidate", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_w", "writeTodos")
    expect(ledger.onToolCall("call_w", "writeTodos", callFrames)).toEqual([])
    const planActivity = activity("dawn:plan:run-1")
    expect(ledger.onActivity(planActivity, { toolCallId: "nope", toolName: "writeTodos" })).toEqual(
      [],
    )
    const toolResult = result("call_w")
    expect(ledger.onToolResult("call_w", "writeTodos", toolResult)).toEqual([
      ...callFrames,
      planActivity,
      toolResult,
    ])
  })

  test("a correlation whose toolName does not match the tracked name does not suppress", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_w", "writeTodos")
    expect(ledger.onToolCall("call_w", "writeTodos", callFrames)).toEqual([])
    const wrongActivity = activity("dawn:subagent:call_w")
    expect(ledger.onActivity(wrongActivity, { toolCallId: "call_w", toolName: "task" })).toEqual([])
    const toolResult = result("call_w")
    expect(ledger.onToolResult("call_w", "writeTodos", toolResult)).toEqual([
      ...callFrames,
      wrongActivity,
      toolResult,
    ])
  })

  test("a result whose name does not match does not resolve the candidate", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_w", "writeTodos")
    expect(ledger.onToolCall("call_w", "writeTodos", callFrames)).toEqual([])
    const toolResult = result("call_w")
    expect(ledger.onToolResult("call_w", "somethingElse", toolResult)).toEqual([])
    expect(ledger.settle()).toEqual([...callFrames, toolResult])
  })

  test("drops the result of a suppressed call exactly once", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_w", "writeTodos", frames("call_w", "writeTodos"))).toEqual([])
    const planActivity = activity("dawn:plan:run-1")
    expect(
      ledger.onActivity(planActivity, { toolCallId: "call_w", toolName: "writeTodos" }),
    ).toEqual([planActivity])
    expect(ledger.onToolResult("call_w", "writeTodos", result("call_w"))).toEqual([])
    const second = result("call_w", "again")
    expect(ledger.onToolResult("call_w", "writeTodos", second)).toEqual([second])
  })

  test("parallel candidates drain only a resolved prefix", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_w1", "writeTodos", frames("call_w1", "writeTodos"))).toEqual([])
    expect(ledger.onToolCall("call_w2", "writeTodos", frames("call_w2", "writeTodos"))).toEqual([])
    const activity2 = activity("dawn:plan:run-2")
    expect(ledger.onActivity(activity2, { toolCallId: "call_w2", toolName: "writeTodos" })).toEqual(
      [],
    )
    const activity1 = activity("dawn:plan:run-1")
    // Source order: activity2 was produced first, so it emits first.
    expect(ledger.onActivity(activity1, { toolCallId: "call_w1", toolName: "writeTodos" })).toEqual(
      [activity2, activity1],
    )
  })

  test("settle flushes unresolved candidates as fallback in source order", () => {
    const ledger = createOrchestrationLedger()
    const planFrames = frames("call_w", "writeTodos")
    const taskFrames = frames("call_t", "task")
    const between = text("x")
    expect(ledger.onToolCall("call_w", "writeTodos", planFrames)).toEqual([])
    expect(ledger.onPassthrough(between)).toEqual([])
    expect(ledger.onToolCall("call_t", "task", taskFrames)).toEqual([])
    expect(ledger.settle()).toEqual([...planFrames, between, ...taskFrames])
  })

  test("settle drops the candidate named by the interrupt", () => {
    const ledger = createOrchestrationLedger()
    const planFrames = frames("call_w", "writeTodos")
    const taskFrames = frames("call_t", "task")
    const between = text("x")
    expect(ledger.onToolCall("call_w", "writeTodos", planFrames)).toEqual([])
    expect(ledger.onPassthrough(between)).toEqual([])
    expect(ledger.onToolCall("call_t", "task", taskFrames)).toEqual([])
    expect(ledger.settle("call_t")).toEqual([...planFrames, between])
  })

  test("settle after suppression emits nothing for the suppressed call", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_w", "writeTodos", frames("call_w", "writeTodos"))).toEqual([])
    const planActivity = activity("dawn:plan:run-1")
    expect(
      ledger.onActivity(planActivity, { toolCallId: "call_w", toolName: "writeTodos" }),
    ).toEqual([planActivity])
    expect(ledger.settle()).toEqual([])
  })

  test("duplicate id fails open", () => {
    const ledger = createOrchestrationLedger()
    const first = frames("call_w", "writeTodos", '{"first":true}')
    const duplicate = frames("call_w", "writeTodos", '{"second":true}')
    expect(ledger.onToolCall("call_w", "writeTodos", first)).toEqual([])
    expect(ledger.onToolCall("call_w", "writeTodos", duplicate)).toEqual([...first, ...duplicate])
    const fresh = frames("call_w2", "writeTodos")
    expect(ledger.onToolCall("call_w2", "writeTodos", fresh)).toEqual(fresh)
  })

  test("a duplicate colliding with a SUPPRESSED id preserves a later result", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_w", "writeTodos", frames("call_w", "writeTodos"))).toEqual([])
    const planActivity = activity("dawn:plan:run-1")
    expect(
      ledger.onActivity(planActivity, { toolCallId: "call_w", toolName: "writeTodos" }),
    ).toEqual([planActivity])
    const duplicate = frames("call_w", "writeTodos", '{"second":true}')
    expect(ledger.onToolCall("call_w", "writeTodos", duplicate)).toEqual(duplicate)
    const toolResult = result("call_w")
    expect(ledger.onToolResult("call_w", "writeTodos", toolResult)).toEqual([toolResult])
  })

  test("exceeds MAX_TRACKED_CALLS", () => {
    const ledger = createOrchestrationLedger()
    const held: AguiOutboundEvent[] = []
    for (let index = 0; index < MAX_TRACKED_CALLS; index += 1) {
      const callFrames = frames(`call_w${index}`, "writeTodos")
      held.push(...callFrames)
      expect(ledger.onToolCall(`call_w${index}`, "writeTodos", callFrames)).toEqual([])
    }
    const overflow = frames("call_overflow", "writeTodos")
    expect(ledger.onToolCall("call_overflow", "writeTodos", overflow)).toEqual([
      ...held,
      ...overflow,
    ])
    const after = frames("call_after", "writeTodos")
    expect(ledger.onToolCall("call_after", "writeTodos", after)).toEqual(after)
  })

  test("exceeds MAX_DEFERRED_EVENTS", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_w", "writeTodos")
    expect(ledger.onToolCall("call_w", "writeTodos", callFrames)).toEqual([])
    const inbound: AguiOutboundEvent[] = [...callFrames]
    for (let index = callFrames.length; index < MAX_DEFERRED_EVENTS; index += 1) {
      const event = text(`d${index}`)
      inbound.push(event)
      expect(ledger.onPassthrough(event)).toEqual([])
    }
    const overflow = text("overflow")
    inbound.push(overflow)
    const drained = ledger.onPassthrough(overflow)
    expect(drained).toEqual(inbound)
    expect(drained).toHaveLength(MAX_DEFERRED_EVENTS + 1)
    const after = frames("call_after", "writeTodos")
    expect(ledger.onToolCall("call_after", "writeTodos", after)).toEqual(after)
  })

  test("exceeds MAX_RETAINED_CHARS", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_w", "writeTodos")
    expect(ledger.onToolCall("call_w", "writeTodos", callFrames)).toEqual([])
    const heldChars = callFrames.reduce((total, event) => total + measure(event), 0)
    const filler = text("x".repeat(MAX_RETAINED_CHARS - heldChars - measure(text(""))))
    // Exactly at the limit: still held.
    expect(ledger.onPassthrough(filler)).toEqual([])
    const big = text("y".repeat(MAX_RETAINED_CHARS))
    const drained = ledger.onPassthrough(big)
    expect(drained).toEqual([...callFrames, filler, big])
    const last = drained.at(-1)
    expect(last).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT })
    expect((last as { delta: string }).delta).toHaveLength(MAX_RETAINED_CHARS)
  })

  test("suppression stays disabled after fail-open but suppressed ids still drop results", () => {
    const ledger = createOrchestrationLedger()
    expect(ledger.onToolCall("call_w1", "writeTodos", frames("call_w1", "writeTodos"))).toEqual([])
    const planActivity = activity("dawn:plan:run-1")
    expect(
      ledger.onActivity(planActivity, { toolCallId: "call_w1", toolName: "writeTodos" }),
    ).toEqual([planActivity])
    // Hold a second candidate, then trip the retained-chars bound.
    const heldFrames = frames("call_w2", "writeTodos")
    expect(ledger.onToolCall("call_w2", "writeTodos", heldFrames)).toEqual([])
    const big = text("y".repeat(MAX_RETAINED_CHARS + 1))
    expect(ledger.onPassthrough(big)).toEqual([...heldFrames, big])
    // The suppressed id is still remembered, so its result is still dropped.
    expect(ledger.onToolResult("call_w1", "writeTodos", result("call_w1"))).toEqual([])
    const after = frames("call_after", "writeTodos")
    expect(ledger.onToolCall("call_after", "writeTodos", after)).toEqual(after)
  })

  test("returns its held-size accounting to zero after each full drain", () => {
    const ledger = createOrchestrationLedger()
    // Two complete suppression cycles: a sign error in the accounting would
    // leave a skewed counter and make the bound below trip early or late.
    for (const id of ["call_w1", "call_w2"]) {
      expect(ledger.onToolCall(id, "writeTodos", frames(id, "writeTodos"))).toEqual([])
      const planActivity = activity(`dawn:plan:${id}`)
      expect(ledger.onActivity(planActivity, { toolCallId: id, toolName: "writeTodos" })).toEqual([
        planActivity,
      ])
      expect(ledger.onToolResult(id, "writeTodos", result(id))).toEqual([])
    }
    // A third candidate must now see a pristine budget: exactly
    // MAX_DEFERRED_EVENTS held events are still held, and one more trips.
    const callFrames = frames("call_w3", "writeTodos")
    expect(ledger.onToolCall("call_w3", "writeTodos", callFrames)).toEqual([])
    const inbound: AguiOutboundEvent[] = [...callFrames]
    for (let index = callFrames.length; index < MAX_DEFERRED_EVENTS; index += 1) {
      const event = text(`d${index}`)
      inbound.push(event)
      expect(ledger.onPassthrough(event)).toEqual([])
    }
    const overflow = text("overflow")
    inbound.push(overflow)
    expect(ledger.onPassthrough(overflow)).toEqual(inbound)
  })

  test("never holds a call with an empty-string id", () => {
    const ledger = createOrchestrationLedger()
    const first = frames("", "writeTodos", '{"first":true}')
    expect(ledger.onToolCall("", "writeTodos", first)).toEqual(first)
    // A second empty id is not treated as a duplicate: nothing was tracked.
    const second = frames("", "writeTodos", '{"second":true}')
    expect(ledger.onToolCall("", "writeTodos", second)).toEqual(second)
    const toolResult = result("")
    expect(ledger.onToolResult("", "writeTodos", toolResult)).toEqual([toolResult])
    // Suppression is still available to a properly identified call.
    expect(ledger.onToolCall("call_w", "writeTodos", frames("call_w", "writeTodos"))).toEqual([])
  })

  test("settle is idempotent", () => {
    const ledger = createOrchestrationLedger()
    const callFrames = frames("call_w", "writeTodos")
    const between = text("x")
    expect(ledger.onToolCall("call_w", "writeTodos", callFrames)).toEqual([])
    expect(ledger.onPassthrough(between)).toEqual([])
    expect(ledger.settle()).toEqual([...callFrames, between])
    expect(ledger.settle()).toEqual([])
    expect(ledger.settle("call_w")).toEqual([])
  })
})
