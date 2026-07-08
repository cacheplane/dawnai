import { describe, expect, it } from "vitest"
import { pgvectorMemoryStore } from "../src/index.js"
import { assertIdentifier, vectorColumnDef } from "../src/schema.js"

describe("vectorColumnDef", () => {
  it("dims ≤ 2000 → plain vector + vector_cosine_ops", () => {
    expect(vectorColumnDef(1536)).toEqual({ type: "vector(1536)", ops: "vector_cosine_ops" })
  })
  it("2000 < dims ≤ 4000 → halfvec + halfvec_cosine_ops (text-embedding-3-large)", () => {
    expect(vectorColumnDef(3072)).toEqual({ type: "halfvec(3072)", ops: "halfvec_cosine_ops" })
  })
  it("dims > 4000 → throws a clear error naming the ceiling", () => {
    expect(() => vectorColumnDef(5000)).toThrow(/4000/)
  })
  it("non-positive/non-integer dims throw", () => {
    expect(() => vectorColumnDef(0)).toThrow()
    expect(() => vectorColumnDef(1.5)).toThrow()
  })
})

describe("assertIdentifier", () => {
  it("accepts valid SQL identifiers", () => {
    expect(() => assertIdentifier("prefix", "dawn")).not.toThrow()
    expect(() => assertIdentifier("schema", "public")).not.toThrow()
    expect(() => assertIdentifier("prefix", "_mem_v2")).not.toThrow()
    expect(() => assertIdentifier("schema", "MySchema")).not.toThrow()
  })
  it("rejects identifiers with unsafe characters", () => {
    expect(() => assertIdentifier("prefix", "bad-name")).toThrow(/prefix/)
    expect(() => assertIdentifier("schema", "public; DROP TABLE x")).toThrow(/schema/)
    expect(() => assertIdentifier("prefix", "1leading")).toThrow(/prefix/)
    expect(() => assertIdentifier("schema", "")).toThrow(/schema/)
  })
})

describe("pgvectorMemoryStore", () => {
  it("validates dimensions at construction time", () => {
    expect(() => pgvectorMemoryStore({ dimensions: 4001 })).toThrow(/4000 halfvec index ceiling/)
  })
})
