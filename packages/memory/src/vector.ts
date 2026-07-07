// Pure vector-recall primitives — no I/O, no clock, no randomness. Deterministic
// so aimock fixtures and eval replays stay stable. See
// docs/superpowers/specs/2026-07-06-vector-recall-design.md.

export const DEFAULT_RRF_K = 60
export const DEFAULT_VECTOR_K = 64

export interface RankedList {
  /**
   * Ids ordered best → worst. Rank is the 1-based index. Ids within a single
   * list are expected to be unique; duplicates accumulate score.
   */
  readonly ids: readonly string[]
  /** Per-list weight in the fusion; default 1 (co-equal). */
  readonly weight?: number
}

/** Raw cosine similarity in [-1, 1]. Zero-norm, length-mismatch, or non-finite result → 0 (never NaN/throw). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  const r = dot / (Math.sqrt(na) * Math.sqrt(nb))
  return Number.isFinite(r) ? r : 0
}

/**
 * Reciprocal Rank Fusion. score(id) = Σ_lists weight / (k + rank). An id absent
 * from a list contributes 0 (RRF subsumes the union of the lists). Rank-based, so
 * it is immune to the score-scale incompatibility between IDF and cosine.
 */
export function fuseRRF(
  lists: readonly RankedList[],
  opts?: { readonly k?: number },
): Map<string, number> {
  const rawK = opts?.k
  const k = typeof rawK === "number" && Number.isFinite(rawK) && rawK > 0 ? rawK : DEFAULT_RRF_K
  const out = new Map<string, number>()
  for (const list of lists) {
    const w = typeof list.weight === "number" && Number.isFinite(list.weight) ? list.weight : 1
    for (let i = 0; i < list.ids.length; i++) {
      const id = list.ids[i] as string
      out.set(id, (out.get(id) ?? 0) + w / (k + (i + 1)))
    }
  }
  return out
}
