import { describe, expect, test } from "vitest"
import { classifyChange } from "../src/lib/dev/classify-change.js"

describe("classifyChange", () => {
  test("tool file change returns typegen", () => {
    expect(classifyChange("src/app/hello/[tenant]/tools/greet.ts")).toBe("typegen")
  })

  test("state.ts change returns typegen", () => {
    expect(classifyChange("src/app/hello/[tenant]/state.ts")).toBe("typegen")
  })

  test("reducer file change returns typegen", () => {
    expect(classifyChange("src/app/hello/[tenant]/reducers/results.ts")).toBe("typegen")
  })

  test("route index.ts change returns restart", () => {
    expect(classifyChange("src/app/hello/[tenant]/index.ts")).toBe("restart")
  })

  test("dawn.config.ts change returns restart", () => {
    expect(classifyChange("dawn.config.ts")).toBe("restart")
  })

  test("random source file returns restart", () => {
    expect(classifyChange("src/lib/utils.ts")).toBe("restart")
  })

  test("nested tool file returns typegen", () => {
    expect(classifyChange("src/app/(public)/hello/[tenant]/tools/search.ts")).toBe("typegen")
  })

  test(".d.ts file in tools returns restart (not a real tool)", () => {
    expect(classifyChange("src/app/hello/[tenant]/tools/greet.d.ts")).toBe("restart")
  })

  test("workspace runtime data changes are ignored", () => {
    expect(classifyChange("workspace/AGENTS.md")).toBe("ignore")
    expect(classifyChange("workspace/notes/output.md")).toBe("ignore")
  })
})
