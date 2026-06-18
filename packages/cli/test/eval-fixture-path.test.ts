import { describe, expect, it } from "vitest"
import { caseSlug, siblingFixturePath } from "../src/lib/runtime/eval-fixture-path.js"

describe("caseSlug", () => {
  it("slugifies a name: lowercase, non-alphanumeric → single dash, trimmed", () => {
    expect(caseSlug("Greets the User!", 0)).toBe("greets-the-user")
    expect(caseSlug("  multiple   spaces  ", 1)).toBe("multiple-spaces")
  })
  it("falls back to case-<index+1> when name is missing or empties to nothing", () => {
    expect(caseSlug(undefined, 2)).toBe("case-3")
    expect(caseSlug("!!!", 0)).toBe("case-1")
  })
})

describe("siblingFixturePath", () => {
  it("joins baseDir with <evalBasename>.<slug>.fixtures.json", () => {
    const p = siblingFixturePath("/app/src/app/chat/evals/smoke.eval.ts", "/app/src/app/chat/evals", "greets the user", 0)
    expect(p).toBe("/app/src/app/chat/evals/smoke.greets-the-user.fixtures.json")
  })
})
