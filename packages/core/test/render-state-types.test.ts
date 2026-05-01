import { describe, expect, test } from "vitest"

import { renderStateTypes } from "../src/typegen/render-state-types"

describe("renderStateTypes", () => {
  test("renders empty interface when no routes have state", () => {
    const result = renderStateTypes([])
    expect(result).toContain("export interface DawnRouteState {}")
    expect(result).toContain("export type RouteState<P extends DawnRoutePath> = DawnRouteState[P]")
  })

  test("renders state fields for a route", () => {
    const result = renderStateTypes([
      {
        pathname: "/hello/[tenant]",
        fields: [
          { name: "context", type: "string" },
          { name: "confidence", type: "number" },
          { name: "results", type: "string[]" },
        ],
      },
    ])

    expect(result).toContain('"/hello/[tenant]"')
    expect(result).toContain("readonly context: string;")
    expect(result).toContain("readonly confidence: number;")
    expect(result).toContain("readonly results: string[];")
  })

  test("renders multiple routes", () => {
    const result = renderStateTypes([
      {
        pathname: "/a",
        fields: [{ name: "x", type: "string" }],
      },
      {
        pathname: "/b",
        fields: [{ name: "y", type: "number" }],
      },
    ])

    expect(result).toContain('"/a"')
    expect(result).toContain('"/b"')
    expect(result).toContain("readonly x: string;")
    expect(result).toContain("readonly y: number;")
  })

  test("renders RouteState utility type", () => {
    const result = renderStateTypes([
      { pathname: "/test", fields: [{ name: "v", type: "boolean" }] },
    ])
    expect(result).toContain("export type RouteState<P extends DawnRoutePath> = DawnRouteState[P]")
  })
})
