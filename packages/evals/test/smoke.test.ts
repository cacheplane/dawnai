import { describe, expect, it } from "vitest"
import { EVALS_PACKAGE } from "../src/index.js"

describe("@dawn-ai/evals", () => {
  it("loads", () => {
    expect(EVALS_PACKAGE).toBe("@dawn-ai/evals")
  })
})
