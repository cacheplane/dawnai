import { describe, expect, test } from "vitest"

import { checkRuntime, gte } from "../src/lib/verify/check-runtime.js"

describe("gte", () => {
  test("pure MAJOR.MINOR.PATCH numeric compare", () => {
    // 22.9.0 < 22.13.0 < 22.13.1 < 23.0.0
    expect(gte("22.9.0", "22.13.0")).toBe(false)
    expect(gte("22.13.0", "22.13.0")).toBe(true)
    expect(gte("22.13.1", "22.13.0")).toBe(true)
    expect(gte("23.0.0", "22.13.0")).toBe(true)
  })

  test("compares numerically, not lexically", () => {
    // "9" > "13" lexically but 9 < 13 numerically
    expect(gte("22.9.0", "22.13.0")).toBe(false)
    expect(gte("22.100.0", "22.13.0")).toBe(true)
  })
})

describe("checkRuntime", () => {
  test("Node below floor → failed", async () => {
    const result = await checkRuntime({ nodeVersion: "22.12.5" })
    expect(result.name).toBe("runtime")
    expect(result.node.ok).toBe(false)
    expect(result.node.floor).toBe("22.13.0")
    expect(result.node.version).toBe("22.12.5")
    expect(result.node.code).toBe("DAWN_E5101")
    expect(result.status).toBe("failed")
  })

  test("Node at/above floor → passed", async () => {
    const result = await checkRuntime({ nodeVersion: "22.14.0" })
    expect(result.node.ok).toBe(true)
    expect(result.node.code).toBeUndefined()
    expect(result.status).toBe("passed")
  })

  test("no sandbox provider → docker sub-check absent", async () => {
    const result = await checkRuntime({ nodeVersion: "22.14.0" })
    expect(result.docker).toBeUndefined()
  })

  test("sandbox provider with failing preflight → docker.ok false + failed", async () => {
    const result = await checkRuntime({
      nodeVersion: "22.14.0",
      sandboxProvider: {
        name: "fake",
        preflight: async () => ({ ok: false, detail: "daemon unreachable" }),
      },
    })
    expect(result.docker).toEqual({
      ok: false,
      detail: "daemon unreachable",
      code: "DAWN_E2002",
    })
    expect(result.status).toBe("failed")
  })

  test("sandbox provider with passing preflight → docker.ok true + passed", async () => {
    const result = await checkRuntime({
      nodeVersion: "22.14.0",
      sandboxProvider: {
        name: "fake",
        preflight: async () => ({ ok: true }),
      },
    })
    expect(result.docker).toEqual({ ok: true, detail: "reachable" })
    expect(result.status).toBe("passed")
  })

  test("stale Node with a healthy sandbox → still failed on Node", async () => {
    const result = await checkRuntime({
      nodeVersion: "20.0.0",
      sandboxProvider: {
        name: "fake",
        preflight: async () => ({ ok: true }),
      },
    })
    expect(result.node.ok).toBe(false)
    expect(result.docker?.ok).toBe(true)
    expect(result.status).toBe("failed")
  })
})
