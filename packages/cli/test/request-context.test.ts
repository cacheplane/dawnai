import type { IncomingMessage } from "node:http"
import { describe, expect, test } from "vitest"
import { extractRouteParams, parseHeaders } from "../src/lib/dev/request-context.js"

describe("parseHeaders", () => {
  test("preserves string headers", () => {
    const request = {
      headers: { authorization: "Bearer token" },
    } as unknown as IncomingMessage

    expect(parseHeaders(request)).toEqual({ authorization: "Bearer token" })
  })

  test("joins array headers", () => {
    const request = {
      headers: { "x-scope": ["read", "write"] },
    } as unknown as IncomingMessage

    expect(parseHeaders(request)).toEqual({ "x-scope": "read, write" })
  })

  test("omits undefined headers", () => {
    const request = {
      headers: { authorization: undefined, "x-request-id": "request-1" },
    } as unknown as IncomingMessage

    expect(parseHeaders(request)).toEqual({ "x-request-id": "request-1" })
  })
})

describe("extractRouteParams", () => {
  test("extracts named route parameters as strings", () => {
    expect(extractRouteParams("/users/[userId]", { userId: 42 })).toEqual({ userId: "42" })
  })
})
