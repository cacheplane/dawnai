import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"

import { renderError, run } from "../src/index.js"

describe("renderError", () => {
  it("enriches a raw diagnosable error using diagnose()", () => {
    const err = new SyntaxError(
      "The requested module '@langchain/core' does not provide an export named 'tool'",
    )
    const text = renderError(err)
    expect(text).toContain("@langchain/core")
    expect(text).toMatch(/npm ls @langchain\/core|newer version/)
  })

  it("falls back to the raw message for a non-diagnosable error", () => {
    expect(renderError(new Error("plain boom"))).toBe("plain boom")
  })

  it("stringifies a non-Error value", () => {
    expect(renderError("weird")).toBe("weird")
  })
})

describe("run() generic-error branch", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a raw diagnosable error via renderError()", async () => {
    const rawError = new SyntaxError(
      "The requested module '@langchain/core' does not provide an export named 'tool'",
    )
    // The generic branch only fires for errors that escape every command's
    // CliError wrapper (the loadDawnConfig / unwrapped-import case). Reproduce
    // that by making the program's parse reject with a raw error.
    vi.spyOn(Command.prototype, "parseAsync").mockRejectedValue(rawError)

    const stderr: string[] = []
    const exitCode = await run([], {
      stderr: (message) => {
        stderr.push(message)
      },
      stdin: async () => "",
      stdout: () => {},
    })

    expect(exitCode).toBe(1)
    expect(stderr.join("")).toBe(`${renderError(rawError)}\n`)
    expect(stderr.join("")).toContain("@langchain/core")
  })
})
