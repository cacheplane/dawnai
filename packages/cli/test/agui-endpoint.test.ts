import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSubagentsMarker } from "@dawn-ai/core"
import {
  convertSubagentTaskToLangChain,
  type SubagentResolver,
  streamAgent,
} from "@dawn-ai/langchain"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch"
import { AIMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  Annotation,
  Command,
  END,
  interrupt as langGraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { handleAgUiRequest } from "../src/lib/dev/agui-handler.js"
import { createPendingResumeClaims } from "../src/lib/dev/pending-interrupts.js"
import { createRunRegistry } from "../src/lib/dev/run-registry.js"
import { createRuntimeRequestListener } from "../src/lib/dev/runtime-server.js"
import type { streamResolvedRoute } from "../src/lib/runtime/execute-route.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-agui-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "agui-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(appRoot, rel)
    await mkdir(join(p, ".."), { recursive: true })
    await writeFile(p, body, "utf8")
  }
  return appRoot
}

/** Agent route whose `deployProd` tool needs human approval, so the first call
 * to it parks the turn on a real checkpointer-backed HITL interrupt. Same shape
 * the Agent Protocol suite parks with, so both surfaces are proven against the
 * same kind of park rather than a hand-rolled interrupt chunk. */
const PARK_ROUTE = [
  'import { agent } from "@dawn-ai/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  '  tools: { approve: ["deployProd"] },',
  "})",
  "",
].join("\n")

const DEPLOY_TOOL = [
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  "  return 'deployed to ' + input.env",
  "}",
  "",
].join("\n")

function parseSseEvents(text: string): Record<string, unknown>[] {
  return text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length)
    return data ? [JSON.parse(data) as Record<string, unknown>] : []
  })
}

async function postRun(
  port: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ events: Record<string, unknown>[]; response: Response }> {
  const response = await requestRun(port, body, headers)
  return { events: parseSseEvents(await response.text()), response }
}

