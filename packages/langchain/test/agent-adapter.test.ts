import { agent } from "@dawn-ai/sdk"
import { AIMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, test, vi } from "vitest"
import { z } from "zod"
import {
  __resetMaterializedAgentsForTests,
  executeAgent,
  materializeAgentGraph,
  streamAgent,
} from "../src/agent-adapter.ts"

async function collectCustomEvents(
  metadata?: Record<string, unknown>,
  extraCapabilityPayloads: readonly unknown[] = [],
) {
  const inheritedEvent = Object.assign(Object.create({ event: "inherited" }), {
    data: "invalid",
  })
  const entry = {
    invoke: vi.fn(),
    async *streamEvents() {
      yield {
        event: "on_tool_end",
        run_id: "tool-1",
        name: "writeTodos",
        data: { output: { todos: ["legacy"] } },
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-1",
        name: "dawn.capability",
        data: { event: "plan_update", data: { todos: ["one"] } },
        ...(metadata ? { metadata } : {}),
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-2",
        name: "dawn.capability",
        data: { event: 42, data: "invalid" },
        ...(metadata ? { metadata } : {}),
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-3",
        name: "dawn.capability",
        data: inheritedEvent,
        ...(metadata ? { metadata } : {}),
      }
      yield {
        event: "on_custom_event",
        run_id: "custom-4",
        name: "other.event",
        data: { event: "ignored", data: "invalid" },
        ...(metadata ? { metadata } : {}),
      }
      for (const [index, data] of extraCapabilityPayloads.entries()) {
        yield {
          event: "on_custom_event",
          run_id: `custom-extra-${index}`,
          name: "dawn.capability",
          data,
          ...(metadata ? { metadata } : {}),
        }
      }
      yield {
        event: "on_chain_end",
        run_id: "root",
        name: "LangGraph",
        data: { output: { ok: true } },
      }
    },
  }
  const chunks = []
  for await (const chunk of streamAgent({
    checkpointer: new MemorySaver(),
    entry,
    input: { question: "hi" },
    routeParamNames: [],
    signal: new AbortController().signal,
    streamTransformers: [
      {
        observes: "tool_result",
        transform: async function* () {
          yield { event: "plan_update", data: { todos: ["legacy"] } }
        },
      },
    ],
    tools: [],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

describe("capability custom events", () => {
  test("maps a valid root capability payload and ignores malformed payloads", async () => {
    await expect(collectCustomEvents()).resolves.toEqual([
      {
        type: "tool_result",
        data: { id: "tool-1", name: "writeTodos", output: { todos: ["legacy"] } },
      },
      { type: "plan_update", data: { todos: ["one"] } },
      { type: "done", data: { ok: true } },
    ])
  })

  test("namespaces a child capability payload from Dawn subagent metadata", async () => {
    const chunks = await collectCustomEvents({
      dawn: {
        subagent_stack: [{ callId: "call-1", name: "researcher", routeId: "/researcher" }],
      },
    })

    expect(chunks[1]).toEqual({
      type: "subagent.plan_update",
      data: {
        call_id: "call-1",
        subagent: "researcher",
        route_id: "/researcher",
        depth: 1,
        todos: ["one"],
      },
    })
  })

  test("projects only safe non-reserved capability event names", async () => {
    const invalidNames = [
      "line\nbreak",
      "line\rbreak",
      "control\u0007bell",
      "has space",
      "chunk",
      "token",
      "tool_call",
      "tool_result",
      "interrupt",
      "done",
      "subagent.plan_update",
    ]
    const chunks = await collectCustomEvents(undefined, [
      { event: "memory.plan-updated", data: "accepted" },
      ...invalidNames.map((event) => ({ event, data: "rejected" })),
    ])

    expect(chunks).toEqual([
      {
        type: "tool_result",
        data: { id: "tool-1", name: "writeTodos", output: { todos: ["legacy"] } },
      },
      { type: "plan_update", data: { todos: ["one"] } },
      { type: "memory.plan-updated", data: "accepted" },
      { type: "done", data: { ok: true } },
    ])
  })
})

describe("native subagent event projection", () => {
  const metadata = {
    dawn: {
      subagent_stack: [
        { callId: "call-outer", name: "planner", routeId: "/planner" },
        { callId: "call-child", name: "researcher", routeId: "/planner/researcher" },
      ],
    },
  }

  test("projects child events exactly once and leaves the parent task correlated at root", async () => {
    const entry = {
      invoke: vi.fn(),
      async *streamEvents() {
        yield {
          event: "on_chat_model_stream",
          run_id: "parent-model",
          name: "parent-model",
          data: { chunk: { content: "Parent " } },
        }
        yield {
          event: "on_tool_start",
          run_id: "parent-task-run",
          name: "task",
          data: { input: { subagent: "researcher", input: "Investigate" } },
        }
        yield {
          event: "on_custom_event",
          run_id: "child-start",
          name: "dawn.subagent",
          data: {
            phase: "start",
            call_id: "call-child",
            tool_run_id: "parent-task-run",
            subagent: "researcher",
            route_id: "/planner/researcher",
            depth: 2,
          },
          parent_ids: ["root-run", "parent-task-run"],
        }
        yield {
          event: "on_chain_start",
          run_id: "child-graph",
          name: "LangGraph",
          data: { input: {} },
          metadata,
          parent_ids: ["root-run", "parent-task-run"],
        }
        yield {
          event: "on_chat_model_stream",
          run_id: "child-model",
          name: "child-model",
          data: { chunk: { content: "Child token" } },
          metadata,
          parent_ids: ["root-run", "parent-task-run", "child-graph"],
        }
        yield {
          event: "on_tool_start",
          run_id: "child-tool-run",
          name: "readFile",
          data: { input: { path: "evidence.md" } },
          metadata,
          parent_ids: ["root-run", "parent-task-run", "child-graph"],
        }
        yield {
          event: "on_tool_end",
          run_id: "child-tool-run",
          name: "readFile",
          data: { output: "evidence" },
          metadata,
          parent_ids: ["root-run", "parent-task-run", "child-graph"],
        }
        yield {
          event: "on_custom_event",
          run_id: "child-capability",
          name: "dawn.capability",
          data: { event: "plan_update", data: { todos: ["inspect"] } },
          metadata,
          parent_ids: ["root-run", "parent-task-run", "child-graph"],
        }
        yield {
          event: "on_chain_end",
          run_id: "child-graph",
          name: "LangGraph",
          data: { output: { child: true } },
          metadata,
          parent_ids: ["root-run", "parent-task-run"],
        }
        yield {
          event: "on_custom_event",
          run_id: "child-end",
          name: "dawn.subagent",
          data: {
            phase: "end",
            call_id: "call-child",
            tool_run_id: "parent-task-run",
            subagent: "researcher",
            route_id: "/planner/researcher",
            depth: 2,
            final_message: "evidence",
          },
          parent_ids: ["root-run", "parent-task-run"],
        }
        yield {
          event: "on_tool_end",
          run_id: "parent-task-run",
          name: "task",
          data: { output: "evidence" },
        }
        yield {
          event: "on_chain_end",
          run_id: "root-run",
          name: "LangGraph",
          data: { output: { root: true } },
          parent_ids: [],
        }
      },
    }

    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(chunk)
    }

    const childIdentity = {
      call_id: "call-child",
      subagent: "researcher",
      route_id: "/planner/researcher",
      depth: 2,
    }
    expect(chunks).toEqual([
      { type: "token", data: "Parent " },
      { type: "subagent.start", data: childIdentity },
      {
        type: "subagent.message",
        data: { ...childIdentity, chunk: "Child token" },
      },
      {
        type: "subagent.tool_call",
        data: {
          ...childIdentity,
          id: "child-tool-run",
          tool: "readFile",
          input: { path: "evidence.md" },
        },
      },
      {
        type: "subagent.tool_result",
        data: {
          ...childIdentity,
          id: "child-tool-run",
          tool: "readFile",
          output: "evidence",
        },
      },
      {
        type: "subagent.plan_update",
        data: { ...childIdentity, todos: ["inspect"] },
      },
      {
        type: "subagent.end",
        data: { ...childIdentity, final_message: "evidence" },
      },
      {
        type: "tool_call",
        data: {
          id: "parent-task-run",
          name: "task",
          input: { subagent: "researcher", input: "Investigate" },
        },
      },
      {
        type: "tool_result",
        data: { id: "parent-task-run", name: "task", output: "evidence" },
      },
      { type: "done", data: { root: true } },
    ])
    expect(chunks.filter(({ type }) => type === "token")).toEqual([
      { type: "token", data: "Parent " },
    ])
    expect(chunks.filter(({ type }) => type === "tool_call")).toHaveLength(1)
    expect(chunks.filter(({ type }) => type === "tool_result")).toHaveLength(1)
  })

  test("treats malformed Dawn stacks as root metadata", async () => {
    const malformedMetadata = {
      dawn: {
        subagent_stack: [
          { callId: "valid", name: "researcher", routeId: "/researcher" },
          { callId: "", name: "nested", routeId: "/researcher/nested" },
        ],
      },
    }
    const entry = {
      invoke: vi.fn(),
      async *streamEvents() {
        yield {
          event: "on_chat_model_stream",
          run_id: "model",
          name: "model",
          data: { chunk: { content: "root token" } },
          metadata: malformedMetadata,
          parent_ids: ["root"],
        }
        yield {
          event: "on_custom_event",
          run_id: "capability",
          name: "dawn.capability",
          data: { event: "plan_update", data: { todos: ["root"] } },
          metadata: malformedMetadata,
          parent_ids: ["root"],
        }
      },
    }

    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { type: "token", data: "root token" },
      { type: "plan_update", data: { todos: ["root"] } },
      { type: "done", data: undefined },
    ])
  })

  test("correlates metadata-less native child errors without crossing parallel siblings", async () => {
    const researcherMetadata = {
      dawn: {
        subagent_stack: [{ callId: "call-researcher", name: "researcher", routeId: "/researcher" }],
      },
    }
    const writerMetadata = {
      dawn: {
        subagent_stack: [{ callId: "call-writer", name: "writer", routeId: "/writer" }],
      },
    }
    const graphInterrupt = (
      ...interrupts: Array<{ id: string; value: Record<string, unknown> }>
    ): Error & { interrupts: Array<{ id: string; value: Record<string, unknown> }> } =>
      Object.assign(new Error("GraphInterrupt"), {
        name: "GraphInterrupt",
        interrupts,
      })
    const entry = {
      invoke: vi.fn(),
      async *streamEvents() {
        yield {
          event: "on_custom_event",
          run_id: "shared-custom-event-run",
          name: "dawn.subagent",
          data: {
            phase: "start",
            call_id: "call-researcher",
            tool_run_id: "task-run-researcher",
            subagent: "researcher",
            route_id: "/researcher",
            depth: 1,
          },
          metadata: researcherMetadata,
        }
        yield {
          event: "on_custom_event",
          run_id: "shared-custom-event-run",
          name: "dawn.subagent",
          data: {
            phase: "start",
            call_id: "call-writer",
            tool_run_id: "task-run-writer",
            subagent: "writer",
            route_id: "/writer",
            depth: 1,
          },
          metadata: writerMetadata,
        }
        yield {
          event: "on_tool_error",
          run_id: "task-run-researcher",
          name: "task",
          data: {
            error: graphInterrupt(
              {
                id: "native-tool-id",
                value: {
                  interruptId: "perm-tool",
                  kind: "tool",
                  detail: { toolName: "writeFile" },
                },
              },
              {
                id: "native-path-id",
                value: {
                  interruptId: "perm-path",
                  kind: "path",
                  callId: "existing-path-call",
                  detail: { path: "evidence.md" },
                },
              },
              {
                id: "native-subagent-id",
                value: {
                  interruptId: "perm-subagent",
                  kind: "subagent",
                  callId: "resolver-call-id",
                  detail: { subagentName: "reviewer" },
                },
              },
            ),
          },
        }
        yield {
          event: "on_tool_error",
          run_id: "task-run-writer",
          name: "task",
          data: {
            error: graphInterrupt(
              {
                id: "native-command-id",
                value: {
                  interruptId: "perm-command",
                  kind: "command",
                  detail: { command: "pwd" },
                },
              },
              {
                id: "native-memory-id",
                value: {
                  interruptId: "perm-memory",
                  kind: "memory",
                  detail: { namespace: "facts" },
                },
              },
            ),
          },
        }
        yield {
          event: "on_tool_error",
          run_id: "tools-node",
          name: "tools",
          data: {
            error: graphInterrupt({
              id: "native-shared-id",
              value: {
                interruptId: "perm-shared",
                kind: "memory",
                detail: { namespace: "shared" },
              },
            }),
          },
        }
      },
    }

    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        type: "subagent.start",
        data: {
          call_id: "call-researcher",
          subagent: "researcher",
          route_id: "/researcher",
          depth: 1,
        },
      },
      {
        type: "subagent.start",
        data: {
          call_id: "call-writer",
          subagent: "writer",
          route_id: "/writer",
          depth: 1,
        },
      },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-tool",
          kind: "tool",
          callId: "call-researcher",
          detail: { toolName: "writeFile" },
        },
      },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-path",
          kind: "path",
          callId: "existing-path-call",
          detail: { path: "evidence.md" },
        },
      },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-subagent",
          kind: "subagent",
          callId: "resolver-call-id",
          detail: { subagentName: "reviewer" },
        },
      },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-command",
          kind: "command",
          callId: "call-writer",
          detail: { command: "pwd" },
        },
      },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-memory",
          kind: "memory",
          callId: "call-writer",
          detail: { namespace: "facts" },
        },
      },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-shared",
          kind: "memory",
          detail: { namespace: "shared" },
        },
      },
      { type: "done", data: undefined },
    ])
  })
})

