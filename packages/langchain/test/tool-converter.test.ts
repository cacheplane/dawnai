import { describe, expect, test } from "vitest"
import { convertToolToLangChain } from "@dawn/langchain"

describe("convertToolToLangChain", () => {
  test("converts a basic Dawn tool to a DynamicStructuredTool", async () => {
    const dawnTool = {
      name: "greet",
      description: "Greet a user",
      filePath: "/app/tools/greet.ts",
      run: async (input: unknown) => ({ greeting: `Hello, ${(input as { name: string }).name}!` }),
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)

    expect(langchainTool.name).toBe("greet")
    expect(langchainTool.description).toBe("Greet a user")
    const result = await langchainTool.invoke({ name: "World" })
    expect(result).toBe(JSON.stringify({ greeting: "Hello, World!" }))
  })

  test("uses empty description when none provided", () => {
    const dawnTool = {
      name: "ping",
      filePath: "/app/tools/ping.ts",
      run: async () => ({ pong: true }),
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)

    expect(langchainTool.name).toBe("ping")
    expect(langchainTool.description).toBe("")
  })

  test("uses provided Zod schema when available", async () => {
    const { z } = await import("zod")
    const schema = z.object({ id: z.string().describe("Customer ID") })

    const dawnTool = {
      name: "lookup",
      description: "Look up customer",
      filePath: "/app/tools/lookup.ts",
      run: async (input: unknown) => input,
      schema,
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)

    expect(langchainTool.schema).toBe(schema)
  })
})
