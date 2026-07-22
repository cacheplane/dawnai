import type { RunAgentInput } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { fromRunAgentInput } from "../src/inbound.js"

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "th-1",
    runId: "rn-1",
    messages: [],
    tools: [],
    context: [],
    ...overrides,
  } as RunAgentInput
}

describe("fromRunAgentInput", () => {
  test("maps user and assistant messages to Dawn messages", () => {
    const input = baseInput({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "hello" },
      ],
    } as Partial<RunAgentInput>)
    const result = fromRunAgentInput(input)
    expect(result.messages).toEqual([
      { role: "user", content: "hi", id: "m1" },
      { role: "assistant", content: "hello", id: "m2" },
    ])
    expect(result.resume).toBeUndefined()
    expect(result.raw).toBe(input)
  })

  test("maps a tool message, preserving toolCallId", () => {
    const input = baseInput({
      messages: [{ id: "m1", role: "tool", content: "42", toolCallId: "tc-9" }],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages).toEqual([
      { role: "tool", content: "42", id: "m1", toolCallId: "tc-9" },
    ])
  })

  test("stringifies non-string content", () => {
    const input = baseInput({
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
    } as unknown as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages[0]?.content).toBe('[{"type":"text","text":"hi"}]')
  })

  test("falls back to String() when JSON.stringify returns undefined", () => {
    const content = Symbol.for("x")
    const message = { id: "m1", role: "user", content } as unknown as RunAgentInput["messages"][number]
    const input = baseInput({ messages: [message] })
    expect(fromRunAgentInput(input).messages[0]?.content).toBe(String(content))
  })

  test("maps a resume array to Dawn resume requests", () => {
    const input = baseInput({
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).resume).toEqual([
      { interruptId: "perm-1", status: "resolved", payload: "once" },
    ])
  })

  test("omits the resume property for an empty resume array", () => {
    const input = baseInput({ resume: [] } as Partial<RunAgentInput>)
    const result = fromRunAgentInput(input)
    expect(Object.hasOwn(result, "resume")).toBe(false)
    expect(result.resume).toBeUndefined()
  })

  test("maps activity and reasoning messages to Dawn assistant messages", () => {
    const input = baseInput({
      messages: [
        { id: "m1", role: "activity", content: { status: "running" }, activityType: "status" },
        { id: "m2", role: "reasoning", content: "thinking" },
      ],
    } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).messages).toEqual([
      { role: "assistant", content: '{"status":"running"}', id: "m1" },
      { role: "assistant", content: "thinking", id: "m2" },
    ])
  })

  test("raw preserves the original input for tools/state/context access", () => {
    const input = baseInput({ state: { a: 1 } } as Partial<RunAgentInput>)
    expect(fromRunAgentInput(input).raw).toBe(input)
  })
})
