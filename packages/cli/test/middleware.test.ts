import type { IncomingMessage } from "node:http"
import { describe, expect, test } from "vitest"

import type { DawnMiddleware, MiddlewareContext } from "../src/lib/dev/middleware.js"
import { runMiddleware } from "../src/lib/dev/middleware.js"

function createMockContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    request: {} as IncomingMessage,
    routeId: "/hello/[tenant]",
    assistantId: "/hello/[tenant]#agent",
    ...overrides,
  }
}

describe("runMiddleware", () => {
  test("returns continue when no middleware", async () => {
    const result = await runMiddleware([], createMockContext())
    expect(result.action).toBe("continue")
  })

  test("returns continue when all middleware passes", async () => {
    const mw1: DawnMiddleware = async () => ({ action: "continue" })
    const mw2: DawnMiddleware = async () => ({ action: "continue" })

    const result = await runMiddleware([mw1, mw2], createMockContext())
    expect(result.action).toBe("continue")
  })

  test("returns reject on first rejection", async () => {
    const mw1: DawnMiddleware = async () => ({ action: "continue" })
    const mw2: DawnMiddleware = async () => ({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
    const mw3: DawnMiddleware = async () => ({ action: "continue" })

    const result = await runMiddleware([mw1, mw2, mw3], createMockContext())
    expect(result).toEqual({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
  })

  test("merges context from multiple middleware", async () => {
    const mw1: DawnMiddleware = async () => ({
      action: "continue",
      context: { userId: "user-1" },
    })
    const mw2: DawnMiddleware = async () => ({
      action: "continue",
      context: { orgId: "org-1" },
    })

    const result = await runMiddleware([mw1, mw2], createMockContext())
    expect(result).toEqual({
      action: "continue",
      context: { userId: "user-1", orgId: "org-1" },
    })
  })

  test("receives route context", async () => {
    let receivedContext: MiddlewareContext | undefined

    const mw: DawnMiddleware = async (ctx) => {
      receivedContext = ctx
      return { action: "continue" }
    }

    await runMiddleware([mw], createMockContext({ routeId: "/api/chat" }))

    expect(receivedContext?.routeId).toBe("/api/chat")
  })
})
