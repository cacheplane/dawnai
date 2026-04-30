import type { RuntimeContext, RuntimeTool } from "@dawn-ai/sdk"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("@dawn-ai/sdk runtime-context type surface", () => {
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
    const lookupCustomer = async (
      input: { readonly id: string },
      _context: RuntimeContext<{
        readonly lookupCustomer: RuntimeTool<{ readonly id: string }, { readonly id: string }>
      }>,
    ) => _context.tools.lookupCustomer(input)

    const result = await lookupCustomer(
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
