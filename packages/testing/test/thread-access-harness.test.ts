import { fileURLToPath } from "node:url"
import { defineThreadAccess, deny, permit, type ThreadAccessRequest } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import { createAgentProtocolInjector } from "../src/http-inject.js"
import { createThreadAccessHarness } from "../src/thread-access-harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

describe("createThreadAccessHarness", () => {
  it("routes an action to its own handler when the policy has one", async () => {
    const seen: string[] = []
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({
        delete: () => {
          seen.push("delete")
          return deny()
        },
        fallback: () => {
          seen.push("fallback")
          return permit()
        },
      }),
    })
    expect(await harness.check({ action: "delete", threadId: "t-1" })).toEqual({
      decision: "deny",
    })
    expect(await harness.check({ action: "read", threadId: "t-1" })).toEqual({ decision: "allow" })
    expect(seen).toEqual(["delete", "fallback"])
  })

  it("fills in sane defaults for headers, method, url and operation", async () => {
    let received: ThreadAccessRequest | undefined
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({
        fallback: (req) => {
          received = req
          return permit()
        },
      }),
    })
    await harness.check({ action: "read", threadId: "t-9" })
    expect(received).toMatchObject({
      action: "read",
      headers: {},
      method: "GET",
      operation: "thread.get",
      threadId: "t-9",
      url: "/threads/t-9",
    })
    expect(received?.thread).toBeUndefined()
    expect(received?.requestedMetadata).toBeUndefined()
  })

  it("passes an explicit operation, headers, thread and requestedMetadata through", async () => {
    let received: ThreadAccessRequest | undefined
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({
        fallback: (req) => {
          received = req
          return permit()
        },
      }),
    })
    await harness.check({
      action: "read",
      headers: { "x-user-id": "u-1" },
      operation: "thread.state",
      requestedMetadata: { tenant: "acme" },
      thread: {
        access: { ownerId: "u-1" },
        created_at: "2026-01-01T00:00:00.000Z",
        metadata: { tenant: "acme" },
        status: "idle",
        thread_id: "t-9",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      threadId: "t-9",
    })
    expect(received?.operation).toBe("thread.state")
    expect(received?.headers).toEqual({ "x-user-id": "u-1" })
    expect(received?.thread?.access).toEqual({ ownerId: "u-1" })
    expect(received?.requestedMetadata).toEqual({ tenant: "acme" })
  })

  it("runs the result through the runtime's own normalization, so a malformed return denies", async () => {
    const harness = createThreadAccessHarness({
      policy: { fallback: () => undefined as never },
    })
    expect(await harness.check({ action: "read", threadId: "t-1" })).toEqual({ decision: "deny" })
  })

  it("drops a deny status the runtime would drop", async () => {
    const harness = createThreadAccessHarness({
      policy: { fallback: () => ({ decision: "deny", status: 401 }) as never },
    })
    expect(await harness.check({ action: "delete", threadId: "t-1" })).toEqual({
      decision: "deny",
    })
  })

  it("awaits an async handler", async () => {
    const harness = createThreadAccessHarness({
      policy: defineThreadAccess({ fallback: async () => permit({ ownerId: "u-1" }) }),
    })
    expect(await harness.check({ action: "create" })).toEqual({
      decision: "allow",
      stamp: { ownerId: "u-1" },
    })
  })
})

describe("createAgentProtocolInjector({ threadAccess })", () => {
  it("gates the injected app's thread endpoints", async () => {
    const ap = await createAgentProtocolInjector({
      appRoot,
      threadAccess: defineThreadAccess({
        fallback: (req) => (req.headers["x-api-key"] === "secret" ? permit() : deny()),
      }),
    })
    try {
      const denied = await ap.inject({ method: "POST", payload: {}, url: "/threads" })
      expect(denied.statusCode).toBe(403)

      const allowed = await ap.inject({
        headers: { "x-api-key": "secret" },
        method: "POST",
        payload: {},
        url: "/threads",
      })
      expect(allowed.statusCode).toBe(200)
    } finally {
      await ap.close()
    }
  }, 60_000)

  it("leaves an injector with no policy open, exactly as before", async () => {
    const ap = await createAgentProtocolInjector({ appRoot })
    try {
      const created = await ap.inject({ method: "POST", payload: {}, url: "/threads" })
      expect(created.statusCode).toBe(200)
    } finally {
      await ap.close()
    }
  }, 60_000)
})
