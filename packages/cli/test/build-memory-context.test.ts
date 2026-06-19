import { describe, expect, it } from "vitest"
import { buildMemoryContext } from "../src/lib/runtime/resolve-memory.js"

const fakeStore = {
  put: async () => {},
  get: async () => null,
  search: async () => [],
  update: async () => {},
  supersede: async () => {},
}
const schema = {
  safeParse: (d: unknown) =>
    d && typeof (d as Record<string, unknown>).subject === "string"
      ? { success: true, data: d }
      : { success: false, error: { message: "bad" } },
}

describe("buildMemoryContext", () => {
  it("computes a namespace from the route's declared scope", () => {
    const ctx = buildMemoryContext({
      defined: { kind: "semantic", scope: ["workspace", "route"], schema },
      store: fakeStore as Parameters<typeof buildMemoryContext>[0]["store"],
      writes: "candidate",
      appRoot: "/tmp/acme-app",
      routePath: "/support",
      now: "2026-01-01T00:00:00.000Z",
    })
    expect(ctx.namespace).toBe("workspace=acme-app|route=/support")
    expect(ctx.writes).toBe("candidate")
  })

  it("validate accepts conforming data and rejects bad data", () => {
    const ctx = buildMemoryContext({
      defined: { kind: "semantic", scope: ["route"], schema },
      store: fakeStore as Parameters<typeof buildMemoryContext>[0]["store"],
      writes: "candidate",
      appRoot: "/x",
      routePath: "/r",
      now: "t",
    })
    expect(ctx.validate({ subject: "billing" })).toEqual({
      ok: true,
      value: { subject: "billing" },
    })
    expect(ctx.validate({}).ok).toBe(false)
  })
})