async function requestRun(
  port: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  const routeKey = encodeURIComponent("/chat#agent")
  return await fetch(`http://127.0.0.1:${port}/agui/${routeKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    body: JSON.stringify({ state: {}, tools: [], context: [], forwardedProps: {}, ...body }),
    ...(signal ? { signal } : {}),
  })
}

async function setupServer(
  fixtures: ReturnType<ReturnType<typeof script>["build"]>,
  overrides: Record<string, string> = {},
) {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)

  const appRoot = await fixtureApp(overrides)
  const { listener, close } = await createRuntimeRequestListener({ appRoot })
  cleanup.push(() => close())

  const server: Server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return { port }
}

interface ControlledServerOptions {
  readonly checkpointer?: BaseCheckpointSaver
  readonly streamRoute: typeof streamResolvedRoute
  readonly shutdownSignal?: AbortSignal
}

async function setupControlledServer(controlled: ControlledServerOptions): Promise<{
  readonly port: number
}> {
  const appRoot = await fixtureApp()
  const threads = new Map<string, { metadata: Record<string, unknown>; status: string }>()
  const resumeClaims = createPendingResumeClaims()
  const runRegistry = createRunRegistry()
  const server: Server = createServer((request, response) => {
    const threadMatch = request.url?.match(/^\/threads\/([^/]+)$/)
    if (request.method === "GET" && threadMatch) {
      const thread = threads.get(decodeURIComponent(threadMatch[1] ?? ""))
      response.statusCode = thread ? 200 : 404
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(thread ?? { error: "not found" }))
      return
    }
    const requestOptions = {
      appRoot,
      checkpointer:
        controlled.checkpointer ??
        ({ getTuple: async () => undefined } as unknown as BaseCheckpointSaver),
      middleware: undefined,
      registry: {
        appRoot,
        entries: [],
        lookup: () => ({
          assistantId: "/chat#agent",
          mode: "agent" as const,
          routeFile: join(appRoot, "src/app/chat/index.ts"),
          routeId: "/chat",
          routePath: "src/app/chat/index.ts",
        }),
      },
      resumeClaims,
      runRegistry,
      request,
      response,
      routeKey: "/chat#agent",
      signal: controlled.shutdownSignal ?? new AbortController().signal,
      streamRoute: controlled.streamRoute,
      threadsStore: {
        createThread: async ({ thread_id }: { thread_id?: string }) => {
          const threadId = thread_id ?? "generated"
          const now = new Date().toISOString()
          threads.set(threadId, { metadata: {}, status: "idle" })
          return {
            thread_id: threadId,
            created_at: now,
            updated_at: now,
            metadata: {},
            status: "idle" as const,
          }
        },
        getThread: async (threadId: string) => {
          const thread = threads.get(threadId)
          if (!thread) return undefined
          const now = new Date().toISOString()
          return {
            thread_id: threadId,
            created_at: now,
            updated_at: now,
            metadata: thread.metadata,
            status: thread.status as "idle" | "busy" | "interrupted",
          }
        },
        updateMetadata: async (threadId: string, patch: Record<string, unknown>) => {
          const thread = threads.get(threadId)
          if (thread) thread.metadata = { ...thread.metadata, ...patch }
        },
        updateStatus: async (threadId: string, status: string) => {
          const thread = threads.get(threadId)
          if (thread) thread.status = status
        },
      } as unknown as ThreadsStore,
    }
    void handleAgUiRequest(requestOptions).catch((error) => {
      response.statusCode = 500
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return {
    port: (server.address() as AddressInfo).port,
  }
}

async function parallelSubagentTask(firstInterruptObserved: Promise<void>) {
  const contribution = await createSubagentsMarker().load("/fixture", {
    subagentRegistry: [
      {
        description: "Fixture child.",
        name: "researcher",
        routeId: "/fixture/subagents/researcher",
        rule: { action: "allow" },
        source: "convention",
      },
    ],
  } as never)
  const placeholder = contribution.tools?.find(({ name }) => name === "task")
  if (!placeholder) throw new Error("Expected task placeholder")

  const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
  const child = new StateGraph(ChildState)
    .addNode("approval", async (state, config) => {
      const input = String((state.messages[0] as { content?: unknown } | undefined)?.content)
      if (input === "B") {
        await firstInterruptObserved
        await dispatchCustomEvent(
          "dawn.capability",
          { event: "native.progress", data: { input } },
          config,
        )
      }
      const decision = langGraphInterrupt({
        interruptId: `perm-child-${input}`,
        type: "permission-request",
        kind: "tool",
        detail: { suggestedPattern: input, toolName: "fixture" },
      })
      return { messages: [new AIMessage(`child:${input}:${decision}`)] }
    })
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile()
  const resolver: SubagentResolver = async () => ({
    ok: true,
    child: { graph: child, routeId: "/parent/subagents/researcher" },
  })
  return convertSubagentTaskToLangChain(placeholder, resolver)
}

function parallelSubagentRoot(
  task: Awaited<ReturnType<typeof parallelSubagentTask>>,
  checkpointer: MemorySaver,
) {
  const RootState = Annotation.Root({
    results: Annotation<string[]>({
      reducer: (left, right) => [...left, ...right],
      default: () => [],
    }),
  })
  const dispatch =
    (callId: string, input: string) => async (_state: unknown, config: RunnableConfig) => ({
      results: [
        await task.func({ input, subagent: "researcher" }, undefined, {
          ...config,
          toolCall: { id: callId },
        } as RunnableConfig),
      ],
    })
  return new StateGraph(RootState)
    .addNode("first", dispatch("parallel-a", "A"))
    .addNode("second", dispatch("parallel-b", "B"))
    .addEdge(START, "first")
    .addEdge(START, "second")
    .addEdge("first", END)
    .addEdge("second", END)
    .compile({ checkpointer })
}

it("streams the canonical AG-UI lifecycle and successful result", async () => {
  const { port } = await setupServer(script().user("hello").replies("Hi there!").build())
  const { events, response } = await postRun(port, {
    threadId: "th1",
    runId: "rn1",
    messages: [{ id: "1", role: "user", content: "hello" }],
  })

  expect(response.status).toBe(200)
  expect(events.map((event) => event.type)).toEqual([
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ])
  expect(events[2]).toMatchObject({ delta: "Hi there!" })
  expect(events.at(-1)).toMatchObject({
    outcome: { type: "success" },
    result: expect.anything(),
    runId: "rn1",
    threadId: "th1",
  })
  expect(events.map((event) => event.type)).not.toContain("STATE_SNAPSHOT")
  expect(events.map((event) => event.type)).not.toContain("CUSTOM")
}, 60_000)

it("collects and resumes interleaved native parallel subagent interrupts", async () => {
  let markFirstInterruptObserved: (() => void) | undefined
  const firstInterruptObserved = new Promise<void>((resolve) => {
    markFirstInterruptObserved = resolve
  })
  const checkpointer = new MemorySaver()
  const root = parallelSubagentRoot(
    await parallelSubagentTask(firstInterruptObserved),
    checkpointer,
  )
  const entry = {
    invoke: root.invoke.bind(root),
    streamEvents: (input: unknown, config: Record<string, unknown>) =>
      root.streamEvents(input as never, { ...config, version: "v2" }),
  }
  const nativeChunkTypes: string[] = []
  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    const input = options.resume === undefined ? {} : new Command({ resume: options.resume })
    for await (const chunk of streamAgent({
      checkpointer,
      entry,
      input,
      routeParamNames: [],
      signal: options.signal ?? new AbortController().signal,
      ...(options.threadId ? { threadId: options.threadId } : {}),
      tools: [],
    })) {
      nativeChunkTypes.push(chunk.type)
      if (chunk.type === "interrupt") markFirstInterruptObserved?.()
      switch (chunk.type) {
        case "token":
          yield { type: "chunk", data: chunk.data }
          break
        case "tool_call": {
          const data = chunk.data as { id?: string; name: string; input: unknown }
          yield {
            type: "tool_call",
            ...(data.id ? { id: data.id } : {}),
            name: data.name,
            input: data.input,
          }
          break
        }
        case "tool_result": {
          const data = chunk.data as { id?: string; name: string; output: unknown }
          yield {
            type: "tool_result",
            ...(data.id ? { id: data.id } : {}),
            name: data.name,
            output: data.output,
          }
          break
        }
        case "done":
          yield { type: "done", output: chunk.data }
          break
        default:
          yield { type: chunk.type, data: chunk.data }
          break
      }
    }
  }
  const { port } = await setupControlledServer({ checkpointer, streamRoute })

  const first = await postRun(port, {
    threadId: "parallel-subagents",
    runId: "parallel-first",
    messages: [{ id: "1", role: "user", content: "delegate in parallel" }],
  })

  expect(first.response.status).toBe(200)
  const finished = first.events.filter(({ type }) => type === "RUN_FINISHED")
  expect(finished).toHaveLength(1)
  expect(finished[0]).not.toHaveProperty("result")
  const interrupts = (
    finished[0]?.outcome as { interrupts?: Array<{ id: string }>; type?: string } | undefined
  )?.interrupts
  expect(new Set(interrupts?.map(({ id }) => id))).toEqual(
    new Set(["perm-child-A", "perm-child-B"]),
  )
  const nativeInterruptIndexes = nativeChunkTypes.flatMap((type, index) =>
    type === "interrupt" ? [index] : [],
  )
  expect(nativeInterruptIndexes).toHaveLength(2)
  const [firstInterruptIndex, secondInterruptIndex] = nativeInterruptIndexes
  if (firstInterruptIndex === undefined || secondInterruptIndex === undefined) {
    throw new Error("Expected two native interrupt chunks")
  }
  expect(nativeChunkTypes.slice(firstInterruptIndex + 1, secondInterruptIndex)).toContain(
    "subagent.native.progress",
  )

  const resumed = await postRun(port, {
    threadId: "parallel-subagents",
    runId: "parallel-resume",
    messages: [],
    resume: [
      { interruptId: "perm-child-A", payload: "once", status: "resolved" },
      { interruptId: "perm-child-B", payload: "always", status: "resolved" },
    ],
  })

  expect(resumed.response.status).toBe(200)
  expect(resumed.events.at(-1)).toMatchObject({ outcome: { type: "success" } })
  const result = resumed.events.at(-1)?.result as { results?: string[] } | undefined
  expect(result?.results?.sort()).toEqual(["child:A:once", "child:B:always"])
}, 60_000)

it("forwards only the newest user message on a later turn", async () => {
  const routeInputs: unknown[] = []
  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    routeInputs.push(options.input)
    yield { type: "done", output: { received: options.input } }
  }
  const { port } = await setupControlledServer({ streamRoute })

  await postRun(port, {
    threadId: "same-thread",
    runId: "run-1",
    messages: [{ id: "1", role: "user", content: "first" }],
  })
  const { events, response } = await postRun(port, {
    threadId: "same-thread",
    runId: "run-2",
    messages: [
      { id: "1", role: "user", content: "first" },
      { id: "2", role: "assistant", content: "one" },
      { id: "3", role: "user", content: "second" },
    ],
  })

  expect(response.status).toBe(200)
  expect(routeInputs).toEqual([
    { messages: [{ role: "user", content: "first" }] },
    { messages: [{ role: "user", content: "second" }] },
  ])
  expect(events.at(-1)).toMatchObject({
    result: { received: { messages: [{ role: "user", content: "second" }] } },
  })
}, 60_000)

it("rejects a concurrent AG-UI run on the same thread", async () => {
  let markStarted: (() => void) | undefined
  let releaseRoute: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseRoute = resolve
  })
  cleanup.push(() => releaseRoute?.())

  const streamRoute: typeof streamResolvedRoute = async function* () {
    markStarted?.()
    await released
    yield { type: "done", output: { ok: true } }
  }
  const { port } = await setupControlledServer({ streamRoute })
  const body = {
    threadId: "concurrent-agui",
    runId: "run-1",
    messages: [{ id: "1", role: "user", content: "wait" }],
  }

  const first = await requestRun(port, body)
  await started
  const second = await requestRun(port, { ...body, runId: "run-2" })

  expect(second.status).toBe(409)
  await expect(second.json()).resolves.toMatchObject({
    error: { details: { code: "run_in_flight" } },
  })

  releaseRoute?.()
  await first.text()
}, 10_000)

it("preserves the upstream invocation id across canonical AG-UI tool events", async () => {
  const upstreamInvocationId = "upstream-invocation-42"
  const streamRoute: typeof streamResolvedRoute = async function* () {
    yield {
      type: "tool_call",
      id: upstreamInvocationId,
      name: "lookup",
      input: { query: "pricing" },
    }
    yield {
      type: "tool_result",
      id: upstreamInvocationId,
      name: "lookup",
      output: { answer: "pricing" },
    }
    yield { type: "done", output: { ok: true } }
  }
  const { port } = await setupControlledServer({ streamRoute })
  const { events, response } = await postRun(port, {
    threadId: "tool-thread",
    runId: "tool-run",
    messages: [{ id: "1", role: "user", content: "look up pricing" }],
  })

  expect(response.status).toBe(200)
  const toolEvents = events.filter((event) => String(event.type).startsWith("TOOL_CALL"))
  expect(toolEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "TOOL_CALL_START", toolCallId: upstreamInvocationId }),
      expect.objectContaining({ type: "TOOL_CALL_ARGS", toolCallId: upstreamInvocationId }),
      expect.objectContaining({ type: "TOOL_CALL_END", toolCallId: upstreamInvocationId }),
      expect.objectContaining({ type: "TOOL_CALL_RESULT", toolCallId: upstreamInvocationId }),
    ]),
  )
}, 60_000)

it("runs middleware before thread creation and exposes allowed context to the route", async () => {
  const appRoot = await fixtureApp({
    "src/app/context/index.ts":
      "export const graph = async (_input, ctx) => ({ middleware: ctx.middleware })\n",
    "src/middleware.ts": `
      export default (request) => request.headers["x-api-key"] === "secret"
        ? { action: "continue", context: { tenant: "acme" } }
        : { action: "reject", status: 401, body: { error: "missing api key" } }
    `,
  })
  const runtime = await createRuntimeRequestListener({ appRoot })
  cleanup.push(() => runtime.close())
  const server = createServer(runtime.listener)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const port = (server.address() as AddressInfo).port
  const postContextRun = async (threadId: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/agui/%2Fcontext%23graph`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages: [{ id: "1", role: "user", content: "hello" }],
        runId: `run-${threadId}`,
        state: {},
        threadId,
        tools: [],
      }),
    })
    return { events: parseSseEvents(await response.text()), response }
  }

  const rejected = await postContextRun("middleware-rejected")
  expect(rejected.response.status).toBe(401)
  const rejectedThread = await fetch(`http://127.0.0.1:${port}/threads/middleware-rejected`)
  expect(rejectedThread.status).toBe(404)

  const allowed = await postContextRun("middleware-allowed", { "x-api-key": "secret" })
  expect(allowed.response.status).toBe(200)
  expect(allowed.events.at(-1)).toMatchObject({ result: { middleware: { tenant: "acme" } } })
})

