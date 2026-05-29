import { describe, expect, it } from "vitest"
import { decodeBlob, encodeBlob } from "../src/checkpointer/serde.js"

describe("checkpoint serde", () => {
  it("round-trips a simple object", () => {
    const obj = { messages: [{ role: "user", content: "hi" }], step: 3 }
    const buf = encodeBlob(obj)
    expect(buf).toBeInstanceOf(Uint8Array)
    expect(decodeBlob(buf)).toEqual(obj)
  })

  it("round-trips null and undefined values", () => {
    expect(decodeBlob(encodeBlob({ a: null }))).toEqual({ a: null })
  })

  it("preserves nested structure", () => {
    const obj = { a: { b: { c: [1, 2, 3] } } }
    expect(decodeBlob(encodeBlob(obj))).toEqual(obj)
  })
})
