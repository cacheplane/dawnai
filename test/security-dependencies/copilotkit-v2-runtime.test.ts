import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const requestTimeoutMs = 5_000

const routeCases = [
  {
    label: "chat",
    modulePath: "../../examples/chat/web/app/api/copilotkit/[...path]/route.ts",
    expectedPath: "/agui/%2Fchat%23agent",
    importRoute: () => import("../../examples/chat/web/app/api/copilotkit/[...path]/route.ts"),
  },
  {
    label: "research",
    modulePath: "../../examples/research/web/app/api/copilotkit/[...path]/route.ts",
    expectedPath: "/agui/%2Fresearch%23agent",
    importRoute: () => import("../../examples/research/web/app/api/copilotkit/[...path]/route.ts"),
  },
] as const

type RouteLabel = (typeof routeCases)[number]["label"]

interface RouteModule {
  GET(request: Request): Promise<Response>
  POST(request: Request): Promise<Response>
}

interface RecordedRequest {
  readonly accept: string
  readonly body: unknown
  readonly contentType: string
  readonly method: string
  readonly url: string
}

const dawnServerUrlEnvKey = "DAWN_SERVER_URL"
const originalDawnServerUrl = process.env[dawnServerUrlEnvKey]
const recordedRequests: RecordedRequest[] = []
const routeModules: Partial<Record<RouteLabel, RouteModule>> = {}
let fixtureServer: Server | undefined

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "")
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const rawBody = Buffer.concat(chunks).toString("utf8")
  return rawBody.length > 0 ? JSON.parse(rawBody) : null
}

function fixtureForPath(path: string): (typeof routeCases)[number] | undefined {
  return routeCases.find((routeCase) => routeCase.expectedPath === path)
}

function createFixtureServer(): Server {
  const server = createServer((request, response) => {
    void (async () => {
      let body: unknown
      try {
        body = await readRequestBody(request)
      } catch {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "invalid JSON" }))
        return
      }

      const recordedRequest = {
        accept: headerValue(request.headers.accept),
        body,
        contentType: headerValue(request.headers["content-type"]),
        method: request.method ?? "",
        url: request.url ?? "",
      }
      recordedRequests.push(recordedRequest)

      const fixture = fixtureForPath(recordedRequest.url)
      if (fixture === undefined) {
        response.writeHead(404, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "unexpected AG-UI path" }))
        return
      }
      if (recordedRequest.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "unexpected method" }))
        return
      }

      const threadId = `${fixture.label}-thread`
      const runId = `${fixture.label}-run`
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "TEXT_MESSAGE_START", messageId: "assistant-1", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "assistant-1",
          delta: "dawn-v2-sentinel",
        },
        { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
        { type: "RUN_FINISHED", threadId, runId },
      ]

      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      })
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" })
      }
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
  })
  server.headersTimeout = requestTimeoutMs
  server.requestTimeout = requestTimeoutMs
  return server
}