const TASK_UUID_1 = "33a12321-3ec2-56a7-b4d7-0337886c4386"
const TASK_UUID_2 = "44b23432-4fd3-67b8-c5e8-1448997d5497"
const RESUME_KEY_1 = "3336d0e0a2d4f198ef9aecd09cd7ac27"
const RESUME_KEY_2 = "4447e1f1b3e5a209fa0bfde10de8bd38"

function checkpoint(pendingWrites: readonly unknown[]): BaseCheckpointSaver {
  return { getTuple: async () => ({ pendingWrites }) } as unknown as BaseCheckpointSaver
}

function interrupt(taskId: string, resumeKey: string, interruptId: string): unknown[] {
  return [taskId, "__interrupt__", { id: resumeKey, value: { interruptId } }]
}

async function postResumeCase(
  pendingWrites: readonly unknown[],
  resume: unknown,
): Promise<{ captured: unknown[]; events: Record<string, unknown>[]; response: Response }> {
  const captured: unknown[] = []
  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    captured.push(options.resume)
    yield { type: "done", output: { resumed: true } }
  }
  const { port } = await setupControlledServer({
    checkpointer: checkpoint(pendingWrites),
    streamRoute,
  })
  const { events, response } = await postRun(port, {
    threadId: `resume-${Math.random()}`,
    runId: "resume-run",
    messages: [],
    ...(resume === undefined ? {} : { resume }),
  })
  return { captured, events, response }
}

