import { convertToolToLangChain } from "@dawn-ai/langchain"
import { type Command, isCommand } from "@langchain/langgraph"
import { describe, expect, it, test } from "vitest"
import { jsonSchemaToZod } from "../src/tool-converter.js"

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

describe("convertToolToLangChain — config.configurable forwarding", () => {
  it("forwards thread_id and route params from config.configurable into the tool run context", async () => {
    let seen: { threadId?: string; params?: Record<string, string> } | undefined
    const tool = {
      name: "probe",
      run: (_input: unknown, ctx: { threadId?: string; params?: Record<string, string> }) => {
        seen = { threadId: ctx.threadId, params: ctx.params }
        return "ok"
      },
    }
    const lc = convertToolToLangChain(tool)
    await lc.invoke({}, { configurable: { thread_id: "t-123", tenant: "acme" } })
    expect(seen?.threadId).toBe("t-123")
    expect(seen?.params).toEqual({ tenant: "acme" })
  })
})

describe("jsonSchemaToZod nesting", () => {
  it("builds a nested object schema that validates", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" }, limit: { type: "number" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
      required: ["filter"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ filter: { status: "open", limit: 5 } })).toEqual({
      filter: { status: "open", limit: 5 },
    })
    expect(() => zodSchema.parse({ filter: { limit: 5 } })).toThrow()
  })

  it("builds an array-of-objects schema", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ items: [{ id: 1 }, { id: 2 }] })).toEqual({
      items: [{ id: 1 }, { id: 2 }],
    })
  })

  it("builds a z.record from additionalProperties schema", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: { meta: { type: "object", additionalProperties: { type: "number" } } },
      required: ["meta"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ meta: { a: 1, b: 2 } })).toEqual({ meta: { a: 1, b: 2 } })
    expect(() => zodSchema.parse({ meta: { a: "x" } })).toThrow()
  })

  it("builds a z.union from anyOf", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        action: {
          anyOf: [
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["create"] }, name: { type: "string" } },
              required: ["kind", "name"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["delete"] }, id: { type: "number" } },
              required: ["kind", "id"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["action"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ action: { kind: "create", name: "x" } })).toEqual({
      action: { kind: "create", name: "x" },
    })
    expect(zodSchema.parse({ action: { kind: "delete", id: 7 } })).toEqual({
      action: { kind: "delete", id: 7 },
    })
    expect(() => zodSchema.parse({ action: { kind: "create" } })).toThrow()
  })
})

describe("convertToolToLangChain offloading", () => {
  it("replaces large plain-return content with a stub", async () => {
    const big = "x".repeat(50_000)
    const tool = { name: "dump", description: "", run: async () => big }
    const offload = async (content: string, toolName: string) =>
      content.length > 40_000 ? `STUB:${toolName}` : content
    const converted = convertToolToLangChain(tool, undefined, offload)
    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )
    expect(result).toBe("STUB:dump")
  })
  it("replaces large {result,state} content with a stub in the ToolMessage", async () => {
    const big = "y".repeat(50_000)
    const tool = {
      name: "dump2",
      description: "",
      run: async () => ({ result: big, state: { k: 1 } }),
    }
    const offload = async (content: string) => (content.length > 40_000 ? "STUB2" : content)
    const converted = convertToolToLangChain(tool, undefined, offload)
    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )
    const cmd = result as { update: { messages: Array<{ content: unknown }>; k?: number } }
    expect(cmd.update.messages[0]?.content).toBe("STUB2")
    expect(cmd.update.k).toBe(1)
  })
  it("is a pass-through when no offload callback is given", async () => {
    const big = "z".repeat(50_000)
    const tool = { name: "dump3", description: "", run: async () => big }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )
    // unwrapToolResult JSON-stringifies plain values; verify no offload substitution occurred
    expect(result).toBe(JSON.stringify(big))
  })
})
