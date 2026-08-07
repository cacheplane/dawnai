import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeFetchHandler, isEventStream } from "../src/lib/dev/runtime-fetch-core.js"
import { createRuntimeFetchHandler as createNodeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import type { RequestStores } from "../src/lib/dev/runtime-server.js"
import {
  chatFixtureApp,
  fakeMemoryStore,
  fakePermissionsStore,
  inMemoryFilesystem,
  memoryThreadsStore,
  simpleScript,
} from "./helpers/fetch-entry-fixture.js"
import {
  buildStaticModulesForFixture,
  cleanup,
  withAimock,
} from "./helpers/static-modules-fixture.js"

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/**
 * The per-request store seam exists for edge runtimes whose connections are
 * bound to a single request's I/O context. On workerd a module-scope Postgres
 * pool hands request N+1 an idle WebSocket belonging to request N's dead
 * context, which hangs for ~30s until the runtime cancels — alternating, so
 * half of all requests fail (spike, 2026-08-07). Hence: build per request,
 * dispose after the response settles.
 */
describe("per-request stores", () => {
  it("builds and disposes stores once per request, never reusing them", async () => {
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    const built: number[] = []
    const disposed: number[] = []
    let seq = 0

    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: {},
      modules,
      requestStores: async () => {
        const id = ++seq
        built.push(id)
        return {
          checkpointer: new MemorySaver(),
          dispose: async () => {
            disposed.push(id)
          },
          memoryStore: fakeMemoryStore(),
          permissionsStore: fakePermissionsStore(),
          threadsStore: memoryThreadsStore().store,
        }
      },
      // No `bootFallbacks` and no boot-resolved stores: the edge shape, where
      // the factory below is the ONLY source of stores.
    })
    cleanup.push(() => handler.close())

    expect((await handler.fetch(new Request("http://x/healthz"))).status).toBe(200)
    expect((await handler.fetch(new Request("http://x/healthz"))).status).toBe(200)

    expect(built).toEqual([1, 2])
    expect(disposed).toEqual([1, 2])
  }, 120_000)

  it("disposes only AFTER an SSE body finishes, not when fetch resolves", async () => {
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    await withAimock(simpleScript())

    // A counter, not a flag: a flag would still pass if the stream path
    // disposed twice, which is exactly what a second settle hook would do.
    const disposed: number[] = []
    let seq = 0
    const { store: threadsStore, threads } = memoryThreadsStore()

    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: { backends: { filesystem: inMemoryFilesystem() } },
      modules,
      requestStores: async () => {
        const id = ++seq
        return {
          checkpointer: new MemorySaver(),
          dispose: async () => {
            disposed.push(id)
          },
          memoryStore: fakeMemoryStore(),
          permissionsStore: fakePermissionsStore(),
          threadsStore,
        }
      },
    })
    cleanup.push(() => handler.close())

    const routeKey = encodeURIComponent("/chat#agent")
    const response = await handler.fetch(
      new Request(`http://localhost/agui/${routeKey}`, {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "hello from the bundle" }],
          runId: "rn-per-request",
          state: {},
          threadId: "th-per-request",
          tools: [],
        }),
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(response.status).toBe(200)

    // `fetch()` has resolved, but the SSE body has not been read at all. A
    // naive `finally { dispose() }` disposes here — and a pool ended at this
    // point breaks the tail of every streaming turn.
    expect(disposed).toEqual([])

    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected a streaming response body")
    const decoder = new TextDecoder()
    const chunks: string[] = []

    const first = await reader.read()
    expect(first.done).toBe(false)
    // Mid-stream: still not disposed.
    expect(disposed).toEqual([])
    if (first.value) chunks.push(decoder.decode(first.value))

    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(decoder.decode(next.value))
    }

    const body = chunks.join("")
    expect(body).toContain("RUN_STARTED")
    expect(body).toContain("bundled reply")
    expect(body).toContain("RUN_FINISHED")
    // The body has fully settled, and the turn's run slot frees a beat later
    // (the route's own cleanup unwinds behind the last byte) — only then may
    // the stores be torn down, and exactly once. The extra tick would catch a
    // second settle hook disposing again.
    await waitUntil(() => disposed.length > 0, "the finished turn's stores to dispose")
    await tick()
    expect(disposed).toEqual([1])
    // …and the turn genuinely ran against the PER-REQUEST threads store, not a
    // boot-resolved one (there is none here).
    expect(threads.has("th-per-request")).toBe(true)
  }, 120_000)

  it("fails loudly, naming the store, when the factory omits one", async () => {
    // Before this seam, the same misconfiguration rejected
    // createRuntimeFetchHandler at boot with the store's name in the rejection.
    // A generated `stores.mjs` that omits a store must still say WHICH one —
    // an opaque 500 on every request is not a diagnosis.
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    const errors: string[] = []
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    cleanup.push(() => consoleError.mockRestore())

    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: {},
      modules,
      // Deliberately incomplete: a checkpointer but no threadsStore.
      requestStores: async () => ({ checkpointer: new MemorySaver() }),
    })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(
      new Request("http://localhost/threads", { method: "POST" }),
    )
    expect(response.status).toBe(500)
    const body = (await response.json()) as {
      error: { message: string; code?: string; details?: { store?: string }; docsUrl?: string }
    }
    expect(body.error.message).toContain("threadsStore")
    expect(body.error.details?.store).toBe("threadsStore")
    expect(body.error.code).toBe("DAWN_E5301")
    expect(body.error.docsUrl).toContain("/docs/deployment")
    expect(errors.join("\n")).toContain("threadsStore")

    // Logged once per store, not once per request — a busy edge host must not
    // be flooded with the same line.
    const second = await handler.fetch(new Request("http://localhost/threads", { method: "POST" }))
    expect(second.status).toBe(500)
    expect(errors.filter((line) => line.includes("threadsStore"))).toHaveLength(1)
  }, 120_000)

  it("close() does not return while a store disposal is still in flight", async () => {
    // "close() returned" must imply "the pool is closed": an edge host awaiting
    // shutdown has no other signal, and sandbox release happens on the far side
    // of the drain.
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    const gate = deferred()
    const events: string[] = []

    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: {},
      drainDeadlineMs: 10_000,
      modules,
      requestStores: async () => ({
        checkpointer: new MemorySaver(),
        dispose: async () => {
          events.push("dispose:start")
          await gate.promise
          events.push("dispose:end")
        },
        memoryStore: fakeMemoryStore(),
        permissionsStore: fakePermissionsStore(),
        threadsStore: memoryThreadsStore().store,
      }),
    })

    expect((await handler.fetch(new Request("http://x/healthz"))).status).toBe(200)
    expect(events).toEqual(["dispose:start"])

    let closed = false
    const closing = handler.close().then(() => {
      closed = true
      events.push("close:returned")
    })
    await tick()
    expect(closed).toBe(false)

    gate.resolve()
    await closing
    expect(events).toEqual(["dispose:start", "dispose:end", "close:returned"])
  }, 120_000)

  it("treats a parameterized SSE content-type as a stream", () => {
    // A future `; charset=utf-8` on any SSE producer would otherwise silently
    // downgrade a live stream to "settled when fetch() resolves" — disposing
    // the pool mid-stream, the exact bug this seam exists to prevent.
    expect(isEventStream("text/event-stream")).toBe(true)
    expect(isEventStream("text/event-stream; charset=utf-8")).toBe(true)
    expect(isEventStream("Text/Event-Stream ;charset=utf-8")).toBe(true)
    expect(isEventStream("application/json")).toBe(false)
    expect(isEventStream(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Run lifetime vs response lifetime
//
// A request's stores must outlive its RESPONSE, because route work does. Three
// paths keep executing after the body settles — an aborted AG-UI stream, an
// abandoned /runs/wait, a cancelled AP stream — and all three keep writing
// through the very stores a response-triggered dispose would tear down.
// `close()` already draws this distinction (it drains on the run registry as
// well as on activeRequests); disposal must draw it too.
//
// The fixture is a route that blocks on a probe file and deliberately ignores
// its ctx.signal, so "the response has settled but the run has not" is a state
// the test can hold open for as long as it needs.
// ---------------------------------------------------------------------------

/** Blocks until `releaseFile` exists; the paths arrive as route input. */
const BLOCKING_ROUTE = [
  'import { readFile, writeFile } from "node:fs/promises"',
  "export const graph = async (",
  "  input: { startedFile?: string; releaseFile?: string } | undefined,",
  "  _ctx: { signal: AbortSignal },",
  ") => {",
  "  if (input?.startedFile) await writeFile(input.startedFile, 'started')",
  "  const deadline = Date.now() + 15000",
  "  while (Date.now() < deadline) {",
  "    if (!input?.releaseFile) break",
  "    try { await readFile(input.releaseFile, 'utf8'); break } catch {}",
  "    await new Promise((r) => setTimeout(r, 25))",
  "  }",
  "  return { ok: true }",
  "}",
  "",
].join("\n")

/**
 * The same route with the probe paths baked in as literals: AG-UI always
 * invokes a route with the message input, so there is nowhere to thread them
 * through the request body.
 */
function blockingRouteWithLiterals(startedFile: string, releaseFile: string): string {
  return [
    'import { readFile, writeFile } from "node:fs/promises"',
    "export const graph = async () => {",
    `  await writeFile(${JSON.stringify(startedFile)}, 'started')`,
    "  const deadline = Date.now() + 15000",
    "  while (Date.now() < deadline) {",
    `    try { await readFile(${JSON.stringify(releaseFile)}, 'utf8'); break } catch {}`,
    "    await new Promise((r) => setTimeout(r, 25))",
    "  }",
    "  return { ok: true }",
    "}",
    "",
  ].join("\n")
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = () => r()
  })
  return { promise, resolve }
}

/** One macrotask, so a promise chain that was already settled can run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(path, "utf8")
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`probe file never appeared: ${path}`)
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 15_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

/**
 * A per-request store bag that records when it was disposed — and whether
 * anything used it afterwards, which is the failure mode under test rather
 * than a proxy for it.
 */
function storeProbe() {
  const shared = memoryThreadsStore()
  const disposals: string[] = []
  const useAfterDispose: string[] = []

  const requestStores = (request: Request): RequestStores => {
    const label = new URL(request.url).pathname
    let disposed = false
    const threadsStore: ThreadsStore = {
      ...shared.store,
      updateStatus: async (threadId, status) => {
        if (disposed) useAfterDispose.push(`${label} updateStatus(${status})`)
        await shared.store.updateStatus(threadId, status)
      },
    }
    return {
      dispose: async () => {
        disposed = true
        disposals.push(label)
      },
      threadsStore,
    }
  }

  return { disposals, requestStores, useAfterDispose }
}

async function setupBlockingApp() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-request-store-lifetime-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))

  const startedFile = join(appRoot, "started.json")
  const releaseFile = join(appRoot, "release.json")
  const literalStartedFile = join(appRoot, "started-literal.json")

  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "request-store-lifetime-fixture", "type": "module" }\n',
    "src/app/blocking/index.ts": BLOCKING_ROUTE,
    "src/app/literal/index.ts": blockingRouteWithLiterals(literalStartedFile, releaseFile),
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }

  const probe = storeProbe()
  // Node boot fallbacks stay in place (checkpointer, permissions, memory come
  // from disk exactly as always); only the threads store is per request, which
  // is enough to observe the disposal timing.
  const handler = await createNodeRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    requestStores: probe.requestStores,
  })
  cleanup.push(() => handler.close())

  return {
    ...probe,
    handler,
    literalStartedFile,
    releaseFile,
    releaseRoute: () => writeFile(releaseFile, "release"),
    startedFile,
  }
}

