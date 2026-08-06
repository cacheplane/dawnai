/**
 * A synchronous SHA-1 with no `node:` dependency — the pure counterpart of
 * `createHash("sha1")`, in the same spirit as `pure-path.ts`.
 *
 * WHY: the episode recorder derives a stable record id by hashing
 * `namespace|sourceId|startedAt`, and it runs on the REQUEST path — i.e. inside
 * the `@dawn-ai/cli/fetch` graph, which may not import `node:crypto` (see
 * test/fetch-entry-purity.test.ts). Web Crypto has no synchronous digest, so
 * the algorithm is ported here instead. Output matches node's exactly;
 * test/pure-hash.test.ts pins that against `node:crypto` over a spec-vector +
 * multi-block + Unicode suite.
 *
 * NOT a general-purpose security primitive, and no caller should treat it as
 * one: its single use is deriving a short, stable, well-distributed id from a
 * short key. SHA-1 has been broken for collision resistance since 2017, and
 * the id truncates the digest to 64 bits anyway.
 */

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function toHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0")
}

/** SHA-1 of the UTF-8 encoding of `input`, as 40 lowercase hex characters. */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)

  // Message + 0x80 + zero pad + 8-byte big-endian bit length, to a multiple of 64.
  const paddedLength = (Math.floor((bytes.length + 8) / 64) + 1) * 64
  const block = new Uint8Array(paddedLength)
  block.set(bytes)
  block[bytes.length] = 0x80
  const view = new DataView(block.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  // Every read below is provably in range (j < 80, i + j * 4 < paddedLength);
  // `?? 0` only satisfies noUncheckedIndexedAccess.
  const w = new Uint32Array(80)
  for (let i = 0; i < paddedLength; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false)
    for (let j = 16; j < 80; j++) {
      w[j] = rotl((w[j - 3] ?? 0) ^ (w[j - 8] ?? 0) ^ (w[j - 14] ?? 0) ^ (w[j - 16] ?? 0), 1)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let j = 0; j < 80; j++) {
      let f: number
      let k: number
      if (j < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (j < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      // The sum stays exact in a double (< 2^35) and `>>> 0` reduces mod 2^32.
      const temp = (rotl(a, 5) + f + e + k + (w[j] ?? 0)) >>> 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return toHex8(h0) + toHex8(h1) + toHex8(h2) + toHex8(h3) + toHex8(h4)
}
