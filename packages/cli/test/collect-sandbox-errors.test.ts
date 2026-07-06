import { describe, expect, test } from "vitest"
import { collectSandboxErrors } from "../src/lib/runtime/collect-sandbox-errors.js"

describe("collectSandboxErrors", () => {
  test("no sandbox config → no errors", async () => {
    expect(await collectSandboxErrors({})).toEqual([])
  })

  test("provider missing acquire → error", async () => {
    const errors = await collectSandboxErrors({ sandbox: { provider: { name: "bad" } as never } })
    expect(errors.join("\n")).toMatch(/acquire/)
  })

  test("preflight failure → error with detail", async () => {
    const provider = {
      name: "p",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
      preflight: async () => ({ ok: false, detail: "Docker daemon not reachable" }),
    }
    const errors = await collectSandboxErrors({ sandbox: { provider } })
    expect(errors.join("\n")).toMatch(/Docker daemon not reachable/)
  })

  test("preflight throw → error with message", async () => {
    const provider = {
      name: "p",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
      preflight: async () => {
        throw new Error("boom")
      },
    }
    const errors = await collectSandboxErrors({ sandbox: { provider } })
    expect(errors.join("\n")).toMatch(/boom/)
  })

  test("healthy provider → no errors", async () => {
    const provider = {
      name: "p",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
      preflight: async () => ({ ok: true }),
    }
    expect(await collectSandboxErrors({ sandbox: { provider } })).toEqual([])
  })
})