describe("per-request stores outlive the response when the run does", () => {
  it("holds an abandoned /runs/wait's stores until the detached route settles", async () => {
    // The worst of the three paths: the 409 is a NON-stream response, so the
    // fetch wrapper's finally fires immediately while invokeResolvedRoute keeps
    // running against this request's checkpointer and threads store.
    const { disposals, handler, releaseFile, releaseRoute, startedFile, useAfterDispose } =
      await setupBlockingApp()
    const threadId = "t-abandoned-wait"
    const waitPath = `/threads/${threadId}/runs/wait`

    const waitPromise = handler.fetch(
      new Request(`http://localhost${waitPath}`, {
        body: JSON.stringify({
          input: { releaseFile, startedFile },
          route: "/blocking#graph",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    await waitForFile(startedFile)

    const cancelResponse = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}/cancel`, { method: "POST" }),
    )
    expect(cancelResponse.status).toBe(200)

    const waitResponse = await waitPromise
    expect(waitResponse.status).toBe(409)

    // The response has settled, but the detached route is still executing — its
    // stores must still be open.
    expect(disposals).not.toContain(waitPath)
    // The cancel request, which started no run, disposed normally.
    expect(disposals).toContain(`/threads/${threadId}/cancel`)

    await releaseRoute()
    await waitUntil(() => disposals.includes(waitPath), "the abandoned run's stores to dispose")

    expect(disposals.filter((path) => path === waitPath)).toEqual([waitPath])
    expect(useAfterDispose).toEqual([])
  }, 60_000)

  it("holds an aborted AG-UI turn's stores until the route unwinds", async () => {
    // Client disconnect is the ordinary case at the edge. On abort the
    // rejection propagates past safeClose into controller.error(), settling the
    // body, while the route's own cleanup has only just been attached — and the
    // handler's finally still writes the thread's status through these stores.
    const { disposals, handler, literalStartedFile, releaseRoute, useAfterDispose } =
      await setupBlockingApp()
    const threadId = "t-aborted-agui"
    const aguiPath = `/agui/${encodeURIComponent("/literal#graph")}`

    const response = await handler.fetch(
      new Request(`http://localhost${aguiPath}`, {
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "hello" }],
          runId: `agui-${threadId}`,
          state: {},
          threadId,
          tools: [],
        }),
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(response.status).toBe(200)
    await waitForFile(literalStartedFile)

    // The client disconnects mid-stream.
    await response.body?.cancel()
    await tick()

    // The body has settled and the run is unwinding — the route ignores its
    // signal, so it is still executing against these stores.
    expect(disposals).not.toContain(decodeURIComponent(aguiPath))
    expect(disposals).not.toContain(aguiPath)

    await releaseRoute()
    await waitUntil(
      () => disposals.some((path) => path.startsWith("/agui/")),
      "the aborted turn's stores to dispose",
    )

    expect(disposals.filter((path) => path.startsWith("/agui/"))).toHaveLength(1)
    // The handler's cleanup wrote the thread back to "idle" while unwinding;
    // that write must have landed on a live store.
    expect(useAfterDispose).toEqual([])
  }, 60_000)
})
