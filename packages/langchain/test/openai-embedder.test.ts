// Contract test for openaiEmbedder against aimock's /v1/embeddings endpoint.
// CI-safe: no real OPENAI_API_KEY needed — aimock returns a deterministic
// hash-derived embedding for unmatched requests, so we assert on the SHAPE and
// determinism of the vectors, not on any semantic meaning.
import { LLMock } from "@copilotkit/aimock"
import { afterEach, beforeEach, expect, it } from "vitest"
import { openaiEmbedder } from "../src/openai-embedder.js"

let mock: LLMock
let prevBaseUrl: string | undefined
let prevKey: string | undefined

beforeEach(async () => {
  mock = new LLMock({ port: 0, chunkSize: 4096 })
  await mock.start()
  prevBaseUrl = process.env.OPENAI_BASE_URL
  prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`
  process.env.OPENAI_API_KEY = "test-not-used"
})

afterEach(async () => {
  if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = prevBaseUrl
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = prevKey
  await mock.stop()
})

it("embeds through the OPENAI_BASE_URL seam and returns Float32Array vectors", async () => {
  const embedder = openaiEmbedder({ model: "text-embedding-3-small" })
  const vecs = await embedder.embed(["hello", "world"])

  expect(vecs).toHaveLength(2)
  expect(vecs[0]).toBeInstanceOf(Float32Array)
  expect(vecs[1]).toBeInstanceOf(Float32Array)

  // Both vectors share the same (positive) dimensionality. We assert on the
  // actual length aimock returns rather than hardcoding a provider dimension.
  const len = vecs[0]!.length
  expect(len).toBeGreaterThan(0)
  expect(vecs[1]!.length).toBe(len)
})

it("returns deterministic vectors for the same input", async () => {
  const embedder = openaiEmbedder({ model: "text-embedding-3-small" })
  const a = await embedder.embed(["hello", "world"])
  const b = await embedder.embed(["hello", "world"])

  expect(a[0]!.length).toBe(b[0]!.length)
  expect(Array.from(a[0]!)).toEqual(Array.from(b[0]!))
  expect(Array.from(a[1]!)).toEqual(Array.from(b[1]!))
})
