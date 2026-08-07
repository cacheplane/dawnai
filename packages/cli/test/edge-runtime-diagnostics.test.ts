import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import {
  chatFixtureApp,
  fakePermissionsStore,
  memoryThreadsStore,
} from "./helpers/fetch-entry-fixture.js"
import { buildStaticModulesForFixture, cleanup } from "./helpers/static-modules-fixture.js"

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/**
 * Capture `console.error` for the duration of one test — the operator-facing
 * channel these diagnostics travel on. On a worker it is the only one: the
 * HTTP body is served to the CALLER, so it deliberately says nothing internal.
 */
function captureConsoleError(): string[] {
  const lines: string[] = []
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  })
  cleanup.push(() => spy.mockRestore())
  return lines
}

// ---------------------------------------------------------------------------
// WHAT AN OPERATOR SEES WHEN AN EDGE DEPLOY IS MISCONFIGURED.
//
// Every failure below is a deployment mistake, not a request mistake: it fails
// every request identically until someone changes the deployment. So the bar is
// not "returns 500" — a 500 with no message anywhere is indistinguishable from
// a crash, and on a worker there is no log to fall back to. The bar is that the
// cause reaches stderr, exactly once, naming the thing that is wrong.
// ---------------------------------------------------------------------------

describe("edge runtime diagnostics", () => {
  it("fires DAWN_E5301 for a missing memoryStore, like the docs say", async () => {
    // memoryStore is the one store slot with no `requireStore` call site of its
    // own, and `/memory/candidates*` is registered UNCONDITIONALLY — so it is
    // reachable on a deployed worker whose `stores.mjs` (correctly, for the
    // hono target) supplies no memory store. It used to throw a plain Error
    // with no `.code`, so the documented code could never fire and the caller
    // got an anonymous 500.
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    const errors = captureConsoleError()

    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: {},
      modules,
      // The emitted `stores.mjs` shape exactly: no memoryStore, no fallbacks.
      requestStores: async () => ({
        checkpointer: new MemorySaver(),
        permissionsStore: fakePermissionsStore(),
        threadsStore: memoryThreadsStore().store,
      }),
    })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(new Request("http://localhost/memory/candidates"))
    expect(response.status).toBe(500)
    const body = (await response.json()) as {
      error: { message: string; code?: string; details?: { store?: string }; docsUrl?: string }
    }
    expect(body.error.code).toBe("DAWN_E5301")
    expect(body.error.message).toContain("memoryStore")
    expect(body.error.details?.store).toBe("memoryStore")
    expect(body.error.docsUrl).toContain("/docs/deployment")
    expect(errors.join("\n")).toContain("memoryStore")
  }, 120_000)

  it("logs the cause of a generic runtime failure instead of swallowing it", async () => {
    // The three most likely edge misconfigurations — DATABASE_URL unset, no
    // Workers env bound to the Request, a store the factory omits — all arrive
    // as a throw out of `requestStores`. The body stays opaque on purpose; the
    // operator's copy must not.
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    const errors = captureConsoleError()

    const cause =
      "hono target: DATABASE_URL is not set on this worker's env, so no store can be built."
    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: {},
      modules,
      requestStores: async () => {
        throw new Error(cause)
      },
    })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(
      new Request("http://localhost/threads", { method: "POST" }),
    )
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { message: string; details?: unknown } }
    // Opaque to the caller — no message, no internals, no stack.
    expect(body.error.message).toBe("Unexpected runtime server failure")
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL")

    // …and fully named for the operator.
    expect(errors.join("\n")).toContain("DATABASE_URL")

    // Once per cause, not once per request: a misconfiguration fails every
    // request identically and must not flood a busy host.
    const second = await handler.fetch(new Request("http://localhost/threads", { method: "POST" }))
    expect(second.status).toBe(500)
    expect(errors.filter((line) => line.includes("DATABASE_URL"))).toHaveLength(1)
  }, 120_000)
})
