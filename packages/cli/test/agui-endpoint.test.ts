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

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-agui-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "agui-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
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
): Promise<{ events: Record<string, unknown>[]; response: Response }> {
  const routeKey = encodeURIComponent("/chat#agent")
  const response = await fetch(`http://127.0.0.1:${port}/agui/${routeKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
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

async function setupControlledServer(streamRoute: typeof streamResolvedRoute): Promise<number> {
  const appRoot = await fixtureApp()
  const threads = new Map<string, { metadata: Record<string, unknown>; status: string }>()
  const server: Server = createServer((request, response) => {
    const options = {
      appRoot,
      checkpointer: { getTuple: async () => undefined } as unknown as BaseCheckpointSaver,
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
      streamRoute,
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
    void handleAgUiRequest(options).catch((error) => {
      response.statusCode = 500
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return (server.address() as AddressInfo).port
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
  const port = await setupControlledServer(streamRoute)

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
  const port = await setupControlledServer(streamRoute)
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