it.each([
  ["no resume while pending", [interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1")], undefined],
  [
    "incomplete set",
    [
      interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1"),
      interrupt(TASK_UUID_2, RESUME_KEY_2, "perm-2"),
    ],
    [{ interruptId: "perm-1", status: "cancelled" }],
  ],
  [
    "unknown entry",
    [interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1")],
    [{ interruptId: "unknown", status: "cancelled" }],
  ],
  [
    "duplicate entry",
    [interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1")],
    [
      { interruptId: "perm-1", status: "cancelled" },
      { interruptId: "perm-1", status: "cancelled" },
    ],
  ],
  [
    "malformed checkpoint address",
    [interrupt(TASK_UUID_1, "not-a-resume-key", "perm-1")],
    [{ interruptId: "perm-1", status: "cancelled" }],
  ],
  [
    "duplicate checkpoint address",
    [
      interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1"),
      interrupt(TASK_UUID_2, RESUME_KEY_1, "perm-2"),
    ],
    [
      { interruptId: "perm-1", status: "cancelled" },
      { interruptId: "perm-2", status: "cancelled" },
    ],
  ],
] as const)("rejects %s with 409 before route execution", async (_name, writes, resume) => {
  const result = await postResumeCase(writes, resume)
  expect(result.response.status).toBe(409)
  expect(result.captured).toEqual([])
})

it("rejects an invalid resolved payload with 400", async () => {
  const result = await postResumeCase(
    [interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1")],
    [{ interruptId: "perm-1", payload: "later", status: "resolved" }],
  )
  expect(result.response.status).toBe(400)
  expect(result.captured).toEqual([])
})

it("rejects resume when no interrupt is pending", async () => {
  const result = await postResumeCase([], [{ interruptId: "perm-1", status: "cancelled" }])
  expect(result.response.status).toBe(409)
  expect(result.captured).toEqual([])
})

it.each([
  {
    name: "one entry",
    writes: [interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1")],
    resume: [{ interruptId: "perm-1", payload: "once", status: "resolved" }],
    expected: { [RESUME_KEY_1]: "once" },
  },
  {
    name: "two entries",
    writes: [
      interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1"),
      interrupt(TASK_UUID_2, RESUME_KEY_2, "perm-2"),
    ],
    resume: [
      { interruptId: "perm-1", payload: "always", status: "resolved" },
      { interruptId: "perm-2", status: "cancelled" },
    ],
    expected: { [RESUME_KEY_1]: "always", [RESUME_KEY_2]: "deny" },
  },
])("passes the exact outer-keyed resume map for $name", async ({ expected, resume, writes }) => {
  const result = await postResumeCase(writes, resume)
  expect(result.response.status).toBe(200)
  expect(result.captured).toEqual([expected])
  expect(Object.keys(result.captured[0] as object)).not.toContain(TASK_UUID_1)
  expect(Object.keys(result.captured[0] as object)).not.toContain(TASK_UUID_2)
})

it("aborts route execution on client disconnect and restores the thread to idle", async () => {
  let observedSignal: AbortSignal | undefined
  let resolveRouteAborted: (() => void) | undefined
  const routeAborted = new Promise<void>((resolve) => {
    resolveRouteAborted = resolve
  })
  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    observedSignal = options.signal
    yield { type: "chunk", data: "started" }
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          resolveRouteAborted?.()
          resolve()
        },
        { once: true },
      )
    })
  }
  const { port } = await setupControlledServer({ streamRoute })
  const controller = new AbortController()
  const routeKey = encodeURIComponent("/chat#agent")
  const response = await fetch(`http://127.0.0.1:${port}/agui/${routeKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ id: "1", role: "user", content: "wait" }],
      runId: "disconnect-run",
      state: {},
      threadId: "disconnect-thread",
      tools: [],
    }),
    signal: controller.signal,
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Expected streaming response body")
  const decoder = new TextDecoder()
  let body = ""
  while (!body.includes("TEXT_MESSAGE_CONTENT")) {
    const next = await reader.read()
    if (next.done) throw new Error("Stream ended before route content")
    body += decoder.decode(next.value)
  }

  controller.abort()
  await routeAborted
  expect(observedSignal?.aborted).toBe(true)

  await expect
    .poll(async () => {
      const thread = await fetch(`http://127.0.0.1:${port}/threads/disconnect-thread`)
      return thread.ok ? ((await thread.json()) as { status: string }).status : "missing"
    })
    .toBe("idle")
})

