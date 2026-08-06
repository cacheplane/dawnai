/**
 * Synchronous SHA-1 and SHA-256 with no `node:` dependency — the pure
 * counterparts of `createHash("sha1")` / `createHash("sha256")`, in the same
 * spirit as `path.ts`.
 *
 * WHY: the episode recorder derives a stable record id by hashing
 * `namespace|sourceId|startedAt`, and it runs on the REQUEST path — i.e. inside
 * the `@dawn-ai/cli/fetch` graph, which may not import `node:crypto` (see
 * `@dawn-ai/cli`'s test/fetch-entry-purity.test.ts). The offload store names
 * files after a SHA-256 of their content on the same path. Web Crypto has no
 * synchronous digest, so
 * the algorithm is ported here instead. Output matches node's exactly;
 * test/pure-hash.test.ts pins that against `node:crypto` over a spec-vector +
 * multi-block + Unicode suite.
 *
 * NOT general-purpose security primitives, and no caller should treat them as
 * such: their use is deriving short, stable, well-distributed ids from short
 * keys. SHA-1 has been broken for collision resistance since 2017, and the ids
 * truncate the digest to 64 bits anyway.
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

/** SHA-256 round constants (FIPS 180-4 §4.2.2). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

/**
 * SHA-256 of the UTF-8 encoding of `input`, as 64 lowercase hex characters —
 * the pure counterpart of `createHash("sha256")`, pinned to it by
 * `test/pure-hash.test.ts`.
 */
export function sha256Hex(input: string): string {
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

  // FIPS 180-4 §5.3.3 initial hash value.
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  // Every read below is provably in range (j < 64, i + j * 4 < paddedLength);
  // `?? 0` only satisfies noUncheckedIndexedAccess.
  const w = new Uint32Array(64)
  for (let i = 0; i < paddedLength; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false)
    for (let j = 16; j < 64; j++) {
      const x = w[j - 15] ?? 0
      const y = w[j - 2] ?? 0
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[j] = ((w[j - 16] ?? 0) + s0 + (w[j - 7] ?? 0) + s1) >>> 0
    }

    let a = h[0] ?? 0
    let b = h[1] ?? 0
    let c = h[2] ?? 0
    let d = h[3] ?? 0
    let e = h[4] ?? 0
    let f = h[5] ?? 0
    let g = h[6] ?? 0
    let hh = h[7] ?? 0
    for (let j = 0; j < 64; j++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      // Each sum stays exact in a double (< 2^35) and `>>> 0` reduces mod 2^32.
      const temp1 = (hh + s1 + ch + (SHA256_K[j] ?? 0) + (w[j] ?? 0)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h[0] = ((h[0] ?? 0) + a) >>> 0
    h[1] = ((h[1] ?? 0) + b) >>> 0
    h[2] = ((h[2] ?? 0) + c) >>> 0
    h[3] = ((h[3] ?? 0) + d) >>> 0
    h[4] = ((h[4] ?? 0) + e) >>> 0
    h[5] = ((h[5] ?? 0) + f) >>> 0
    h[6] = ((h[6] ?? 0) + g) >>> 0
    h[7] = ((h[7] ?? 0) + hh) >>> 0
  }

  let out = ""
  for (const word of h) out += toHex8(word)
  return out
}
