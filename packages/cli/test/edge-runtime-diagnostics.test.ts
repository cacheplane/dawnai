import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import { createRuntimeFetchHandler as createNodeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
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

// ---------------------------------------------------------------------------
// GATED FEATURES THAT USED TO NO-OP IN SILENCE.
//
// The build gate (DAWN_E1005, edge-capabilities.ts) rejects all of these — but
// it only runs when the `hono` target does, and hand-composing an entry over
// `@dawn-ai/cli/fetch` is a documented way to deploy. Such an app never runs the
// target, so before these guards a `sandbox` block reached a worker, was read,
// and did nothing at all. Same code, same words, raised at request time.
// ---------------------------------------------------------------------------

/** The edge shape: no bootFallbacks, every store injected per request. */
async function edgeHandler(
  appRoot: string,
  modules: Awaited<ReturnType<typeof buildStaticModulesForFixture>>,
  config: NonNullable<Parameters<typeof createRuntimeFetchHandler>[0]["config"]>,
) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config,
    modules,
    requestStores: async () => ({
      checkpointer: new MemorySaver(),
      permissionsStore: fakePermissionsStore(),
      threadsStore: memoryThreadsStore().store,
    }),
  })
  cleanup.push(() => handler.close())
  return handler
}

describe("edge runtime capability guards", () => {
  it("raises DAWN_E1005 for a configured `sandbox` no edge runtime can start", async () => {
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    const errors = captureConsoleError()

    const handler = await edgeHandler(appRoot, modules, {
      // A provider handle is never contacted here — the gap is that this
      // runtime has no container daemon to hand it to.
      sandbox: { provider: {} as never },
    })

    const response = await handler.fetch(new Request("http://localhost/healthz"))
    // Health checks fail too, deliberately: a rollout that goes green while
    // silently ignoring the sandbox block is the failure this exists to stop.
    expect(response.status).toBe(500)
    const body = (await response.json()) as {
      error: { message: string; code?: string; docsUrl?: string }
    }
    expect(body.error.code).toBe("DAWN_E1005")
    expect(body.error.message).toContain("sandbox")
    expect(body.error.message).toContain("`sandbox` in dawn.config.ts")
    expect(body.error.docsUrl).toBeTruthy()
    expect(errors.join("\n")).toContain("sandbox")

    // Deduped like every other deployment misconfiguration.
    await handler.fetch(new Request("http://localhost/healthz"))
    expect(
      errors.filter((line) => line.includes("DAWN_E1005") || line.includes("sandbox")),
    ).toHaveLength(1)
  }, 120_000)

  it("raises DAWN_E1005 for `toolOutput`, which has nowhere to spill", async () => {
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    captureConsoleError()

    const handler = await edgeHandler(appRoot, modules, {
      toolOutput: { offloadThresholdChars: 1_000 },
    })

    const response = await handler.fetch(new Request("http://localhost/healthz"))
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { message: string; code?: string } }
    expect(body.error.code).toBe("DAWN_E1005")
    expect(body.error.message).toContain("tool-output offloading")
    expect(body.error.message).toContain("`toolOutput` in dawn.config.ts")
  }, 120_000)

  it("raises DAWN_E1005 for a route whose skills would vanish from the prompt", async () => {
    const appRoot = await chatFixtureApp()
    const built = await buildStaticModulesForFixture(appRoot)
    captureConsoleError()

    // What `dawn build` records into the manifest for a route with a
    // `skills/<name>/SKILL.md` — the only trace of them that survives to
    // request time, since the capability's `detect` needs a MarkerFs.
    const modules = {
      ...built,
      routes: built.routes.map((route) => ({ ...route, skills: ["cite-sources"] })),
    }
    const handler = await edgeHandler(appRoot, modules, {})

    const response = await handler.fetch(new Request("http://localhost/healthz"))
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { message: string; code?: string } }
    expect(body.error.code).toBe("DAWN_E1005")
    expect(body.error.message).toContain("skills")
    expect(body.error.message).toContain("cite-sources")
  }, 120_000)

  it("serves an ordinary edge app that configured none of them", async () => {
    // The guard must cost nothing for the apps the hono target actually
    // produces — a 500 here would break every deployed worker.
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)

    const handler = await edgeHandler(appRoot, modules, {})

    const response = await handler.fetch(new Request("http://localhost/healthz"))
    expect(response.status).toBe(200)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// …AND NEVER ON NODE.
//
// Every feature above absent is a documented DEGRADE on node, not a fault (see
// `requireFallbacks` in execute-route-core.ts). A node app configuring all three
// is completely normal — they all work there. This is the half of the guard
// that protects existing users, so it is asserted through the real node entry
// point rather than a stub: `runtime-fetch-handler.ts` is what applies
// `nodeBootFallbacks`, which is the single condition the guard turns on.
// ---------------------------------------------------------------------------

describe("node runtime — the same config raises nothing", () => {
  it("serves normally with sandbox, toolOutput AND route skills all configured", async () => {
    const appRoot = await chatFixtureApp()
    const built = await buildStaticModulesForFixture(appRoot)
    const modules = {
      ...built,
      routes: built.routes.map((route) => ({ ...route, skills: ["cite-sources"] })),
    }
    const errors = captureConsoleError()

    // Same three inputs that produced three DAWN_E1005s above. The ONLY
    // difference is the entry point, which supplies the node fallback bag.
    const handler = await createNodeRuntimeFetchHandler({
      appRoot,
      config: {
        sandbox: { provider: {} as never },
        toolOutput: { offloadThresholdChars: 1_000 },
      },
      modules,
    })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(new Request("http://localhost/healthz"))
    expect(response.status).toBe(200)
    expect(errors.join("\n")).not.toContain("DAWN_E1005")
  }, 120_000)
})
