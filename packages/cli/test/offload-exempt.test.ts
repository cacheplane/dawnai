import { describe, expect, it } from "vitest"
import { exemptToolSet } from "../src/lib/runtime/execute-route.js"

describe("exemptToolSet", () => {
  it("always exempts the built-in retrieval/inspection tools", () => {
    const exempt = exemptToolSet()
    expect(exempt.has("readFile")).toBe(true)
    expect(exempt.has("listDir")).toBe(true)
  })

  it("does not exempt offload-eligible tools", () => {
    const exempt = exemptToolSet()
    expect(exempt.has("runBash")).toBe(false)
    expect(exempt.has("writeFile")).toBe(false)
    expect(exempt.has("generateReport")).toBe(false)
  })

  it("merges caller-provided names with the built-in defaults", () => {
    const exempt = exemptToolSet(["myCustomReader"])
    expect(exempt.has("myCustomReader")).toBe(true)
    // built-ins remain exempt even when a custom list is supplied
    expect(exempt.has("readFile")).toBe(true)
    expect(exempt.has("listDir")).toBe(true)
  })

  it("keeps readFile exempt even if the config list omits it", () => {
    const exempt = exemptToolSet(["somethingElse"])
    expect(exempt.has("readFile")).toBe(true)
  })
})
