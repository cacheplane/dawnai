import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"

import { run } from "../src/index.js"
import { CliError } from "../src/lib/output.js"

async function runWithError(error: unknown): Promise<{ code: number; stderr: string }> {
  vi.spyOn(Command.prototype, "parseAsync").mockRejectedValue(error)
  const stderr: string[] = []
  const code = await run([], {
    stderr: (message) => {
      stderr.push(message)
    },
    stdin: async () => "",
    stdout: () => {},
  })
  return { code, stderr: stderr.join("") }
}

describe("CliError with an error code", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders the message followed by a [CODE] line with the docs URL", async () => {
    const { code, stderr } = await runWithError(
      new CliError("Sandbox unavailable: docker run failed", 1, { code: "DAWN_E2001" }),
    )
    expect(code).toBe(1)
    expect(stderr).toContain("Sandbox unavailable: docker run failed")
    expect(stderr).toContain("[DAWN_E2001]")
    expect(stderr).toContain("https://dawnai.org/docs/sandbox#what-it-is--and-isnt")
    // The code line comes after the message.
    expect(stderr.indexOf("[DAWN_E2001]")).toBeGreaterThan(stderr.indexOf("Sandbox unavailable"))
  })

  it("renders just the [CODE] when the code has no docsPath", async () => {
    const { stderr } = await runWithError(
      new CliError("Import mismatch", 1, { code: "DAWN_E5001" }),
    )
    expect(stderr).toContain("Import mismatch")
    expect(stderr).toContain("[DAWN_E5001]")
    expect(stderr).not.toContain("See https://")
  })

  it("renders exactly the message when there is no code (unchanged)", async () => {
    const { stderr } = await runWithError(new CliError("plain boom"))
    expect(stderr).toBe("plain boom\n")
  })
})
