import { describe, expect, test } from "vitest"
import {
  allow,
  defineMiddleware,
  type MiddlewareRequest,
  type MiddlewareResult,
  reject,
} from "../src/middleware.js"

describe("reject()", () => {
  test("returns a reject result with status and body", () => {
    const result = reject(401, { error: "Unauthorized" })
    expect(result).toEqual({
      action: "reject",
      status: 401,
      body: { error: "Unauthorized" },
    })
  })

  test("omits body when not provided", () => {
    const result = reject(403)
    expect(result).toStrictEqual({ action: "reject", status: 403 })
    expect(Object.hasOwn(result, "body")).toBe(false)
  })
})

describe("allow()", () => {
  test("returns a continue result with context", () => {
    const result = allow({ userId: "user-1", orgId: "org-1" })
    expect(result).toEqual({
      action: "continue",
      context: { userId: "user-1", orgId: "org-1" },
    })
  })

  test("omits context when not provided", () => {
    const result = allow()
    expect(result).toStrictEqual({ action: "continue" })
    expect(Object.hasOwn(result, "context")).toBe(false)
  })
})

describe("defineMiddleware()", () => {
  test("returns the function as-is (type-safe identity wrapper)", () => {
    const fn = async (_req: MiddlewareRequest): Promise<MiddlewareResult> => {
      return allow()
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })

  test("works with a sync function", () => {
    const fn = (_req: MiddlewareRequest): MiddlewareResult => {
      return reject(401)
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })
})