it("holds a resume claim until a disconnected route source unwinds", async () => {
  let pendingWrites: readonly unknown[] = [interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1")]
  let calls = 0
  let markBlocked: (() => void) | undefined
  let releaseSource: (() => void) | undefined
  let markRouteAborted: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseSource = resolve
  })
  const routeAborted = new Promise<void>((resolve) => {
    markRouteAborted = resolve
  })
  cleanup.push(() => releaseSource?.())

  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    calls += 1
    if (calls === 1) {
      options.signal?.addEventListener("abort", () => markRouteAborted?.(), { once: true })
      yield { type: "chunk", data: "started" }
      markBlocked?.()
      await released
      return
    }
    yield { type: "done", output: { resumed: true } }
  }
  const { port } = await setupControlledServer({
    checkpointer: {
      getTuple: async () => ({ pendingWrites }),
    } as unknown as BaseCheckpointSaver,
    streamRoute,
  })
  const threadId = "resume-cleanup-thread"
  const body = {
    threadId,
    runId: "resume-cleanup-1",
    messages: [],
    resume: [{ interruptId: "perm-1", status: "cancelled" }],
  }
  const controller = new AbortController()
  const first = await requestRun(port, body, {}, controller.signal)
  await blocked
  controller.abort()
  await routeAborted

  pendingWrites = []
  const concurrentRun = await requestRun(port, {
    ...body,
    messages: [{ id: "2", role: "user", content: "new turn" }],
    resume: undefined,
    runId: "resume-cleanup-run-claim",
  })
  expect(concurrentRun.status).toBe(409)
  await expect(concurrentRun.json()).resolves.toMatchObject({
    error: { details: { code: "run_in_flight" } },
  })

  const concurrent = await requestRun(port, { ...body, runId: "resume-cleanup-2" })
  expect(concurrent.status).toBe(409)
  await expect(concurrent.json()).resolves.toMatchObject({
    error: { details: { code: "resume_in_progress" } },
  })

  pendingWrites = [interrupt(TASK_UUID_1, RESUME_KEY_1, "perm-1")]
  releaseSource?.()
  await expect
    .poll(async () => {
      const retry = await requestRun(port, { ...body, runId: "resume-cleanup-3" })
      if (retry.status === 200) await retry.text()
      else await retry.body?.cancel()
      return retry.status
    })
    .toBe(200)
  await first.body?.cancel().catch(() => undefined)
})

