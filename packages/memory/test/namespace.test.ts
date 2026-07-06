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

  describe("delimiter escaping in values", () => {
    it("leaves ordinary values byte-identical (backward compatibility)", () => {
      // The common case — no reserved chars — must not change, or existing
      // stored rows and persisted permission patterns would stop matching.
      expect(serializeNamespace({ workspace: "acme", route: "/support", user: "u-1" })).toBe(
        "workspace=acme|route=/support|user=u-1",
      )
    })

    it("percent-encodes a pipe in a value so it can't act as a delimiter", () => {
      expect(serializeNamespace({ workspace: "app", tenant: "a|b" })).toBe(
        "workspace=app|tenant=a%7Cb",
      )
    })

    it("percent-encodes an equals in a value so it can't act as a separator", () => {
      expect(serializeNamespace({ workspace: "app", user: "k=v" })).toBe("workspace=app|user=k%3Dv")
    })

    it("percent-encodes a literal percent first (reversibly)", () => {
      expect(serializeNamespace({ workspace: "app", tenant: "50%off" })).toBe(
        "workspace=app|tenant=50%25off",
      )
    })

    it("distinguishes values that would otherwise collide across the delimiter", () => {
      // Without escaping, a tenant value carrying delimiters could masquerade as
      // extra dimensions; escaping keeps distinct scopes distinct.
      const injected = serializeNamespace({ workspace: "app", tenant: "a|route=/x" })
      const genuine = serializeNamespace({ workspace: "app", route: "/x", tenant: "a" })
      expect(injected).not.toBe(genuine)
      expect(injected).toBe("workspace=app|tenant=a%7Croute%3D/x")
      expect(genuine).toBe("workspace=app|route=/x|tenant=a")
    })
  })
})
