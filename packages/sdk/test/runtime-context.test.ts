import type { RuntimeContext, RuntimeTool } from "@dawnai.org/sdk"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("@dawnai.org/sdk runtime-context type surface", () => {
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