describe("executeAgent with DawnAgent descriptors", () => {
  test("materializes v2 agents so parallel tool calls have independent graph tasks", async () => {
    const createReactAgent = vi.fn(() => ({ invoke: vi.fn() }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {},
    }))
    __resetMaterializedAgentsForTests()

    try {
      await materializeAgentGraph({
        checkpointer: new MemorySaver(),
        descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Test." }),
        tools: [],
      })

      expect(createReactAgent).toHaveBeenCalledWith(expect.objectContaining({ version: "v2" }))
    } finally {
      __resetMaterializedAgentsForTests()
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    }
  })

  test("does not reuse a compiled graph across distinct subagent resolvers", async () => {
    const createReactAgent = vi.fn(() => ({ invoke: vi.fn() }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {},
    }))
    __resetMaterializedAgentsForTests()

    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "Test." })
    const checkpointer = new MemorySaver()
    const task = {
      name: "task",
      schema: z.object({ subagent: z.string(), input: z.string() }),
      run: async () => "placeholder",
    }
    const firstResolver = vi.fn(async () => ({
      ok: false as const,
      message: "first resolver",
    }))
    const secondResolver = vi.fn(async () => ({
      ok: false as const,
      message: "second resolver",
    }))

    try {
      const first = await materializeAgentGraph({
        checkpointer,
        descriptor,
        subagentResolver: firstResolver,
        tools: [task],
      })
      const second = await materializeAgentGraph({
        checkpointer,
        descriptor,
        subagentResolver: secondResolver,
        tools: [task],
      })

      expect(createReactAgent).toHaveBeenCalledTimes(2)
      expect(second).not.toBe(first)
    } finally {
      __resetMaterializedAgentsForTests()
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    }
  })

  test("does not reuse a compiled graph when stream transformers change", async () => {
    const createReactAgent = vi.fn(() => ({ invoke: vi.fn() }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {},
    }))
    __resetMaterializedAgentsForTests()

    const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "Test." })
    const tool = { name: "probe", run: async () => "ok" }
    const firstTransformer = {
      observes: "tool_result" as const,
      transform: async function* () {
        yield { event: "first", data: 1 }
      },
    }
    const secondTransformer = {
      observes: "tool_result" as const,
      transform: async function* () {
        yield { event: "second", data: 2 }
      },
    }

    try {
      const first = await materializeAgentGraph({
        checkpointer: new MemorySaver(),
        descriptor,
        streamTransformers: [firstTransformer],
        tools: [tool],
      })
      const second = await materializeAgentGraph({
        checkpointer: new MemorySaver(),
        descriptor,
        streamTransformers: [secondTransformer],
        tools: [tool],
      })

      expect(createReactAgent).toHaveBeenCalledTimes(2)
      expect(second).not.toBe(first)
    } finally {
      __resetMaterializedAgentsForTests()
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    }
  })

  test("DawnAgent descriptor is recognized and does not throw invoke error", async () => {
    let openAIModel: unknown

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { llm: unknown }) => {
        openAIModel = options.llm
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "OpenAI!" })),
        }
      }),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        readonly options: Record<string, unknown>

        constructor(options: Record<string, unknown>) {
          this.options = options
        }
      },
    }))

    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    })

    expect((result as AIMessage).content).toBe("OpenAI!")
    expect((openAIModel as { options: Record<string, unknown> }).options).toEqual({
      model: "gpt-4o-mini",
    })
  })

  test("DawnAgent descriptor explicit provider overrides model inference", async () => {
    let groqModel: unknown

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { llm: unknown }) => {
        groqModel = options.llm
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Groq!" })),
        }
      }),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor() {
          throw new Error("ChatOpenAI should not materialize explicit Groq provider")
        }
      },
    }))
    vi.doMock("@langchain/groq", () => ({
      ChatGroq: class {
        readonly options: Record<string, unknown>

        constructor(options: Record<string, unknown>) {
          this.options = options
        }
      },
    }))

    const descriptor = agent({
      provider: "groq",
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
      vi.doUnmock("@langchain/groq")
    })

    expect((result as AIMessage).content).toBe("Groq!")
    expect((groqModel as { options: Record<string, unknown> }).options).toEqual({
      model: "gpt-4o-mini",
    })
  })

  test("DawnAgent descriptor rejects explicit falsy invalid provider", async () => {
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor() {
          throw new Error("ChatOpenAI should not materialize invalid explicit provider")
        }
      },
    }))

    const descriptor = agent({
      provider: "" as never,
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
    })

    const error = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })
      .catch((e: Error) => e)
      .finally(() => {
        vi.doUnmock("@langchain/openai")
      })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Unsupported agent provider ""')
    expect((error as Error).message).not.toContain("ChatOpenAI")
  })

  test("DawnAgent descriptor infers non-OpenAI provider from model", async () => {
    let anthropicModel: unknown

    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn((options: { llm: unknown }) => {
        anthropicModel = options.llm
        return {
          invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Anthropic!" })),
        }
      }),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor() {
          throw new Error("ChatOpenAI should not materialize inferred non-OpenAI provider")
        }
      },
    }))
    vi.doMock("@langchain/anthropic", () => ({
      ChatAnthropic: class {
        readonly options: Record<string, unknown>

        constructor(options: Record<string, unknown>) {
          this.options = options
        }
      },
    }))

    const descriptor = agent({
      model: "claude-sonnet-4-5",
      systemPrompt: "You are helpful.",
    })

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
      vi.doUnmock("@langchain/anthropic")
    })

    expect((result as AIMessage).content).toBe("Anthropic!")
    expect((anthropicModel as { options: Record<string, unknown> }).options).toEqual({
      model: "claude-sonnet-4-5",
    })
  })

  test("legacy agent with invoke() still works", async () => {
    const mockAgent = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "Legacy!" })),
    }

    const result = await executeAgent({
      checkpointer: new MemorySaver(),
      entry: mockAgent,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })

    expect(mockAgent.invoke).toHaveBeenCalled()
    expect((result as AIMessage).content).toBe("Legacy!")
  })

  test("route params are separated from agent input", async () => {
    const mockAgent = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: "ok" })),
    }

    await executeAgent({
      checkpointer: new MemorySaver(),
      entry: mockAgent,
      input: { tenant: "acme", question: "hello" },
      routeParamNames: ["tenant"],
      signal: new AbortController().signal,
      tools: [],
    })

    const call = mockAgent.invoke.mock.calls[0]
    const invokeInput = call?.[0] as { messages: Array<{ content: string }> }
    const invokeConfig = call?.[1] as { configurable?: Record<string, unknown> }
    expect(invokeInput?.messages[0]?.content).toBe("hello")
    expect(invokeConfig?.configurable).toEqual({ tenant: "acme" })
  })

  test("recursionLimit from the descriptor is passed into the graph config", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage({ content: "ok" }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn(() => ({ invoke })),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor(public options: Record<string, unknown>) {}
      },
    }))

    const descriptor = agent({
      model: "gpt-4o-mini",
      systemPrompt: "You are helpful.",
      recursionLimit: 123,
    })

    await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    })

    const invokeConfig = invoke.mock.calls[0]?.[1] as { recursionLimit?: number }
    expect(invokeConfig?.recursionLimit).toBe(123)
  })

  test("no recursionLimit leaves the graph config default (unset)", async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage({ content: "ok" }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn(() => ({ invoke })),
    }))
    vi.doMock("@langchain/openai", () => ({
      ChatOpenAI: class {
        constructor(public options: Record<string, unknown>) {}
      },
    }))

    const descriptor = agent({ model: "gpt-4o-mini", systemPrompt: "You are helpful." })

    await executeAgent({
      checkpointer: new MemorySaver(),
      entry: descriptor,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    }).finally(() => {
      vi.doUnmock("@langchain/langgraph/prebuilt")
      vi.doUnmock("@langchain/openai")
    })

    const invokeConfig = invoke.mock.calls[0]?.[1] as { recursionLimit?: number }
    expect(invokeConfig?.recursionLimit).toBeUndefined()
  })
})

