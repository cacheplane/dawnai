import { defineTool, type RuntimeContext, type RuntimeTool } from "@dawn/langgraph"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("@dawn/langgraph defineTool", () => {
  test("accepts a named tool definition", async () => {
    const tool = defineTool({
      name: "lookupCustomer",
      description: "Fetch a customer record by ID",
      run: async ({ id }: { readonly id: string }) => ({ id }),
    })

    await expect(tool.run({ id: "cus_123" })).resolves.toEqual({ id: "cus_123" })
  })

  test("rejects unnamed tools", () => {
    expect(() =>
      defineTool({
        name: "",
        run: async () => "never",
      }),
    ).toThrow("Tools must define a non-empty name")
  })

  test("runtime-context types are exported from the package root", () => {
    type Tools = {
      readonly lookupCustomer: RuntimeTool<
        { readonly id: string },
        { readonly id: string },
        RuntimeContext
      >
    }

    expectTypeOf<RuntimeContext<Tools>>().toEqualTypeOf<{
      readonly signal: AbortSignal
      readonly tools: Tools
    }>()
  })
})
