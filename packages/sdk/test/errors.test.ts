import { describe, expect, it } from "vitest"

import { DAWN_ERRORS, type DawnErrorCode, describeError, errorDocsUrl } from "../src/errors.js"

const CODE_RE = /^DAWN_E\d{4}$/
const DOCS_PATH_RE = /^\/docs\/[a-z0-9-]+(#[a-z0-9-]+)?$/

describe("DAWN_ERRORS registry", () => {
  const entries = Object.entries(DAWN_ERRORS)

  it("has at least the wired families", () => {
    expect(entries.length).toBeGreaterThanOrEqual(10)
  })

  it("every descriptor code matches DAWN_E\\d{4} and equals its key", () => {
    for (const [key, descriptor] of entries) {
      expect(descriptor.code).toMatch(CODE_RE)
      expect(descriptor.code).toBe(key)
    }
  })

  it("codes are unique", () => {
    const codes = entries.map(([, d]) => d.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("every descriptor has a non-empty title", () => {
    for (const [, descriptor] of entries) {
      expect(descriptor.title.length).toBeGreaterThan(0)
    }
  })

  it("every docsPath (when present) matches the /docs/<slug>#<anchor> shape", () => {
    for (const [, descriptor] of entries) {
      if (descriptor.docsPath !== undefined) {
        expect(descriptor.docsPath).toMatch(DOCS_PATH_RE)
      }
    }
  })

  it("registers delegation policy, denial, and dispatch failure errors", () => {
    expect(DAWN_ERRORS.DAWN_E1004).toEqual({
      code: "DAWN_E1004",
      title: "Invalid delegation policy",
      docsPath: "/docs/subagents#delegation-policy",
    })
    expect(DAWN_ERRORS.DAWN_E3002).toEqual({
      code: "DAWN_E3002",
      title: "Subagent dispatch denied",
      docsPath: "/docs/subagents#delegation-policy",
    })
    expect(DAWN_ERRORS.DAWN_E5003).toEqual({
      code: "DAWN_E5003",
      title: "Subagent unavailable or dispatch failed",
      docsPath: "/docs/subagents#dispatch-failures",
    })
    expect(errorDocsUrl("DAWN_E1004")).toBe("https://dawnai.org/docs/subagents#delegation-policy")
    expect(errorDocsUrl("DAWN_E3002")).toBe("https://dawnai.org/docs/subagents#delegation-policy")
    expect(errorDocsUrl("DAWN_E5003")).toBe("https://dawnai.org/docs/subagents#dispatch-failures")
  })
})

describe("describeError", () => {
  it("returns the descriptor for a code", () => {
    expect(describeError("DAWN_E2001")).toBe(DAWN_ERRORS.DAWN_E2001)
  })
})

describe("errorDocsUrl", () => {
  it("returns the canonical URL when the code has a docsPath", () => {
    const url = errorDocsUrl("DAWN_E2001")
    expect(url).toBe("https://dawnai.org/docs/sandbox#what-it-is--and-isnt")
  })

  it("returns undefined for a code without a docsPath", () => {
    const codeWithoutDocs = Object.values(DAWN_ERRORS).find((d) => d.docsPath === undefined)
    expect(codeWithoutDocs).toBeDefined()
    if (codeWithoutDocs) {
      expect(errorDocsUrl(codeWithoutDocs.code as DawnErrorCode)).toBeUndefined()
    }
  })

  it("honors a custom base", () => {
    expect(errorDocsUrl("DAWN_E2001", "https://example.test")).toBe(
      "https://example.test/docs/sandbox#what-it-is--and-isnt",
    )
  })
})
