import type { Prettify, RouteStateMap, RouteToolMap } from "@dawn-ai/sdk"
import { describe, expectTypeOf, test } from "vitest"

describe("Prettify<T>", () => {
  test("resolves intersection types into flat object", () => {
    type A = { a: string } & { b: number }
    type Result = Prettify<A>
    expectTypeOf<Result>().toEqualTypeOf<{ a: string; b: number }>()
  })

  test("preserves optional properties", () => {
    type A = { a: string; b?: number }
    type Result = Prettify<A>
    expectTypeOf<Result>().toEqualTypeOf<{ a: string; b?: number }>()
  })
})

describe("RouteToolMap", () => {
  test("is an empty interface by default", () => {
    expectTypeOf<RouteToolMap>().toEqualTypeOf<{}>()
  })
})

describe("RouteStateMap", () => {
  test("is an empty interface by default", () => {
    expectTypeOf<RouteStateMap>().toEqualTypeOf<{}>()
  })
})