describe("logical-identity root tool projection", () => {
  function streamOf(events: readonly Record<string, unknown>[]) {
    return {
      invoke: vi.fn(),
      async *streamEvents() {
        yield* events
      },
    }
  }

  async function collect(entry: { invoke: unknown; streamEvents: unknown }) {
    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: entry as never,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  test("announces root calls from on_chat_model_end and keys results by the ToolMessage id", async () => {
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "model",
        data: {
          output: {
            content: "",
            tool_calls: [{ id: "call_probe_1", name: "probe", args: { q: "x" } }],
          },
        },
      },
      {
        event: "on_tool_start",
        run_id: "probe-run-1",
        name: "probe",
        data: { input: { q: "x" } },
      },
      {
        event: "on_tool_end",
        run_id: "probe-run-1",
        name: "probe",
        data: { output: { tool_call_id: "call_probe_1", content: "probe-ok" } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: { ok: true } } },
    ])

    await expect(collect(entry)).resolves.toEqual([
      { type: "tool_call", data: { id: "call_probe_1", name: "probe", input: { q: "x" } } },
      {
        type: "tool_result",
        data: {
          id: "call_probe_1",
          name: "probe",
          output: { tool_call_id: "call_probe_1", content: "probe-ok" },
        },
      },
      { type: "done", data: { ok: true } },
    ])
  })

  test("emits held frames at on_tool_end for a resume replay with no model turn", async () => {
    const entry = streamOf([
      {
        event: "on_tool_start",
        run_id: "replay-run-1",
        name: "runBash",
        data: { input: { command: "fetch" } },
      },
      {
        event: "on_tool_end",
        run_id: "replay-run-1",
        name: "runBash",
        data: { output: { tool_call_id: "call_runBash_0_0", content: "stdout" } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: { ok: true } } },
    ])

    await expect(collect(entry)).resolves.toEqual([
      {
        type: "tool_call",
        data: { id: "call_runBash_0_0", name: "runBash", input: { command: "fetch" } },
      },
      {
        type: "tool_result",
        data: {
          id: "call_runBash_0_0",
          name: "runBash",
          output: { tool_call_id: "call_runBash_0_0", content: "stdout" },
        },
      },
      { type: "done", data: { ok: true } },
    ])
  })

  test("falls back to the execution run id when no logical id exists anywhere", async () => {
    const entry = streamOf([
      {
        event: "on_tool_start",
        run_id: "legacy-run-1",
        name: "probe",
        data: { input: { q: "x" } },
      },
      {
        event: "on_tool_end",
        run_id: "legacy-run-1",
        name: "probe",
        data: { output: "plain string result" },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: { ok: true } } },
    ])

    await expect(collect(entry)).resolves.toEqual([
      { type: "tool_call", data: { id: "legacy-run-1", name: "probe", input: { q: "x" } } },
      {
        type: "tool_result",
        data: { id: "legacy-run-1", name: "probe", output: "plain string result" },
      },
      { type: "done", data: { ok: true } },
    ])
  })

  test("announced calls with no matching execution leave no stray result", async () => {
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "model",
        data: {
          output: {
            content: "",
            tool_calls: [{ id: "call_ghost_1", name: "ghost", args: {} }],
          },
        },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: { ok: true } } },
    ])

    await expect(collect(entry)).resolves.toEqual([
      { type: "tool_call", data: { id: "call_ghost_1", name: "ghost", input: {} } },
      { type: "done", data: { ok: true } },
    ])
  })

  test("ignores tool_calls with missing or empty ids and never announces twice", async () => {
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "model",
        data: {
          output: {
            content: "",
            tool_calls: [
              { id: "", name: "probe", args: {} },
              { name: "probe", args: {} },
              { id: "call_probe_1", name: "probe", args: { q: 1 } },
              { id: "call_probe_1", name: "probe", args: { q: 1 } },
            ],
          },
        },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: { ok: true } } },
    ])

    await expect(collect(entry)).resolves.toEqual([
      { type: "tool_call", data: { id: "call_probe_1", name: "probe", input: { q: 1 } } },
      { type: "done", data: { ok: true } },
    ])
  })

  test("on_tool_error discards the held start without emitting frames", async () => {
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "model",
        data: {
          output: {
            content: "",
            tool_calls: [{ id: "call_gated_1", name: "runBash", args: { command: "x" } }],
          },
        },
      },
      {
        event: "on_tool_start",
        run_id: "gated-run-1",
        name: "runBash",
        data: { input: { command: "x" } },
      },
      {
        event: "on_tool_error",
        run_id: "gated-run-1",
        name: "runBash",
        data: {
          error: {
            name: "GraphInterrupt",
            interrupts: [{ id: "int-1", value: { interruptId: "int-1", kind: "command" } }],
          },
        },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])

    await expect(collect(entry)).resolves.toEqual([
      { type: "tool_call", data: { id: "call_gated_1", name: "runBash", input: { command: "x" } } },
      { type: "interrupt", data: { interruptId: "int-1", kind: "command" } },
      { type: "done", data: {} },
    ])
  })

  test("child tool events are untouched by the root re-key", async () => {
    const metadata = {
      dawn: {
        subagent_stack: [{ callId: "call-child", name: "researcher", routeId: "/researcher" }],
      },
    }
    const entry = streamOf([
      {
        event: "on_tool_start",
        run_id: "child-tool-run",
        name: "readFile",
        data: { input: { path: "a.md" } },
        metadata,
      },
      {
        event: "on_tool_end",
        run_id: "child-tool-run",
        name: "readFile",
        data: { output: { tool_call_id: "call_should_be_ignored", content: "text" } },
        metadata,
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])

    const chunks = await collect(entry)
    const childIdentity = {
      call_id: "call-child",
      subagent: "researcher",
      route_id: "/researcher",
      depth: 1,
    }
    expect(chunks).toEqual([
      {
        type: "subagent.tool_call",
        data: { ...childIdentity, id: "child-tool-run", tool: "readFile", input: { path: "a.md" } },
      },
      {
        type: "subagent.tool_result",
        data: {
          ...childIdentity,
          id: "child-tool-run",
          tool: "readFile",
          output: { tool_call_id: "call_should_be_ignored", content: "text" },
        },
      },
      { type: "done", data: {} },
    ])
  })
})
