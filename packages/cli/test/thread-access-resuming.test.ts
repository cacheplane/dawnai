import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadAccessPolicy, ThreadAccessRequest } from "@dawn-ai/sdk"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { RunnableConfig } from "@langchain/core/runnables"
import type {
  BaseCheckpointSaver,
  CheckpointPendingWrite,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint"
import { emptyCheckpoint, MemorySaver } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"
const HELLO_ROUTE = "/hello#graph"

/**
 * Same fixture-app shape as `thread-access-run-endpoints.test.ts`, plus the
 * `checkpointer` seam — the AG-UI resume path only reaches its later gate sites
 * when `resolvePendingResume` succeeds, and that needs a parked interrupt.
 */
async function setup(
  options: {
    readonly checkpointer?: BaseCheckpointSaver
    readonly threadAccess?: ThreadAccessPolicy
    readonly threadsStore?: ThreadsStore
  } = {},
): Promise<{
  readonly handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>>
}> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-resuming-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-resuming-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    drainDeadlineMs: 250,
    ...(options.threadAccess ? { threadAccess: options.threadAccess } : {}),
    ...(options.threadsStore ? { threadsStore: options.threadsStore } : {}),
  })
  cleanup.push(() => handler.close())
  return { handler }
}

function post(path: string, payload?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), {
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), {
    headers,
    method: "GET",
  })
}

/** A minimal, schema-valid `RunAgentInput` body for `POST /agui/:routeId`. */
function aguiPost(
  routeKey: string,
  payload: { readonly threadId: string; readonly runId: string } & Record<string, unknown>,
): Request {
  return new Request(new URL(`/agui/${encodeURIComponent(routeKey)}`, "http://localhost"), {
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    method: "POST",
    body: JSON.stringify({
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
      ...payload,
    }),
  })
}

/** Reads the response body to completion so a streaming run finishes and releases its slot. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

/** What a policy was asked, request by request, in order. */
interface Seen {
  readonly action: ThreadAccessRequest["action"]
  readonly operation: ThreadAccessRequest["operation"]
  readonly resuming: unknown
}

interface RecordingPolicy {
  readonly policy: ThreadAccessPolicy
  readonly seen: Seen[]
}

/** Allows everything and records the shape of every request the gate built. */
function recordingAllowPolicy(): RecordingPolicy {
  const seen: Seen[] = []
  return {
    seen,
    policy: {
      fallback: (request) => {
        seen.push({
          action: request.action,
          operation: request.operation,
          resuming: request.resuming,
        })
        return { decision: "allow" }
      },
    },
  }
}

const PARKED_THREAD_ID = "t-parked"
const PARKED_INTERRUPT_ID = "perm-1786"
const PARKED_RESUME_KEY = "ff5e1ad9ff5e1ad9ff5e1ad9ff5e1ad9"

const PARKED_WRITE: CheckpointPendingWrite = [
  "task-1",
  "__interrupt__",
  { id: PARKED_RESUME_KEY, value: { interruptId: PARKED_INTERRUPT_ID } },
]

/**
 * Reports one well-formed parked interrupt on `PARKED_THREAD_ID`, so an AG-UI
 * request carrying a matching `resume` gets past `resolvePendingResume` and
 * reaches the gate sites that sit behind it. The route here never parks for
 * real — this endpoint's gate sites read nothing but `pendingWrites`.
 */
class ParkedInterruptSaver extends MemorySaver {
  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(config)
    if (config.configurable?.thread_id !== PARKED_THREAD_ID) return tuple
    return {
      checkpoint: tuple?.checkpoint ?? emptyCheckpoint(),
      config,
      ...(tuple?.metadata ? { metadata: tuple.metadata } : {}),
      pendingWrites: [PARKED_WRITE],
    }
  }
}

