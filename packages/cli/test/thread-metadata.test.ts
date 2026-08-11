import { THREAD_ACCESS_METADATA_KEY } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"

import { assertNoReservedKey, stripReservedThreadMetadata } from "../src/lib/dev/thread-metadata.js"

describe("stripReservedThreadMetadata", () => {
  it("passes undefined through", () => {
    expect(stripReservedThreadMetadata(undefined)).toBeUndefined()
  })

  it("returns the same object when the reserved key is absent", () => {
    const metadata = { keep: 1 }
    expect(stripReservedThreadMetadata(metadata)).toBe(metadata)
  })

  it("removes the reserved key and keeps every sibling", () => {
    const stripped = stripReservedThreadMetadata({
      [THREAD_ACCESS_METADATA_KEY]: { ownerId: "attacker" },
      keep: 1,
      route: "/chat#agent",
    })
    expect(stripped).toEqual({ keep: 1, route: "/chat#agent" })
  })

  it("returns an empty object when the reserved key was the only entry", () => {
    expect(stripReservedThreadMetadata({ [THREAD_ACCESS_METADATA_KEY]: { ownerId: "x" } })).toEqual(
      {},
    )
  })

  it("does not let a __proto__ entry re-attach the reserved key to the result", () => {
    // A JSON request body is the only way metadata reaches this function, and
    // `JSON.parse` makes `__proto__` an OWN data property instead of setting
    // the prototype. Copying that entry with a plain assignment hands it to the
    // `__proto__` setter, which puts the reserved key back within reach of
    // `stripped[THREAD_ACCESS_METADATA_KEY]` while `Object.hasOwn` says it is
    // gone — the forged stamp survives on the prototype chain.
    const metadata = JSON.parse(
      '{"dawn:access":{"ownerId":"decoy"},"__proto__":{"dawn:access":{"ownerId":"attacker"}},"keep":1}',
    ) as Record<string, unknown>
    const stripped = stripReservedThreadMetadata(metadata)
    expect(stripped?.[THREAD_ACCESS_METADATA_KEY]).toBeUndefined()
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype)
    expect(Object.hasOwn(stripped as object, "__proto__")).toBe(true)
    expect(Object.keys(stripped as object)).toEqual(["__proto__", "keep"])
  })

  it("leaves a __proto__ entry unreachable when there was no reserved key to strip", () => {
    const metadata = JSON.parse('{"__proto__":{"dawn:access":{"ownerId":"attacker"}},"keep":1}') as
      | Record<string, unknown>
      | undefined
    const stripped = stripReservedThreadMetadata(metadata)
    expect(stripped?.[THREAD_ACCESS_METADATA_KEY]).toBeUndefined()
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype)
  })
})

describe("assertNoReservedKey", () => {
  it("accepts a patch that does not carry the reserved key", () => {
    expect(() => assertNoReservedKey({ route: "/chat#agent" })).not.toThrow()
  })

  it("throws on a patch that would clobber the stamp through the shallow merge", () => {
    expect(() => assertNoReservedKey({ [THREAD_ACCESS_METADATA_KEY]: { ownerId: "x" } })).toThrow(
      /dawn:access/,
    )
  })
})
