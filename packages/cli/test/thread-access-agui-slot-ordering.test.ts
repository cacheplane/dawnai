import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"
import type { CreateThreadInput, Thread, ThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"
const HELLO_ROUTE = "/hello#graph"

async function setup(options: {
  readonly threadAccess: ThreadAccessPolicy
  readonly threadsStore: ThreadsStore
}): Promise<{ readonly handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>> }> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-agui-slot-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-agui-slot-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    threadAccess: options.threadAccess,
    threadsStore: options.threadsStore,
  })
  cleanup.push(() => handler.close())
  return { handler }
}

/** A minimal, schema-valid `RunAgentInput` body for `POST /agui/:routeId`. */
function aguiPost(
  routeKey: string,
  payload: { readonly threadId: string; readonly runId: string } & Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(new URL(`/agui/${encodeURIComponent(routeKey)}`, "http://localhost"), {
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    method: "POST",
    body: JSON.stringify({ state: {}, tools: [], context: [], forwardedProps: {}, ...payload }),
  })
}

/** Reads a response body to completion so a streaming run finishes and releases its slot. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const NOW = "2020-01-01T00:00:00.000Z"

/**
 * An in-memory `ThreadsStore` that hides the victim row from its FIRST
 * `getThread`, then reveals it forever after. That is exactly the TOCTOU shape
 * the AG-UI create-race gate exists for: the initial gate sees no row (so it
 * takes the `create` decision), and every later read sees the row (so the
 * recheck fires). The row is pre-seeded, so nothing has to actually race to
 * reproduce the window deterministically.
 */
function hidingStore(victimThreadId: string): ThreadsStore {
  const rows = new Map<string, Thread>()
  rows.set(victimThreadId, {
    thread_id: victimThreadId,
    created_at: NOW,
    updated_at: NOW,
    metadata: {},
    status: "idle",
  })
  let victimReads = 0
  return {
    async createThread(input: CreateThreadInput): Promise<Thread> {
      const id = input.thread_id ?? `t-${rows.size}`
      const existing = rows.get(id)
      if (existing) return existing
      const thread: Thread = {
        thread_id: id,
        created_at: NOW,
        updated_at: NOW,
        metadata: input.metadata ?? {},
        status: "idle",
      }
      rows.set(id, thread)
      return thread
    },
    async getThread(threadId: string): Promise<Thread | undefined> {
      if (threadId === victimThreadId) {
        victimReads += 1
        if (victimReads === 1) return undefined
      }
      return rows.get(threadId)
    },
    async deleteThread(threadId: string): Promise<void> {
      rows.delete(threadId)
    },
    async listThreads(): Promise<Thread[]> {
      return [...rows.values()]
    },
    async updateStatus(threadId: string, status): Promise<void> {
      const row = rows.get(threadId)
      if (row) rows.set(threadId, { ...row, status })
    },
    async updateMetadata(threadId: string, patch): Promise<void> {
      const row = rows.get(threadId)
      if (row) rows.set(threadId, { ...row, metadata: { ...row.metadata, ...patch } })
    },
  }
}

describe("AG-UI run-slot ordering under a create-race denial", () => {
  it("does not hold the victim's run slot while the row recheck is pending", async () => {
    const victim = "t-victim"
    const bEnteredRecheck = deferred()
    const releaseB = deferred()

    // `create` allows everyone (the row is absent at B's first gate). `update`
    // blocks-then-denies caller B's recheck and allows caller A immediately;
    // the two are told apart by a header the gate carries from each request.
    const policy: ThreadAccessPolicy = {
      fallback: () => ({ decision: "allow" }),
      create: () => ({ decision: "allow" }),
      update: async (request) => {
        if (request.headers["x-caller"] === "b") {
          bEnteredRecheck.resolve()
          await releaseB.promise
          return { decision: "deny" }
        }
        return { decision: "allow" }
      },
    }

    const { handler } = await setup({ threadAccess: policy, threadsStore: hidingStore(victim) })

    // B: gate sees no row -> `create` allow -> recheck as `update` -> BLOCKS.
    const bResponse = handler.fetch(
      aguiPost(
        HELLO_ROUTE,
        { messages: [], threadId: victim, runId: "run-b" },
        { "x-caller": "b" },
      ),
    )
    await bEnteredRecheck.promise

    // While B is parked in its recheck, a concurrent, authorized run by A on the
    // SAME thread must be able to claim the run slot. If B claimed the slot
    // before authorizing the row, A is locked out with 409 run_in_flight.
    const aResponse = await handler.fetch(
      aguiPost(
        HELLO_ROUTE,
        { messages: [], threadId: victim, runId: "run-a" },
        { "x-caller": "a" },
      ),
    )
    expect(aResponse.status).not.toBe(409)
    expect(aResponse.status).toBe(200)
    await drain(aResponse)

    releaseB.resolve()
    const settledB = await bResponse
    expect(settledB.status).toBe(403)
  })
})
