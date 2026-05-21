import { describe, expect, it } from "vitest"
import { checkToolNameUniqueness } from "../src/lib/runtime/check-tool-name-uniqueness.js"

describe("checkToolNameUniqueness", () => {
  it("returns ok when no collisions", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "fetchData" }],
      capabilityTools: [{ name: "writeTodos" }, { name: "readSkill" }],
      reservedNames: new Set(["task"]),
    })
    expect(result.ok).toBe(true)
  })

  it("flags user tool shadowing a capability tool", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "writeTodos" }],
      capabilityTools: [{ name: "writeTodos" }],
      reservedNames: new Set(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("Capability conflict")
    expect(result.message).toContain("writeTodos")
  })

  it("flags user tool using a reserved name", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "task" }],
      capabilityTools: [],
      reservedNames: new Set(["task"]),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("Reserved tool name")
    expect(result.message).toContain("task")
  })
})

describe("checkToolNameUniqueness — overridable", () => {
  it("when a capability tool is overridable, a user tool with the same name does NOT error and replaces it", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "readFile" }],
      capabilityTools: [{ name: "readFile", overridable: true }],
      reservedNames: new Set(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The returned effectiveCapabilityTools drops the overridden tool.
    expect(result.effectiveCapabilityTools).toEqual([])
  })

  it("when a capability tool is NOT overridable, a user tool with the same name still errors", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "writeTodos" }],
      capabilityTools: [{ name: "writeTodos" }], // no overridable flag = not overridable
      reservedNames: new Set(),
    })
    expect(result.ok).toBe(false)
  })

  it("returns the un-shadowed capability tools in effectiveCapabilityTools", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "readFile" }],
      capabilityTools: [
        { name: "readFile", overridable: true },
        { name: "writeFile", overridable: true },
      ],
      reservedNames: new Set(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.effectiveCapabilityTools.map((t) => t.name)).toEqual(["writeFile"])
  })
})
