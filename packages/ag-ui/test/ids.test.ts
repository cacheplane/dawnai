import { describe, expect, test } from "vitest"
import { createCounterIdFactory, createDefaultIdFactory } from "../src/ids.js"

describe("createCounterIdFactory", () => {
  test("produces deterministic, kind-prefixed, monotonically increasing ids", () => {
    const id = createCounterIdFactory()
    expect(id("message")).toBe("msg-1")
    expect(id("message")).toBe("msg-2")
    expect(id("toolCall")).toBe("tc-1")
    expect(id("toolResult")).toBe("tr-1")
    expect(id("toolResult")).toBe("tr-2")
  })
})

describe("createDefaultIdFactory", () => {
  test("produces unique kind-prefixed ids", () => {
    const id = createDefaultIdFactory()
    const a = id("message")
    const b = id("message")
    expect(a).not.toBe(b)
    expect(a.startsWith("msg-")).toBe(true)
    expect(id("toolCall").startsWith("tc-")).toBe(true)
    expect(id("toolResult").startsWith("tr-")).toBe(true)
  })
})
