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
    ).toThrow("Tool name must be a non-empty string")
  })

  test("rejects tools with a non-callable run implementation", () => {
    expect(() =>
      defineTool({
        name: "lookupCustomer",
        run: "not-a-function" as never,
      }),
    ).toThrow("Tool run must be a function")
  })

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

  test("defineTool defaults context to the exported runtime context shape", () => {
    const tool = defineTool({
      name: "lookupCustomer",
      run: async (_input: { readonly id: string }, context) => ({
        aborted: context.signal.aborted,
        hasLookupCustomer: "lookupCustomer" in context.tools,
      }),
    })

    expectTypeOf<Parameters<typeof tool.run>[1]>().toEqualTypeOf<RuntimeContext>()
  })
})
