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

describe("collectSandboxErrors: security shape", () => {
  const ok = {
    name: "p",
    acquire: async () => ({}) as never,
    release: async () => {},
    destroy: async () => {},
    preflight: async () => ({ ok: true }),
  }

  test("pidsLimit must be a positive integer", async () => {
    const errors = await collectSandboxErrors({
      sandbox: { provider: ok, security: { pidsLimit: 0 } },
    })
    expect(errors.join("\n")).toMatch(/pidsLimit/)
  })

  test("runAsNonRoot object needs numeric uid/gid", async () => {
    const errors = await collectSandboxErrors({
      sandbox: { provider: ok, security: { runAsNonRoot: { uid: -1, gid: 0 } as never } },
    })
    expect(errors.join("\n")).toMatch(/uid|gid/)
  })

  test("runAsNonRoot: null → error (must be boolean or object, not null)", async () => {
    const errors = await collectSandboxErrors({
      sandbox: { provider: ok, security: { runAsNonRoot: null as never } },
    })
    expect(errors.join("\n")).toMatch(/not null/)
  })

  test("valid security → no errors", async () => {
    expect(
      await collectSandboxErrors({
        sandbox: {
          provider: ok,
          security: { pidsLimit: 256, runAsNonRoot: { uid: 1000, gid: 1000 } },
        },
      }),
    ).toEqual([])
  })
})
