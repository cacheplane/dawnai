import type { StreamTransformerInput } from "@dawn-ai/core"
import { type Command, isCommand } from "@langchain/langgraph"
import { beforeEach, describe, expect, it, test, vi } from "vitest"
import { convertToolToLangChain, jsonSchemaToZod } from "../src/tool-converter.ts"

const dispatchCustomEvent = vi.hoisted(() => vi.fn())

vi.mock("@langchain/core/callbacks/dispatch/web", () => ({ dispatchCustomEvent }))

beforeEach(() => {
  dispatchCustomEvent.mockReset()
})

describe("convertToolToLangChain", () => {
  test("dispatches every transformer output as a capability event with the live config", async () => {
    const order: string[] = []
    const config = {
      configurable: { thread_id: "thread-1" },
      signal: new AbortController().signal,
      toolCall: { id: "provider-call-1" },
    }
    // A distinguishing property (not just `{}`) so `objectContaining({ callbacks: childCallbacks })`
    // actually proves the DISPATCHED config is the patched one carrying this exact
    // object, rather than being trivially satisfied by any empty object.
    const childCallbacks = { handlers: [] }
    const runManager = { runId: "execution-run-1", getChild: vi.fn(() => childCallbacks) }
    let transformerInput: StreamTransformerInput | undefined
    dispatchCustomEvent.mockImplementation(async (_name, payload) => {
      order.push(`dispatch:${payload.event}`)
    })
    const converted = convertToolToLangChain(
      {
        name: "probe",
        run: async () => {
          order.push("run")
          return { ok: true }
        },
      },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* (input) {
            transformerInput = input
            order.push("transform:first")
            yield { event: "first", data: { index: 1 } }
            order.push("transform:second")
            yield { event: "second", data: { index: 2 } }
          },
        },
      ],
    )

    await converted.func({}, runManager as never, config as never)
    order.push("returned")

    // patchConfig's ensureConfig() injects harmless defaults (tags, metadata,
    // recursionLimit, runId) onto the live config once a runManager is present,
    // so match on the live-config fields we actually care about rather than
    // exact identity with the raw `config` object.
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      1,
      "dawn.capability",
      { event: "first", data: { index: 1 } },
      expect.objectContaining({
        configurable: config.configurable,
        signal: config.signal,
        toolCall: config.toolCall,
        callbacks: childCallbacks,
      }),
    )
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      2,
      "dawn.capability",
      { event: "second", data: { index: 2 } },
      expect.objectContaining({
        configurable: config.configurable,
        signal: config.signal,
        toolCall: config.toolCall,
        callbacks: childCallbacks,
      }),
    )
    // Both dispatches must see the exact same patched live-config object.
    expect(dispatchCustomEvent.mock.calls[0]?.[2]).toBe(dispatchCustomEvent.mock.calls[1]?.[2])
    expect(order).toEqual([
      "run",
      "transform:first",
      "dispatch:first",
      "transform:second",
      "dispatch:second",
      "returned",
    ])
    expect(transformerInput).toEqual({
      toolName: "probe",
      toolOutput: JSON.stringify({ ok: true }),
      toolCallId: "provider-call-1",
    })
    expect(transformerInput?.toolCallId).not.toBe("execution-run-1")
  })

  test("omits the transformer tool-call id when the config carries none", async () => {
    let transformerInput: StreamTransformerInput | undefined
    const converted = convertToolToLangChain(
      { name: "probe", run: async () => "ok" },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* (input) {
            transformerInput = input
          },
        },
      ],
    )

    await converted.func({}, undefined as never, { signal: new AbortController().signal } as never)

    expect(transformerInput).toBeDefined()
    expect(Object.hasOwn(transformerInput ?? {}, "toolCallId")).toBe(false)
  })

  test("omits the transformer tool-call id when the config carries an empty-string id", async () => {
    let transformerInput: StreamTransformerInput | undefined
    const converted = convertToolToLangChain(
      { name: "probe", run: async () => "ok" },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* (input) {
            transformerInput = input
          },
        },
      ],
    )

    await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal, toolCall: { id: "" } } as never,
    )

    expect(transformerInput).toBeDefined()
    expect(Object.hasOwn(transformerInput ?? {}, "toolCallId")).toBe(false)
  })

  test("transforms and dispatches a Command result before returning it", async () => {
    const config = { configurable: { thread_id: "thread-2" } }
    const converted = convertToolToLangChain(
      {
        name: "writeState",
        run: async () => ({ result: { ok: true }, state: { value: 42 } }),
      },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* ({ toolOutput }) {
            expect(isCommand(toolOutput)).toBe(true)
            yield { event: "state_update", data: { value: 42 } }
          },
        },
      ],
    )

    const result = await converted.func({}, undefined as never, config as never)

    expect(isCommand(result)).toBe(true)
    expect(dispatchCustomEvent).toHaveBeenCalledWith(
      "dawn.capability",
      { event: "state_update", data: { value: 42 } },
      config,
    )
  })

  test("returns string content when a transformer iterator fails", async () => {
    const converted = convertToolToLangChain(
      { name: "probe", run: async () => "ok" },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* () {
            yield { event: "before_failure", data: null }
            throw new Error("transform failed")
          },
        },
      ],
    )

    await expect(
      converted.func({}, undefined as never, { signal: new AbortController().signal } as never),
    ).resolves.toBe(JSON.stringify("ok"))
  })

  test("returns a state-updating Command when capability dispatch fails", async () => {
    dispatchCustomEvent.mockRejectedValue(new Error("dispatch failed"))
    const converted = convertToolToLangChain(
      {
        name: "writeState",
        run: async () => ({ result: "updated", state: { value: 42 } }),
      },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* () {
            yield { event: "state_update", data: { value: 42 } }
          },
        },
      ],
    )

    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )

    expect(isCommand(result)).toBe(true)
    expect((result as InstanceType<typeof Command>).update).toMatchObject({ value: 42 })
  })

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
    const lc = convertToolToLangChain(tool, undefined, undefined, ["tenant"])
    await lc.invoke(
      {},
      {
        configurable: {
          thread_id: "t-123",
          tenant: "acme",
          checkpoint_ns: "tools:xyz",
          __pregel_task_id: "abc",
        },
      },
    )
    expect(seen?.threadId).toBe("t-123")
    // ONLY the allowlisted route param — LangGraph internals like checkpoint_ns
    // and __pregel_task_id must NOT leak into ctx.params.
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
  it("passes the exact live tool-call signal to offloading", async () => {
    const signal = new AbortController().signal
    const offload = vi.fn(async () => "STUB")
    const converted = convertToolToLangChain(
      { name: "dump", run: async () => "x".repeat(50_000) },
      undefined,
      offload,
    )

    await converted.func(
      {},
      undefined as never,
      {
        signal,
        toolCall: { id: "call-live" },
      } as never,
    )

    expect(offload).toHaveBeenCalledWith(expect.any(String), "dump", "call-live", signal)
  })

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
