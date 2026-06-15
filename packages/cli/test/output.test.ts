import { describe, expect, it } from "vitest"
import { CliError } from "../src/lib/output.js"

describe("CliError", () => {
  it("preserves an optional cause", () => {
    const root = new Error("root")
    const err = new CliError("wrapped", 2, { cause: root })
    expect(err.exitCode).toBe(2)
    expect(err.cause).toBe(root)
  })
  it("defaults exitCode to 1 and has no cause when omitted", () => {
    const err = new CliError("plain")
    expect(err.exitCode).toBe(1)
    expect(err.cause).toBeUndefined()
  })
})
