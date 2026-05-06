import { describe, expect, test } from "vitest"
import {
  allow,
  defineMiddleware,
  reject,
  type MiddlewareRequest,
  type MiddlewareResult,
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

  test("body defaults to undefined", () => {
    const result = reject(403)
    expect(result).toEqual({
      action: "reject",
      status: 403,
      body: undefined,
    })
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

  test("context defaults to undefined", () => {
    const result = allow()
    expect(result).toEqual({
      action: "continue",
      context: undefined,
    })
  })
})

describe("defineMiddleware()", () => {
  test("returns the function as-is (type-safe identity wrapper)", () => {
    const fn = async (req: MiddlewareRequest): Promise<MiddlewareResult> => {
      return allow()
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })

  test("works with a sync function", () => {
    const fn = (req: MiddlewareRequest): MiddlewareResult => {
      return reject(401)
    }

    const middleware = defineMiddleware(fn)
    expect(middleware).toBe(fn)
  })
})
