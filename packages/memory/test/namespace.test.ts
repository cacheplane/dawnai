import { describe, expect, it } from "vitest"
import { serializeNamespace } from "../src/namespace.js"

describe("serializeNamespace", () => {
  it("serializes a scope tuple with stable key order", () => {
    expect(serializeNamespace({ route: "/support", workspace: "acme" })).toBe(
      "workspace=acme|route=/support",
    )
  })
  it("omits undefined dimensions; canonical order workspace,route,tenant,user,agent", () => {
    expect(serializeNamespace({ workspace: "acme", tenant: "t1", user: "u1" })).toBe(
      "workspace=acme|tenant=t1|user=u1",
    )
  })
  it("throws on an empty tuple (fail-closed)", () => {
    expect(() => serializeNamespace({})).toThrow(/at least one/i)
  })
})
