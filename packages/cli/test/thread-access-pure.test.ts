import { describe, expect, it, vi } from "vitest"

import {
  normalizeThreadAccessResult,
  selectThreadAccessExport,
  threadAccessBootLine,
  threadAccessCandidatePaths,
  validateThreadAccessPolicy,
} from "../src/lib/dev/thread-access.js"

const noop = () => ({ decision: "allow" }) as const

describe("selectThreadAccessExport", () => {
  it("prefers a default export", () => {
    const chosen = { fallback: noop }
    expect(selectThreadAccessExport({ default: chosen, threadAccess: { fallback: noop } })).toBe(
      chosen,
    )
  })

  it("falls through a nullish default to the named threadAccess export", () => {
    const chosen = { fallback: noop }
    expect(selectThreadAccessExport({ threadAccess: chosen })).toBe(chosen)
    expect(selectThreadAccessExport({ default: undefined, threadAccess: chosen })).toBe(chosen)
    expect(selectThreadAccessExport({ default: null, threadAccess: chosen })).toBe(chosen)
  })

  it("returns undefined for a module that binds neither", () => {
    expect(selectThreadAccessExport({})).toBeUndefined()
    expect(selectThreadAccessExport(null)).toBeUndefined()
    expect(selectThreadAccessExport(undefined)).toBeUndefined()
    expect(selectThreadAccessExport("nope")).toBeUndefined()
  })

  it("returns a non-object default rather than swallowing it, so the validator can report it", () => {
    expect(selectThreadAccessExport({ default: "nope" })).toBe("nope")
  })
})

describe("threadAccessCandidatePaths", () => {
  it("lists the four candidates in probe precedence order", () => {
    expect(threadAccessCandidatePaths("/app")).toEqual([
      "/app/src/thread-access.ts",
      "/app/src/thread-access.js",
      "/app/thread-access.ts",
      "/app/thread-access.js",
    ])
  })
})

describe("validateThreadAccessPolicy", () => {
  it("accepts a policy with only a fallback", () => {
    expect(validateThreadAccessPolicy({ fallback: noop })).toBeUndefined()
  })

  it("accepts a policy with every per-action handler", () => {
    expect(
      validateThreadAccessPolicy({
        create: noop,
        delete: noop,
        fallback: noop,
        read: noop,
        update: noop,
      }),
    ).toBeUndefined()
  })

  it("reports a value that is not an object", () => {
    expect(validateThreadAccessPolicy("nope")).toBe("the bound value is not an object")
    expect(validateThreadAccessPolicy(null)).toBe("the bound value is not an object")
    expect(validateThreadAccessPolicy(noop)).toBe("the bound value is not an object")
  })

  it("reports a missing or non-function fallback by name", () => {
    expect(validateThreadAccessPolicy({})).toContain("`fallback`")
    expect(validateThreadAccessPolicy({ fallback: "nope" })).toContain("`fallback`")
  })

  it("reports a per-action key that is present but is not a function", () => {
    expect(validateThreadAccessPolicy({ fallback: noop, read: "nope" })).toBe(
      "`read` is present but is not a function",
    )
  })
})

describe("normalizeThreadAccessResult", () => {
  it("keeps a well-formed allow", () => {
    expect(normalizeThreadAccessResult({ decision: "allow" }, "thread.get")).toEqual({
      decision: "allow",
    })
  })

  it("keeps a record stamp and drops a non-record one", () => {
    expect(
      normalizeThreadAccessResult(
        { decision: "allow", stamp: { ownerId: "u-1" } },
        "thread.create",
      ),
    ).toEqual({ decision: "allow", stamp: { ownerId: "u-1" } })
    expect(normalizeThreadAccessResult({ decision: "allow", stamp: [1] }, "thread.create")).toEqual(
      {
        decision: "allow",
      },
    )
    expect(normalizeThreadAccessResult({ decision: "allow", stamp: 7 }, "thread.create")).toEqual({
      decision: "allow",
    })
  })

  it("keeps a deny's 403 or 404 and drops any other status", () => {
    expect(normalizeThreadAccessResult({ decision: "deny", status: 403 }, "thread.get")).toEqual({
      decision: "deny",
      status: 403,
    })
    expect(normalizeThreadAccessResult({ decision: "deny", status: 404 }, "thread.get")).toEqual({
      decision: "deny",
      status: 404,
    })
    for (const status of [200, 401, 500]) {
      expect(normalizeThreadAccessResult({ decision: "deny", status }, "thread.get")).toEqual({
        decision: "deny",
      })
    }
  })

  it("keeps a deny body and drops an explicitly-undefined one", () => {
    expect(
      normalizeThreadAccessResult({ body: { error: "x" }, decision: "deny" }, "thread.delete"),
    ).toEqual({ body: { error: "x" }, decision: "deny" })
    const undefinedBody = normalizeThreadAccessResult(
      { body: undefined, decision: "deny" },
      "thread.delete",
    )
    expect("body" in undefinedBody).toBe(false)
  })

  it("denies with no status for every malformed return, and warns once per denial", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      for (const value of [
        undefined,
        null,
        "allow",
        1,
        [],
        { action: "continue" },
        { decision: "allowed" },
      ]) {
        expect(normalizeThreadAccessResult(value, "thread.state", "t-1")).toEqual({
          decision: "deny",
        })
      }
      expect(warn).toHaveBeenCalledTimes(7)
      expect(warn.mock.calls[0]?.[0]).toContain("thread.state")
      expect(warn.mock.calls[0]?.[0]).toContain("t-1")
    } finally {
      warn.mockRestore()
    }
  })

  it("does not warn for a well-formed result", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      normalizeThreadAccessResult({ decision: "allow" }, "thread.get")
      normalizeThreadAccessResult({ decision: "deny" }, "thread.get")
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("threadAccessBootLine", () => {
  it("names each resolution source, and says so when there is none", () => {
    expect(threadAccessBootLine({ fromManifest: false, fromOptions: true, resolved: true })).toBe(
      "Dawn: thread access policy bound from the runtime options",
    )
    expect(threadAccessBootLine({ fromManifest: true, fromOptions: false, resolved: true })).toBe(
      "Dawn: thread access policy bound from the build manifest",
    )
    expect(threadAccessBootLine({ fromManifest: false, fromOptions: false, resolved: true })).toBe(
      "Dawn: thread access policy bound from src/thread-access.ts",
    )
    expect(threadAccessBootLine({ fromManifest: false, fromOptions: false, resolved: false })).toBe(
      "Dawn: no thread access policy (all thread endpoints are open)",
    )
  })
})
