import { defineTool, type RuntimeContext, type RuntimeTool } from "@dawn/langgraph"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("@dawn/langgraph runtime-context type surface", () => {
  test("runtime-context types are exported from the package root", () => {
    type Tools = {
      readonly lookupCustomer: RuntimeTool<{ readonly id: string }, { readonly id: string }>
    }

    expectTypeOf<RuntimeContext<Tools>>().toEqualTypeOf<{
      readonly signal: AbortSignal
      readonly tools: Tools
    }>()
  })

  test("runtime-context tools are callable by name", async () => {
    const tool = defineTool({
      name: "lookupCustomer",
      run: async (
        input: { readonly id: string },
        context: RuntimeContext<{
          readonly lookupCustomer: RuntimeTool<{ readonly id: string }, { readonly id: string }>
        }>,
      ) => context.tools.lookupCustomer(input),
    })

    const result = await tool.run(
      { id: "cus_123" },
      {
        signal: new AbortController().signal,
        tools: {
          lookupCustomer: async ({ id }) => ({ id }),
        },
      },
    )

    expect(result).toEqual({ id: "cus_123" })
  })
})
