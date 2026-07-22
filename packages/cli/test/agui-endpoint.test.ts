import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, expect, it } from "vitest"
import { createAimock, script } from "../../testing/dist/index.js"
import { handleAgUiRequest } from "../src/lib/dev/agui-handler.js"
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
  const routeKey = encodeURIComponent("/chat#agent")
  const response = await fetch(`http://127.0.0.1:${port}/agui/${routeKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    body: JSON.stringify({ state: {}, tools: [], context: [], forwardedProps: {}, ...body }),
  })
  return { events: parseSseEvents(await response.text()), response }
}

async function setupServer(fixtures: ReturnType<ReturnType<typeof script>["build"]>) {
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

  const appRoot = await fixtureApp()
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
}

async function setupControlledServer(controlled: ControlledServerOptions): Promise<{
  readonly port: number
}> {
  const appRoot = await fixtureApp()
  const threads = new Map<string, { metadata: Record<string, unknown>; status: string }>()
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
      request,
      response,
      routeKey: "/chat#agent",
      signal: new AbortController().signal,
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
