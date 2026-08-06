import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { sha1Hex, sha256Hex } from "../src/pure/hash.js"

/**
 * The pure SHA-1 exists so the episode recorder can hash on the node-free
 * fetch graph. It is only worth having if it is EXACTLY node's, so this pins
 * it to `node:crypto` — the same parity-suite treatment `pure-path.ts` gets.
 */
const CASES: readonly string[] = [
  // FIPS-180 sample vectors (their digests are the canonical ones).
  "",
  "abc",
  "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
  // Real episode-id keys: `namespace|sourceId|startedAtIso`.
  "route=/chat|t-run-1a2b3c4d|2026-08-08T04:40:00.000Z",
  "workspace=app|route=/chat|run-123|2026-08-08T04:40:00.000Z",
  // Length-boundary cases around the 55/56/64-byte padding edges, where a
  // wrong pad emits an extra (or missing) block.
  "x".repeat(54),
  "x".repeat(55),
  "x".repeat(56),
  "x".repeat(63),
  "x".repeat(64),
  "x".repeat(65),
  "x".repeat(119),
  "x".repeat(120),
  // Multi-block and multi-byte UTF-8 (TextEncoder vs node's utf8 encoding).
  "y".repeat(1000),
  "café ☕ 日本語 — em dash",
  "\u{1F600}\u{1F680}",
]

describe("sha1Hex", () => {
  it("matches node:crypto sha1 for every case", () => {
    for (const input of CASES) {
      expect(sha1Hex(input), `input: ${JSON.stringify(input.slice(0, 40))}`).toBe(
        createHash("sha1").update(input).digest("hex"),
      )
    }
  })

  it("produces 40 lowercase hex characters", () => {
    expect(sha1Hex("abc")).toMatch(/^[0-9a-f]{40}$/)
  })

  it("matches the published vector for 'abc'", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d")
  })
})

/**
 * `sha256Hex` gets the same treatment: it replaces `createHash("sha256")` on
 * the node-free graph (the offload store's content-hashed filenames), so it is
 * only worth having if it is byte-identical to node's.
 */
const SHA256_CASES: readonly string[] = [
  // FIPS-180 sample vectors, including the 448-bit boundary message.
  "",
  "abc",
  "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
  // Real offload keys: the tool output whose hash names the file.
  "hello world",
  'generateReport|{"query":"quarterly revenue"}',
  // Length-boundary cases around the 55/56/64-byte padding edges.
  "x".repeat(54),
  "x".repeat(55),
  "x".repeat(56),
  "x".repeat(63),
  "x".repeat(64),
  "x".repeat(65),
  "x".repeat(119),
  "x".repeat(120),
  // Multi-block and multi-byte UTF-8 (TextEncoder vs node's utf8 encoding).
  "z".repeat(1000),
  "café ☕ 日本語 — em dash",
  "\u{1F600}\u{1F680}",
]

describe("sha256Hex", () => {
  it("matches node:crypto sha256 for every case", () => {
    for (const input of SHA256_CASES) {
      expect(sha256Hex(input), `input: ${JSON.stringify(input.slice(0, 40))}`).toBe(
        createHash("sha256").update(input).digest("hex"),
      )
    }
  })

  it("produces 64 lowercase hex characters", () => {
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("matches the published vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
})
