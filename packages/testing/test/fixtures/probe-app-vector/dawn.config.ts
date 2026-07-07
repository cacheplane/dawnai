// Vector-enabled sibling of probe-app: same memory-chat route, but memory
// recall runs the hybrid keyword+vector path via a deterministic inline
// embedder. We define the embedder INLINE (rather than importing
// `fakeEmbedder` from @dawn-ai/testing) because this config is loaded from
// within the @dawn-ai/testing package's own test fixtures — importing the
// package from its own subtree is a self-referential resolution risk (testing
// does not symlink itself into node_modules). The inline embedder mirrors
// `fakeEmbedder` exactly: a normalized bag-of-token-hash vector, so strings
// sharing tokens are nearer in cosine.
const dims = 32

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const embedder = {
  id: "fake:e2e",
  dims,
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
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

export default { memory: { writes: "auto", vector: { embedder } } }
