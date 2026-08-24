import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Plain graph route: completes immediately, never parks, never checkpoints. */
const ECHO_ROUTE = ["export const graph = async () => ({ ok: true })", ""].join("\n")

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-ap-attach-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "ap-attach-fixture", "type": "module" }\n',
    "src/app/echo/index.ts": ECHO_ROUTE,
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

async function createHandler(appRoot: string) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

function runStreamRequest(threadId: string, route: string, input: unknown = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({ input, route }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function attachRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`)
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

interface SseEvent {
  readonly event: string
  readonly data: unknown
  readonly retry: number | undefined
}

/** Parse an SSE response body to completion into discrete events. Handles the
 * `retry:` line the durable-path terminator carries. */
async function readSse(response: Response): Promise<SseEvent[]> {
  const reader = response.body?.getReader()
  if (!reader) return []
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  const events: SseEvent[] = []
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue
    let event = "message"
    let dataLine: string | undefined
    let retry: number | undefined
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length)
      else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length)
      else if (line.startsWith("retry: ")) retry = Number(line.slice("retry: ".length))
    }
    if (dataLine === undefined && retry === undefined) continue
    events.push({ data: dataLine !== undefined ? JSON.parse(dataLine) : undefined, event, retry })
  }
  return events
}

interface ErrorBody {
  readonly error: { readonly message: string; readonly details?: { readonly code?: string } }
}

async function threadStatus(handler: Handler, threadId: string): Promise<string> {
  const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
  expect(response.status).toBe(200)
  return ((await response.json()) as { status: string }).status
}

describe("GET /threads/:thread_id/runs/stream — attach endpoint (durable path)", () => {
  it("serves the durable path for a thread that exists but has no live turn", async () => {
    const handler = await createHandler(await fixtureApp())
    const threadId = "t-durable"
    await drain(await handler.fetch(runStreamRequest(threadId, "/echo#graph")))
    expect(await threadStatus(handler, threadId)).toBe("idle")

    const res = await handler.fetch(attachRequest(threadId))

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const events = await readSse(res)
    const state = events.find((e) => e.event === "state")
    expect(state).toBeDefined()
    const stateData = state?.data as Record<string, unknown>
    expect(stateData.live).toBe(false)
    expect(stateData.anchor).toBeNull()
    expect(stateData.turn).toBeNull()
    expect(stateData.resume).toBe(false)
    expect(stateData.input).toBeNull()
    expect(stateData.run_started_at).toBeNull()
    expect(stateData.status).toBe("idle")
    expect(stateData.interrupts).toEqual([])

    const done = events.find((e) => e.event === "done")
    expect(done?.data).toEqual({ output: null })
    // The done frame is the last SUBSTANTIVE event; only the bare retry hint
    // (no event/data lines of its own) follows it.
    expect(events.indexOf(done as SseEvent)).toBe(events.length - 2)

    // retry hint: present, an integer, within [1500, 2500] — never the exact
    // value, since it is jittered with Math.random().
    const retryEvent = events.find((e) => e.retry !== undefined)
    expect(retryEvent?.retry).toBeDefined()
    const retryMs = retryEvent?.retry as number
    expect(Number.isInteger(retryMs)).toBe(true)
    expect(retryMs).toBeGreaterThanOrEqual(1500)
    expect(retryMs).toBeLessThanOrEqual(2500)
  })

  it("404s an unknown thread with thread_not_found", async () => {
    const handler = await createHandler(await fixtureApp())

    const res = await handler.fetch(attachRequest("nope"))

    expect(res.status).toBe(404)
    const body = (await res.json()) as ErrorBody
    expect(body.error.details?.code).toBe("thread_not_found")
  })

  it("409s a thread that has never run with thread_route_unknown", async () => {
    const handler = await createHandler(await fixtureApp())
    const created = await handler.fetch(new Request("http://localhost/threads", { method: "POST" }))
    const { thread_id: threadId } = (await created.json()) as { thread_id: string }

    const res = await handler.fetch(attachRequest(threadId))

    expect(res.status).toBe(409)
    const body = (await res.json()) as ErrorBody
    expect(body.error.details?.code).toBe("thread_route_unknown")
  })
})
