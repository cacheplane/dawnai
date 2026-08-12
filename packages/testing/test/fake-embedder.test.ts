import { describe, expect, it } from "vitest"
import { fakeEmbedder } from "../src/fake-embedder.js"

describe("fakeEmbedder", () => {
  it("is deterministic and unit-length per text", async () => {
    const e = fakeEmbedder({ dims: 8 })
    const [a1] = await e.embed(["hello world"])
    const [a2] = await e.embed(["hello world"])
    expect([...a1!]).toEqual([...a2!]) // deterministic
    const norm = Math.sqrt([...a1!].reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 6) // normalized
  })
  it("returns a zero vector when the input has no supported tokens", async () => {
    const e = fakeEmbedder({ dims: 8 })
    const [empty, punctuation, oneCharacterTokens] = await e.embed(["", "---", "a i"])
    expect([...empty!]).toEqual(Array.from({ length: 8 }, () => 0))
    expect([...punctuation!]).toEqual([...empty!])
    expect([...oneCharacterTokens!]).toEqual([...empty!])
  })
  it("returns an empty vector when dimensions are zero", async () => {
    const e = fakeEmbedder({ dims: 0 })
    const [vector] = await e.embed(["hello world"])
    expect(vector).toEqual(new Float32Array())
  })
  it("similar strings are nearer than dissimilar ones (cosine)", async () => {
    const e = fakeEmbedder({ dims: 64 })
    const [a] = await e.embed(["faster shipping"])
    const [b] = await e.embed(["faster shipping now"]) // shares tokens
    const [c] = await e.embed(["quarterly tax filing"]) // unrelated
    const cos = (x: Float32Array, y: Float32Array) =>
      [...x].reduce((s, xi, i) => s + xi * (y[i] as number), 0)
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!))
  })
})