async function startOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      if (server.listening) server.close()
      reject(new Error(`fixture server did not start within ${requestTimeoutMs}ms`))
    }, requestTimeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      server.off("error", onError)
      server.off("listening", onListening)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onListening = () => {
      cleanup()
      resolve()
    }

    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(0, "127.0.0.1")
  })

  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not expose an IPv4 address")
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`
}

async function closeFixtureServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections()
      reject(new Error(`fixture server did not close within ${requestTimeoutMs}ms`))
    }, requestTimeoutMs)
    server.close((error) => {
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

function restoreDawnServerUrl(): void {
  if (originalDawnServerUrl === undefined) delete process.env[dawnServerUrlEnvKey]
  else process.env[dawnServerUrlEnvKey] = originalDawnServerUrl
}

function routeModule(label: RouteLabel): RouteModule {
  const loaded = routeModules[label]
  if (loaded === undefined) throw new Error(`${label} route module was not loaded`)
  return loaded
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
}

async function readRunStream(stream: ReadableStream<unknown>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (typeof value === "string") output += value
      else if (value instanceof Uint8Array) output += decoder.decode(value, { stream: true })
      else throw new Error(`unexpected response stream chunk: ${typeof value}`)
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseSseDataFrames(stream: string): Record<string, unknown>[] {
  const normalized = stream.replaceAll("\r\n", "\n")
  if (!normalized.endsWith("\n\n")) {
    throw new Error("SSE stream ended with an incomplete frame")
  }

  return normalized
    .slice(0, -2)
    .split("\n\n")
    .map((frame, index) => {
      const lines = frame.split("\n")
      const dataLine = lines[0]
      if (lines.length !== 1 || dataLine === undefined || !dataLine.startsWith("data: ")) {
        throw new Error(`SSE frame ${index} was not a single data payload line`)
      }

      const event: unknown = JSON.parse(dataLine.slice("data: ".length))
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw new Error(`SSE frame ${index} did not contain a JSON object`)
      }
      return event as Record<string, unknown>
    })
}

beforeAll(async () => {
  fixtureServer = createFixtureServer()
  try {
    process.env[dawnServerUrlEnvKey] = await startOnLoopback(fixtureServer)
    const loadedModules = await Promise.all(
      routeCases.map(
        async (routeCase) => [routeCase.label, await routeCase.importRoute()] as const,
      ),
    )
    for (const [label, loadedModule] of loadedModules) routeModules[label] = loadedModule
  } catch (error) {
    try {
      await closeFixtureServer(fixtureServer)
    } finally {
      restoreDawnServerUrl()
    }
    throw error
  }
})

afterAll(async () => {
  try {
    if (fixtureServer !== undefined) await closeFixtureServer(fixtureServer)
  } finally {
    restoreDawnServerUrl()
  }
})

beforeEach(() => {
  recordedRequests.length = 0
})

describe.each(routeCases)(
  "$label CopilotKit V2 runtime ($modulePath)",
  ({ label, expectedPath }) => {
    it("reports stable runtime information without contacting Dawn", async () => {
      const info = await routeModule(label).GET(
        new Request("http://dawn.test/api/copilotkit/info", {
          signal: AbortSignal.timeout(requestTimeoutMs),
        }),
      )

      expect(info.status).toBe(200)
      expect(await info.json()).toMatchObject({
        version: "1.68.3",
        mode: "sse",
        agents: { default: { name: "default" } },
      })
      expect(recordedRequests).toHaveLength(0)
    })

    it("rejects malformed run input before contacting Dawn", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
      try {
        const invalidRun = await routeModule(label).POST(
          jsonRequest("http://dawn.test/api/copilotkit/agent/default/run", {}),
        )

        expect(invalidRun.status).toBe(400)
        expect(await invalidRun.json()).toMatchObject({
          error: "Invalid request body",
          details: expect.stringContaining("threadId"),
        })
        expect(recordedRequests).toHaveLength(0)
      } finally {
        consoleError.mockRestore()
      }
    })

    it("streams a real HttpAgent run across the encoded Dawn AG-UI boundary", async () => {
      const input = {
        threadId: `${label}-thread`,
        runId: `${label}-run`,
        state: {},
        messages: [{ id: `${label}-message`, role: "user", content: "hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      }
      const run = await routeModule(label).POST(
        jsonRequest("http://dawn.test/api/copilotkit/agent/default/run", input),
      )

      expect(run.status).toBe(200)
      expect(run.headers.get("content-type")).toContain("text/event-stream")
      if (run.body === null) throw new Error("CopilotKit run response did not include a body")
      const stream = await readRunStream(run.body as ReadableStream<unknown>)
      const events = parseSseDataFrames(stream)
      expect(events.map((event) => event.type)).toEqual([
        "RUN_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
      ])
      expect(events[2]).toMatchObject({
        type: "TEXT_MESSAGE_CONTENT",
        delta: "dawn-v2-sentinel",
      })

      expect(recordedRequests).toHaveLength(1)
      expect(recordedRequests[0]).toMatchObject({
        url: expectedPath,
        method: "POST",
        accept: expect.stringContaining("text/event-stream"),
        contentType: expect.stringContaining("application/json"),
        body: {
          threadId: input.threadId,
          runId: input.runId,
          state: {},
          messages: [
            {
              id: `${label}-message`,
              role: "user",
              content: "hello",
            },
          ],
          tools: [],
          context: [],
          forwardedProps: {},
        },
      })
    })
  },
)
