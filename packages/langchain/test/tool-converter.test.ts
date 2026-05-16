import { convertToolToLangChain } from "@dawn-ai/langchain"
import { ToolMessage } from "@langchain/core/messages"
import { type Command, isCommand } from "@langchain/langgraph"
import { describe, expect, it, test } from "vitest"

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

  test("converts JSON Schema from tools.json to Zod schema", async () => {
    const dawnTool = {
      name: "greet",
      description: "Greet a tenant",
      filePath: "/app/tools/greet.ts",
      run: async (input: unknown) => input,
      schema: {
        type: "object",
        properties: {
          tenant: { type: "string" },
        },
        required: ["tenant"],
        additionalProperties: false,
      },
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(dawnTool)

    expect(langchainTool.name).toBe("greet")
    const result = await langchainTool.invoke({ tenant: "acme" })
    expect(JSON.parse(result)).toEqual({ tenant: "acme" })
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

describe("convertToolToLangChain — {result, state} wrapped returns", () => {
  it("returns a JSON-stringified content for a plain return (unchanged)", async () => {
    const tool = {
      name: "echo",
      description: "Echo input.",
      run: async (input: unknown) => input,
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      { msg: "hi" },
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(typeof result).toBe("string")
    expect(result).toBe(JSON.stringify({ msg: "hi" }))
  })

  it("returns a Command when the tool returns {result, state}", async () => {
    const tool = {
      name: "writeFoo",
      description: "Write foo to state.",
      run: async () => ({ result: { ok: true }, state: { foo: 42 } }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(isCommand(result)).toBe(true)
    const cmd = result as InstanceType<typeof Command>
    const update = cmd.update as Record<string, unknown>
    expect(update.foo).toBe(42)
  })

  it("returns a Command whose embedded ToolMessage content is the verbatim string when result is a string", async () => {
    const tool = {
      name: "writeNote",
      description: "Write note + state",
      run: async () => ({ result: "noted", state: { note: "noted" } }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(isCommand(result)).toBe(true)
    const cmd = result as InstanceType<typeof Command>
    const update = cmd.update as Record<string, unknown> & { messages?: unknown[] }
    expect(Array.isArray(update.messages)).toBe(true)
    const msg = (update.messages as Array<{ content?: unknown }>)[0]
    expect(msg?.content).toBe("noted")
    expect(update.note).toBe("noted")
  })

  it("returns plain string content when tool returns { result } only (no state)", async () => {
    const tool = {
      name: "noState",
      description: "...",
      run: async () => ({ result: "ok" }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(typeof result).toBe("string")
    expect(result).toBe("ok")
  })
})
