import { describe, expect, test } from "vitest"

import { resolveStateFields } from "../src/state/resolve-state-fields"

describe("resolveStateFields", () => {
  test("infers append reducer for array defaults", () => {
    const defaults = new Map<string, unknown>([
      ["results", []],
      ["tags", ["initial"]],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result).toEqual([
      { name: "results", reducer: "append", default: [] },
      { name: "tags", reducer: "append", default: ["initial"] },
    ])
  })

  test("infers replace reducer for scalar defaults", () => {
    const defaults = new Map<string, unknown>([
      ["context", ""],
      ["confidence", 0],
      ["active", true],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result).toEqual([
      { name: "active", reducer: "replace", default: true },
      { name: "confidence", reducer: "replace", default: 0 },
      { name: "context", reducer: "replace", default: "" },
    ])
  })

  test("reducer overrides take precedence", () => {
    const customReducer = (current: string[], incoming: string[]) => incoming
    const defaults = new Map<string, unknown>([["results", []]])
    const reducerOverrides = new Map<string, (current: unknown, incoming: unknown) => unknown>([
      ["results", customReducer as (current: unknown, incoming: unknown) => unknown],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides })

    expect(result).toEqual([{ name: "results", reducer: customReducer, default: [] }])
  })

  test("infers replace for null and undefined defaults", () => {
    const defaults = new Map<string, unknown>([
      ["data", null],
      ["meta", undefined],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result).toEqual([
      { name: "data", reducer: "replace", default: null },
      { name: "meta", reducer: "replace", default: undefined },
    ])
  })

  test("sorts fields alphabetically by name", () => {
    const defaults = new Map<string, unknown>([
      ["zeta", "z"],
      ["alpha", "a"],
    ])

    const result = resolveStateFields({ defaults, reducerOverrides: new Map() })

    expect(result[0]?.name).toBe("alpha")
    expect(result[1]?.name).toBe("zeta")
  })
})
