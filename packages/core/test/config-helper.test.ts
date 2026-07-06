import { describe, expect, test } from "vitest"
import { config } from "../src/config-helper.ts"
import type { DawnConfig } from "../src/types.ts"

describe("config()", () => {
  test("returns the same object (identity) for IntelliSense", () => {
    const c: DawnConfig = { appDir: "src/app" }
    expect(config(c)).toBe(c)
  })

  test("accepts a sandbox key", () => {
    const provider = {
      name: "noop",
      acquire: async () => ({
        threadId: "t",
        filesystem: {} as never,
        exec: {} as never,
        workspaceRoot: "/workspace",
      }),
      release: async () => {},
      destroy: async () => {},
    }
    const c = config({ sandbox: { provider, network: { mode: "deny" } } })
    expect(c.sandbox?.provider.name).toBe("noop")
  })
})
