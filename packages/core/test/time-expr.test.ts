import { describe, expect, it } from "vitest"
import { resolveTimeExpr } from "../src/capabilities/built-in/time-expr.js"

const NOW = "2026-08-05T12:00:00.000Z"
describe("resolveTimeExpr", () => {
  it("passes ISO timestamps through unchanged", () => {
    expect(resolveTimeExpr("2026-08-01T00:00:00.000Z", NOW)).toBe("2026-08-01T00:00:00.000Z")
  })
  it("resolves relative offsets against now", () => {
    expect(resolveTimeExpr("-24h", NOW)).toBe("2026-08-04T12:00:00.000Z")
    expect(resolveTimeExpr("-7d", NOW)).toBe("2026-07-29T12:00:00.000Z")
    expect(resolveTimeExpr("-30m", NOW)).toBe("2026-08-05T11:30:00.000Z")
  })
  it("rejects garbage with an actionable error", () => {
    expect(() => resolveTimeExpr("yesterday", NOW)).toThrow(/ISO timestamp or relative/)
    expect(() => resolveTimeExpr("-3y", NOW)).toThrow(/ISO timestamp or relative/)
  })
})
