import { describe, expect, it } from "vitest"
import { type MemoryRecord, sqliteMemoryStore, writePolicyFor } from "../src/index.js"

describe("writePolicyFor", () => {
  it("semantic reconciles", () => {
    expect(writePolicyFor("semantic")).toEqual({ mode: "reconcile" })
  })
  it("episodic appends", () => {
    expect(writePolicyFor("episodic")).toEqual({ mode: "append" })
  })
  it("reflection appends (insights accumulate)", () => {
    expect(writePolicyFor("reflection")).toEqual({ mode: "append" })
  })
  it("procedural still throws a not-yet-wired error", () => {
    expect(() => writePolicyFor("procedural")).toThrow(/not yet wired/)
  })
  it("the low-level store accepts a typed procedural record", async () => {
    const store = sqliteMemoryStore({ path: ":memory:" })
    const record: MemoryRecord = {
      id: "procedure-1",
      kind: "procedural",
      namespace: "route=/support",
      content: "Escalate failed payments after three retries.",
      data: { retries: 3 },
      source: { type: "human", id: "operator" },
      confidence: 1,
      tags: ["billing"],
      status: "active",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    }
    await store.put(record)
    expect(await store.get(record.id)).toMatchObject({ id: record.id, kind: "procedural" })
  })
})
