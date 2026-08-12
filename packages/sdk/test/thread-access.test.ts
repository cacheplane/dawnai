import { describe, expect, it } from "vitest"

import * as barrel from "../src/index.js"
import {
  defineThreadAccess,
  deny,
  permit,
  THREAD_ACCESS_METADATA_KEY,
  type ThreadAccessPolicy,
} from "../src/thread-access.js"

describe("permit", () => {
  it("returns a bare allow when no stamp is supplied", () => {
    const result = permit()
    expect(result).toEqual({ decision: "allow" })
    expect("stamp" in result).toBe(false)
  })

  it("carries the stamp when one is supplied", () => {
    expect(permit({ org: "acme", ownerId: "u-1" })).toEqual({
      decision: "allow",
      stamp: { org: "acme", ownerId: "u-1" },
    })
  })
})

describe("deny", () => {
  it("returns a bare deny with neither status nor body", () => {
    const result = deny()
    expect(result).toEqual({ decision: "deny" })
    expect("status" in result).toBe(false)
    expect("body" in result).toBe(false)
  })

  it("keeps an explicit status and body", () => {
    expect(deny({ body: { error: "nope" }, status: 403 })).toEqual({
      body: { error: "nope" },
      decision: "deny",
      status: 403,
    })
  })

  it("drops an explicitly-undefined body rather than carrying it", () => {
    // `Response.json(undefined)` throws, so a present-but-undefined body could
    // only ever express a 500. There is deliberately no such distinction.
    const result = deny({ body: undefined, status: 404 })
    expect(result).toEqual({ decision: "deny", status: 404 })
    expect("body" in result).toBe(false)
  })
})

describe("defineThreadAccess", () => {
  it("returns the policy object unchanged (identity helper, runtime no-op)", () => {
    const policy: ThreadAccessPolicy = { fallback: () => permit() }
    expect(defineThreadAccess(policy)).toBe(policy)
  })
})

describe("THREAD_ACCESS_METADATA_KEY", () => {
  it("is the reserved `dawn:access` key", () => {
    expect(THREAD_ACCESS_METADATA_KEY).toBe("dawn:access")
  })

  it("cannot be written as a JS property identifier, which is why stripping it is safe", () => {
    expect(THREAD_ACCESS_METADATA_KEY).toContain(":")
  })
})

describe("package barrel", () => {
  it("re-exports the thread-access value surface", () => {
    expect(barrel.defineThreadAccess).toBe(defineThreadAccess)
    expect(barrel.permit).toBe(permit)
    expect(barrel.deny).toBe(deny)
    expect(barrel.THREAD_ACCESS_METADATA_KEY).toBe(THREAD_ACCESS_METADATA_KEY)
  })
})