describe("ThreadAccessRequest.resuming", () => {
  it("is true on POST /threads/:id/resume", async () => {
    const { policy, seen } = recordingAllowPolicy()
    const { handler } = await setup({ threadAccess: policy })

    await drain(
      await handler.fetch(
        post("/threads/t-resume/resume", {
          resume: [
            {
              interruptId: PARKED_INTERRUPT_ID,
              payload: "once",
              status: "resolved",
            },
          ],
          route: HELLO_ROUTE,
        }),
      ),
    )

    expect(seen).toEqual([{ action: "update", operation: "run.resume", resuming: true }])
  })

  it("is true on an AG-UI request that carries a resume", async () => {
    const { policy, seen } = recordingAllowPolicy()
    const { handler } = await setup({ threadAccess: policy })

    await drain(
      await handler.fetch(
        aguiPost(HELLO_ROUTE, {
          messages: [],
          resume: [
            {
              interruptId: PARKED_INTERRUPT_ID,
              payload: "once",
              status: "resolved",
            },
          ],
          runId: "run-1",
          threadId: "t-agui-resume",
        }),
      ),
    )

    expect(seen[0]).toEqual({
      action: "create",
      operation: "run.agui",
      resuming: true,
    })
  })

  it("is false on an ordinary AG-UI turn that carries no resume", async () => {
    const { policy, seen } = recordingAllowPolicy()
    const { handler } = await setup({ threadAccess: policy })

    await drain(
      await handler.fetch(
        aguiPost(HELLO_ROUTE, {
          messages: [],
          runId: "run-1",
          threadId: "t-agui-turn",
        }),
      ),
    )

    expect(seen.length).toBeGreaterThan(0)
    for (const entry of seen) {
      expect(entry).toMatchObject({ operation: "run.agui", resuming: false })
    }
  })

  it("is false on an empty AG-UI resume array, which carries no resume at all", async () => {
    const { policy, seen } = recordingAllowPolicy()
    const { handler } = await setup({ threadAccess: policy })

    await drain(
      await handler.fetch(
        aguiPost(HELLO_ROUTE, {
          messages: [],
          resume: [],
          runId: "run-1",
          threadId: "t-agui-empty",
        }),
      ),
    )

    expect(seen.length).toBeGreaterThan(0)
    for (const entry of seen) {
      expect(entry).toMatchObject({ operation: "run.agui", resuming: false })
    }
  })

  it("is false on POST /threads/:id/runs/stream", async () => {
    const { policy, seen } = recordingAllowPolicy()
    const { handler } = await setup({ threadAccess: policy })

    await drain(
      await handler.fetch(
        post("/threads/t-stream/runs/stream", {
          input: {},
          route: HELLO_ROUTE,
        }),
      ),
    )

    expect(seen.length).toBeGreaterThan(0)
    for (const entry of seen) {
      expect(entry).toMatchObject({ operation: "run.stream", resuming: false })
    }
  })

  it("is false on a thread read", async () => {
    const { policy, seen } = recordingAllowPolicy()
    const { handler } = await setup({ threadAccess: policy })

    await handler.fetch(get("/threads/t-read"))

    expect(seen).toEqual([{ action: "read", operation: "thread.get", resuming: false }])
  })

  it("reports the same value at every gate site one AG-UI resume passes through", async () => {
    const { policy, seen } = recordingAllowPolicy()
    const { handler } = await setup({
      checkpointer: new ParkedInterruptSaver(),
      threadAccess: policy,
    })

    // No threads-store row for this id, so the request gates as a `create` and
    // then again as the `update` recheck inside `createGatedThreadForRun` — two
    // gate sites, one request.
    await drain(
      await handler.fetch(
        aguiPost(HELLO_ROUTE, {
          messages: [],
          resume: [
            {
              interruptId: PARKED_INTERRUPT_ID,
              payload: "once",
              status: "resolved",
            },
          ],
          runId: "run-1",
          threadId: PARKED_THREAD_ID,
        }),
      ),
    )

    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen.map((entry) => entry.resuming))).toEqual(new Set([true]))
  })
})
