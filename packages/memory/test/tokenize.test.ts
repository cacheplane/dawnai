import { describe, expect, it } from "vitest"
import { tokenize } from "../src/tokenize.js"

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics, dropping empties + short tokens", () => {
    expect(tokenize("Billing Escalate-Above $500!")).toEqual([
      "billing",
      "escalate",
      "above",
      "500",
    ])
  })
  it("dedupes", () => {
    expect(tokenize("pnpm pnpm PNPM")).toEqual(["pnpm"])
  })
  it("drops 1-char tokens", () => {
    expect(tokenize("a bc d ef")).toEqual(["bc", "ef"])
  })
})
