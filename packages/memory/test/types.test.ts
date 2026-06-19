import { describe, expect, it } from "vitest"
import type { MemoryRecord } from "../src/types.js"

describe("MemoryRecord", () => {
  it("accepts a well-formed semantic record", () => {
    const rec: MemoryRecord = {
      id: "m1",
      kind: "semantic",
      namespace: "ws=acme|route=/support",
      content: "Tenant acme escalates billing above $500.",
      data: { subject: "billing", predicate: "escalate_above", value: "500" },
      source: { type: "run", id: "run1" },
      confidence: 0.9,
      tags: ["billing"],
      status: "active",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    }
    expect(rec.kind).toBe("semantic")
  })
})
