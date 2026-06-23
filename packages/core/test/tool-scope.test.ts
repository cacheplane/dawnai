import { describe, expect, test } from "vitest"

import { resolveToolScope, toolOrigin } from "../src/tool-scope.js"

const A = (name: string) => ({ name, origin: "authored" as const })
const C = (name: string) => ({ name, origin: "capability" as const })

describe("toolOrigin", () => {
  test("capability filePath marker → capability", () => {
    expect(toolOrigin({ filePath: "<capability:runBash>" })).toBe("capability")
  })
  test("real path → authored", () => {
    expect(toolOrigin({ filePath: "/app/src/app/research/tools/search.ts" })).toBe("authored")
  })
})

describe("resolveToolScope", () => {
  const tools = [
    A("search"),
    A("writeNote"),
    C("readFile"),
    C("writeFile"),
    C("runBash"),
    C("task"),
  ]

  test("top route, no scope → all tools", () => {
    const keep = resolveToolScope(tools, undefined, { isSubagent: false, routeId: "/r" })
    expect([...keep].sort()).toEqual([
      "readFile",
      "runBash",
      "search",
      "task",
      "writeFile",
      "writeNote",
    ])
  })

  test("subagent, no scope → authored only (capabilities withheld)", () => {
    const keep = resolveToolScope(tools, undefined, { isSubagent: true, routeId: "/r" })
    expect([...keep].sort()).toEqual(["search", "writeNote"])
  })

  test("subagent allow grants a capability tool, keeps authored", () => {
    const keep = resolveToolScope(
      tools,
      { allow: ["readFile"] },
      { isSubagent: true, routeId: "/r" },
    )
    expect([...keep].sort()).toEqual(["readFile", "search", "writeNote"])
  })

  test("top route deny revokes", () => {
    const keep = resolveToolScope(
      tools,
      { deny: ["runBash"] },
      { isSubagent: false, routeId: "/r" },
    )
    expect(keep.has("runBash")).toBe(false)
    expect(keep.has("readFile")).toBe(true)
  })

  test("deny wins over allow", () => {
    const keep = resolveToolScope(
      tools,
      { allow: ["readFile"], deny: ["readFile"] },
      { isSubagent: true, routeId: "/r" },
    )
    expect(keep.has("readFile")).toBe(false)
  })

  test("subagent deny can drop an authored tool", () => {
    const keep = resolveToolScope(
      tools,
      { deny: ["writeNote"] },
      { isSubagent: true, routeId: "/r" },
    )
    expect([...keep].sort()).toEqual(["search"])
  })

  test("unknown name throws with available list", () => {
    expect(() =>
      resolveToolScope(tools, { allow: ["serch"] }, { isSubagent: true, routeId: "/research" }),
    ).toThrow(/unknown tool\(s\): serch/)
  })
})