it("does not abort the route signal after a normal response", async () => {
  let routeSignal: AbortSignal | undefined
  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    routeSignal = options.signal
    yield { type: "done", output: { ok: true } }
  }
  const { port } = await setupControlledServer({ streamRoute })

  const result = await postRun(port, {
    threadId: "normal-thread",
    runId: "normal-run",
    messages: [{ id: "1", role: "user", content: "hello" }],
  })

  expect(result.response.status).toBe(200)
  expect(routeSignal?.aborted).toBe(false)
})

it("stops listening to the shutdown signal after a normal response completes", async () => {
  let routeSignal: AbortSignal | undefined
  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    routeSignal = options.signal
    yield { type: "done", output: { ok: true } }
  }
  const shutdownController = new AbortController()
  const { port } = await setupControlledServer({
    streamRoute,
    shutdownSignal: shutdownController.signal,
  })

  const result = await postRun(port, {
    threadId: "shutdown-release-thread",
    runId: "shutdown-release-run",
    messages: [{ id: "1", role: "user", content: "hello" }],
  })
  expect(result.response.status).toBe(200)
  expect(routeSignal?.aborted).toBe(false)

  shutdownController.abort()
  // Proxy for "the shutdown listener was removed after the request finished":
  // with the old AbortSignal.any composition the (already-finished) route
  // signal stayed subscribed to the shutdown signal forever, so this abort
  // would flip it to true. A removed listener leaves it false.
  expect(routeSignal?.aborted).toBe(false)
})

