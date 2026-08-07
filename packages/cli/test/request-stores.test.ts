import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
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

    let disposed = false
    const { store: threadsStore, threads } = memoryThreadsStore()

    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: { backends: { filesystem: inMemoryFilesystem() } },
      modules,
      requestStores: async () => ({
        checkpointer: new MemorySaver(),
        dispose: async () => {
          disposed = true
        },
        memoryStore: fakeMemoryStore(),
        permissionsStore: fakePermissionsStore(),
        threadsStore,
      }),
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
    expect(disposed).toBe(false)

    const reader = response.body?.getReader()
    if (!reader) throw new Error("expected a streaming response body")
    const decoder = new TextDecoder()
    const chunks: string[] = []

    const first = await reader.read()
    expect(first.done).toBe(false)
    // Mid-stream: still not disposed.
    expect(disposed).toBe(false)
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
    // The body has fully settled — only now may the stores be torn down.
    expect(disposed).toBe(true)
    // …and the turn genuinely ran against the PER-REQUEST threads store, not a
    // boot-resolved one (there is none here).
    expect(threads.has("th-per-request")).toBe(true)
  }, 120_000)
})
