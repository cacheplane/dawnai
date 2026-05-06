import type { DawnMiddleware, MiddlewareRequest } from "@dawn-ai/sdk"
import { describe, expect, test } from "vitest"
import { runMiddleware } from "../src/lib/dev/middleware.js"

function createMockRequest(overrides?: Partial<MiddlewareRequest>): MiddlewareRequest {
  return {
    assistantId: "/hello/[tenant]#agent",
    headers: {},
    method: "POST",
    params: {},
    routeId: "/hello/[tenant]",
    url: "/runs/wait",
    ...overrides,
  }
}

describe("runMiddleware", () => {
  test("returns continue when middleware is undefined", async () => {
    const result = await runMiddleware(undefined, createMockRequest())
    expect(result.action).toBe("continue")
  })

  test("returns continue when middleware passes", async () => {
    const mw: DawnMiddleware = async () => ({ action: "continue" })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result.action).toBe("continue")
  })

  test("returns reject when middleware rejects", async () => {
    const mw: DawnMiddleware = async () => ({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result).toEqual({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
  })

  test("passes context through on continue", async () => {
    const mw: DawnMiddleware = async () => ({
      action: "continue",
      context: { userId: "user-1" },
    })

    const result = await runMiddleware(mw, createMockRequest())
    expect(result).toEqual({
      action: "continue",
      context: { userId: "user-1" },
    })
  })

  test("receives parsed request with headers and params", async () => {
    let receivedReq: MiddlewareRequest | undefined

    const mw: DawnMiddleware = async (req) => {
      receivedReq = req
      return { action: "continue" }
    }

    await runMiddleware(
      mw,
      createMockRequest({
        headers: { authorization: "Bearer tok-123" },
        params: { tenant: "acme" },
        routeId: "/api/chat",
      }),
    )

    expect(receivedReq?.headers.authorization).toBe("Bearer tok-123")
    expect(receivedReq?.params.tenant).toBe("acme")
    expect(receivedReq?.routeId).toBe("/api/chat")
  })
})
