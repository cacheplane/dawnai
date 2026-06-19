import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineMemory } from "../src/memory.js"

describe("defineMemory", () => {
  it("returns the descriptor with kind, scope, and schema", () => {
    const schema = z.object({ subject: z.string(), predicate: z.string(), value: z.string() })
    const m = defineMemory({ kind: "semantic", scope: ["workspace", "route"], schema })
    expect(m.kind).toBe("semantic")
    expect(m.scope).toEqual(["workspace", "route"])
    expect(m.schema).toBe(schema)
  })
})
