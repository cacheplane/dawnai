import { describe, expect, it } from "vitest"
import { writePolicyFor } from "../src/index.js"

describe("writePolicyFor", () => {
  it("semantic reconciles", () => {
    expect(writePolicyFor("semantic")).toEqual({ mode: "reconcile" })
  })
  it("episodic appends", () => {
    expect(writePolicyFor("episodic")).toEqual({ mode: "append" })
  })
  it("reflection appends (insights accumulate)", () => {
    expect(writePolicyFor("reflection")).toEqual({ mode: "append" })
  })
  it("procedural still throws a not-yet-wired error", () => {
    expect(() => writePolicyFor("procedural")).toThrow(/not yet wired/)
  })
})
