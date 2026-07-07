import type { Embedder } from "@dawn-ai/core"

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Deterministic, network-free embedder for tests: a normalized bag-of-token-hash
 * vector, so strings sharing tokens are nearer in cosine. NOT for production.
 */
export function fakeEmbedder(opts?: { readonly dims?: number }): Embedder {
  const dims = opts?.dims ?? 64
  return {
    id: `fake:${dims}`,
    dims,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dims)
        for (const tok of t
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((x) => x.length > 1)) {
          const idx = hash(tok) % dims
          v[idx] = (v[idx] as number) + 1
        }
        let n = 0
        for (const x of v) n += x * x
        n = Math.sqrt(n) || 1
        for (let i = 0; i < dims; i++) v[i] = (v[i] as number) / n
        return v
      })
    },
  }
}
