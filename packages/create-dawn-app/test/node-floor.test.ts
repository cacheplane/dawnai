import { describe, expect, test } from "vitest"

import { assertSupportedNode } from "../src/index.js"

describe("assertSupportedNode", () => {
  test("throws below the Node 24 floor with an actionable message", () => {
    expect(() => assertSupportedNode("v22.14.0")).toThrow(/requires Node 24\+/)
    expect(() => assertSupportedNode("v20.11.0")).toThrow(/nvm install 24/)
  })

  test("passes at and above the floor", () => {
    expect(() => assertSupportedNode("v24.0.0")).not.toThrow()
    expect(() => assertSupportedNode("v24.18.0")).not.toThrow()
    expect(() => assertSupportedNode("v26.1.0")).not.toThrow()
  })

  test("defaults to the running process version", () => {
    // The test suite itself runs on a supported Node, so the default succeeds.
    expect(() => assertSupportedNode()).not.toThrow()
  })
})
