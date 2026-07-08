import { describe, expect, test } from "vitest"
import { fromAguiResume, toAguiInterrupt } from "../src/interrupts.js"

describe("toAguiInterrupt", () => {
  test("maps a Dawn interrupt envelope to an AG-UI Interrupt, preserving the envelope as metadata", () => {
    const envelope = {
      interruptId: "perm-1",
      kind: "command",
      type: "permission-request",
      detail: { command: "ls" },
    }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-1",
      reason: "command",
      metadata: envelope,
    })
  })

  test("carries an optional human message and toolCallId when present", () => {
    const envelope = { interruptId: "perm-2", kind: "tool", message: "Approve?", toolCallId: "tc-9" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-2",
      reason: "tool",
      message: "Approve?",
      toolCallId: "tc-9",
      metadata: envelope,
    })
  })

  test("falls back to empty id and 'interrupt' reason for a malformed envelope", () => {
    expect(toAguiInterrupt(null)).toEqual({ id: "", reason: "interrupt", metadata: {} })
  })

  test("treats arrays as malformed envelopes", () => {
    expect(toAguiInterrupt([])).toEqual({ id: "", reason: "interrupt", metadata: {} })
  })

  test("treats non-plain objects as malformed envelopes", () => {
    expect(toAguiInterrupt(new Date(0))).toEqual({ id: "", reason: "interrupt", metadata: {} })
  })

  test("treats plain objects without a string interruptId as malformed envelopes", () => {
    expect(toAguiInterrupt({ foo: "bar" })).toEqual({ id: "", reason: "interrupt", metadata: {} })
    expect(toAguiInterrupt({ interruptId: 123, kind: "command" })).toEqual({
      id: "",
      reason: "interrupt",
      metadata: {},
    })
  })
})

describe("fromAguiResume", () => {
  test("maps AG-UI resume entries to Dawn resume requests, preserving interruptId", () => {
    expect(
      fromAguiResume([
        { interruptId: "perm-1", status: "resolved", payload: "once" },
        { interruptId: "perm-2", status: "cancelled" },
      ]),
    ).toEqual([
      { interruptId: "perm-1", status: "resolved", payload: "once" },
      { interruptId: "perm-2", status: "cancelled" },
    ])
  })

  test("preserves a present payload key with an undefined value", () => {
    const [resume] = fromAguiResume([{ interruptId: "perm-1", status: "resolved", payload: undefined }])
    expect(resume).toEqual({ interruptId: "perm-1", status: "resolved", payload: undefined })
    expect(Object.hasOwn(resume, "payload")).toBe(true)
  })
})
