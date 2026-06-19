import { describe, expect, it } from "vitest"
import { classifyWrite } from "../src/reconcile.js"
import type { MemoryRecord } from "../src/types.js"

function rec(data: Record<string, unknown>, id = "x"): MemoryRecord {
  return {
    id,
    kind: "semantic",
    namespace: "ws=a",
    content: "",
    data,
    source: { type: "run", id: "r" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "t",
    updatedAt: "t",
  }
}
const identity = ["subject", "predicate"]
describe("classifyWrite", () => {
  it("ADD when no candidate shares the identity key", () => {
    expect(classifyWrite(rec({ subject: "a", predicate: "p", value: "1" }), [], identity).op).toBe(
      "add",
    )
  })
  it("UPDATE when identity matches and value is equal", () => {
    const existing = rec({ subject: "a", predicate: "p", value: "1" }, "e1")
    expect(
      classifyWrite(rec({ subject: "a", predicate: "p", value: "1" }), [existing], identity),
    ).toEqual({ op: "update", targetId: "e1" })
  })
  it("SUPERSEDE when identity matches but value differs", () => {
    const existing = rec({ subject: "a", predicate: "p", value: "1" }, "e1")
    expect(
      classifyWrite(rec({ subject: "a", predicate: "p", value: "2" }), [existing], identity),
    ).toEqual({ op: "supersede", targetId: "e1" })
  })
})
