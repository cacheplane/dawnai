import { defineRoute } from "@dawn/langgraph"
import { describe, expect, test } from "vitest"

describe("@dawn/langgraph defineRoute", () => {
  test("accepts an explicit workflow route definition", () => {
    const route = {
      kind: "workflow",
      entry: "./routes/support/workflow.ts",
      config: {
        runtime: "node",
      },
    } as const

    expect(defineRoute(route)).toBe(route)
  })

  test("rejects non-relative route entry paths", () => {
    expect(() =>
      defineRoute({
        kind: "workflow",
        entry: "routes/support/workflow.ts",
      }),
    ).toThrow("Route entry must be a relative module path")
  })
})
