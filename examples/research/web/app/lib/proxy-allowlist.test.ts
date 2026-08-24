import { describe, expect, test } from "vitest"
import { resolveProxyTarget } from "./proxy-allowlist.js"

const BASE = "http://localhost:3002"

describe("proxy allowlist", () => {
  test("forwards the three memory routes", () => {
    expect(resolveProxyTarget("GET", ["memory", "candidates"], BASE)).toBe(
      "http://localhost:3002/memory/candidates",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "abc", "approve"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/abc/approve",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "abc", "reject"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/abc/reject",
    )
  })

  test("forwards the two thread reads", () => {
    expect(resolveProxyTarget("GET", ["threads", "t1", "state"], BASE)).toBe(
      "http://localhost:3002/threads/t1/state",
    )
    expect(resolveProxyTarget("GET", ["threads", "t1", "pending_interrupts"], BASE)).toBe(
      "http://localhost:3002/threads/t1/pending_interrupts",
    )
  })

  test("rejects the wrong method on an allowed path", () => {
    expect(resolveProxyTarget("POST", ["memory", "candidates"], BASE)).toBeNull()
    expect(resolveProxyTarget("DELETE", ["threads", "t1", "state"], BASE)).toBeNull()
  })

  test("rejects everything not on the list", () => {
    expect(resolveProxyTarget("GET", ["threads"], BASE)).toBeNull()
    expect(resolveProxyTarget("POST", ["threads", "t1", "resume"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["memory", "candidates", "abc"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["agent", "run"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", [], BASE)).toBeNull()
  })

  test("rejects a segment that tries to climb out of the allowed path", () => {
    expect(resolveProxyTarget("GET", ["threads", ".", "state"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["threads", "..", "state"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["threads", "a/b", "state"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["threads", "", "state"], BASE)).toBeNull()
  })

  test("encodes the id rather than letting it forge a path", () => {
    expect(resolveProxyTarget("GET", ["threads", "a b", "state"], BASE)).toBe(
      "http://localhost:3002/threads/a%20b/state",
    )
    expect(resolveProxyTarget("GET", ["threads", "a?b", "state"], BASE)).toBe(
      "http://localhost:3002/threads/a%3Fb/state",
    )
    expect(resolveProxyTarget("GET", ["threads", "a#b", "state"], BASE)).toBe(
      "http://localhost:3002/threads/a%23b/state",
    )
  })

  test("does not let a base with a trailing slash double it", () => {
    expect(resolveProxyTarget("GET", ["memory", "candidates"], "http://localhost:3002/")).toBe(
      "http://localhost:3002/memory/candidates",
    )
  })
})
