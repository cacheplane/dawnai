import { sqliteMemoryStore } from "@dawn-ai/memory"
import { describe, expect, it } from "vitest"
import { seedMemory } from "../src/memory.js"

describe("seedMemory", () => {
  it("inserts records retrievable via the store", async () => {
    const store = sqliteMemoryStore({ path: ":memory:" })
    await seedMemory(store, [
      {
        id: "m1",
        namespace: "ns",
        content: "acme escalates billing above 500",
        data: { subject: "billing", predicate: "escalate_above", value: "500" },
      },
    ])
    const found = await store.search({ namespace: "ns", query: "billing" })
    expect(found.map((r) => r.id)).toEqual(["m1"])
  })
})
