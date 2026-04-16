import { defineTool, type ToolContext, type ToolDefinition } from "@dawn/sdk"
import { describe, expect, expectTypeOf, test } from "vitest"

describe("@dawn/sdk defineTool", () => {
  test("accepts a named tool definition", async () => {
    const tool = defineTool({
      name: "lookupCustomer",
      description: "Fetch a customer record by ID",
      run: async ({ id }: { readonly id: string }) => ({ id }),
    })

    await expect(
      tool.run({ id: "cus_123" }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ id: "cus_123" })
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

  test("ToolDefinition defaults context to the signal-only tool context shape", () => {
    expectTypeOf<Parameters<ToolDefinition["run"]>[1]>().toEqualTypeOf<{
      readonly signal: AbortSignal
    }>()
  })

  test("ToolContext exposes only signal", () => {
    expectTypeOf<ToolContext>().toEqualTypeOf<{ readonly signal: AbortSignal }>()
  })
})