// ---------------------------------------------------------------------------
// A parked turn takes the NORMAL completion path here: the adapter yields the
// interrupt chunk and then `done`, so a drained stream is not evidence that the
// turn finished. AG-UI ends the run on client disconnect, but a park is durable
// state in the checkpointer and disconnecting does not un-park it — so every
// path out of the turn has to record the park, not only the one that drained.
// ---------------------------------------------------------------------------

async function postParkRun(
  port: number,
  threadId: string,
  message: string,
): Promise<{ events: Record<string, unknown>[]; response: Response }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/agui/${encodeURIComponent("/park#agent")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages: [{ id: "1", role: "user", content: message }],
        runId: "park-run",
        state: {},
        threadId,
        tools: [],
      }),
    },
  )
  return { events: parseSseEvents(await response.text()), response }
}

async function threadStatus(port: number, threadId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/threads/${threadId}`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { status: string }).status
}

/** Interrupt chunk in Dawn's own vocabulary — what `streamResolvedRoute` yields
 * when a turn parks, upstream of the AG-UI translation. */
function interruptChunk(interruptId: string) {
  return {
    type: "interrupt" as const,
    data: { interruptId, kind: "tool", type: "permission-request" },
  }
}

it("marks the thread interrupted when an AG-UI turn parks on a permission prompt", async () => {
  const { port } = await setupServer(
    script().user("deploy to staging").callsTool("deployProd", { env: "staging" }).build(),
    { "src/app/park/index.ts": PARK_ROUTE, "src/app/park/tools/deployProd.ts": DEPLOY_TOOL },
  )

  const { events, response } = await postParkRun(port, "agui-parked", "deploy to staging")

  expect(response.status).toBe(200)
  // Pins the premise rather than assuming it: without this the test passes
  // vacuously the day the fixture stops parking.
  expect(events.at(-1)).toMatchObject({ outcome: { type: "interrupt" } })
  expect(await threadStatus(port, "agui-parked")).toBe("interrupted")
}, 60_000)

it("returns the thread to idle when an AG-UI turn completes without parking", async () => {
  const { port } = await setupServer(script().user("hello").replies("Hi there!").build())

  const { events } = await postRun(port, {
    threadId: "agui-completed",
    runId: "completed-run",
    messages: [{ id: "1", role: "user", content: "hello" }],
  })

  // The other half of the rule: a turn that genuinely finished must not be
  // dressed up as interrupted just because the parked case now is.
  expect(events.at(-1)).toMatchObject({ outcome: { type: "success" } })
  expect(await threadStatus(port, "agui-completed")).toBe("idle")
}, 60_000)

it("keeps a parked thread interrupted when the turn then fails", async () => {
  const streamRoute: typeof streamResolvedRoute = async function* () {
    yield interruptChunk("perm-then-fail")
    throw new Error("route failed after parking")
  }
  const { port } = await setupControlledServer({ streamRoute })

  const { events } = await postRun(port, {
    threadId: "parked-then-failed",
    runId: "parked-then-failed-run",
    messages: [{ id: "1", role: "user", content: "deploy" }],
  })

  // toAguiEvents never throws into its consumer, so the failure arrives as a
  // RUN_ERROR and the handler's loop drains — the same status write covers both.
  expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR" })
  expect(await threadStatus(port, "parked-then-failed")).toBe("interrupted")
})

it("keeps a parked thread interrupted when the client disconnects after the park", async () => {
  let markParked: (() => void) | undefined
  const parked = new Promise<void>((resolve) => {
    markParked = resolve
  })
  const streamRoute: typeof streamResolvedRoute = async function* (options) {
    yield interruptChunk("perm-then-disconnect")
    // Reached only once the consumer has pulled the interrupt chunk, so the
    // disconnect below is guaranteed to land AFTER the park was observed.
    markParked?.()
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener("abort", () => resolve(), { once: true })
    })
  }
  const { port } = await setupControlledServer({ streamRoute })
  const controller = new AbortController()

  const response = await requestRun(
    port,
    {
      threadId: "parked-then-disconnected",
      runId: "parked-then-disconnected-run",
      messages: [{ id: "1", role: "user", content: "deploy" }],
    },
    {},
    controller.signal,
  )
  expect(response.status).toBe(200)
  await parked
  controller.abort()

  // Ending the run does not end the wait for the human: the interrupt is
  // already in the checkpoint, so a client that reconnects must not be told
  // the agent finished.
  await expect.poll(async () => threadStatus(port, "parked-then-disconnected")).toBe("interrupted")
})
