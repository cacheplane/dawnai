// Pure recall scoring — no I/O, no clock, no randomness. Deterministic by
// construction so aimock fixtures and eval replays stay stable. See
// docs/superpowers/specs/2026-07-05-smarter-recall-design.md.

export interface RecallWeights {
  readonly relevance?: number
  readonly recency?: number
  readonly confidence?: number
}

export interface RecallRankingOptions {
  readonly weights?: RecallWeights
  readonly recencyHalfLifeMs?: number
  readonly candidatePool?: number
}

export const DEFAULT_RECALL_WEIGHTS = {
  relevance: 0.6,
  recency: 0.3,
  confidence: 0.1,
} as const

export const DEFAULT_RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
export const DEFAULT_CANDIDATE_POOL = 256

/**
 * BM25-smoothed inverse document frequency. Always positive — a token present
 * in every memory (df = corpusSize) still carries a small weight rather than
 * zeroing out or going negative (as unsmoothed idf would).
 */
export function idf(df: number, corpusSize: number): number {
  const d = Math.max(0, df)
  const n = Math.max(d, corpusSize)
  return Math.log(1 + (n - d + 0.5) / (d + 0.5))
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0
}

/** Parse an ISO timestamp; NaN (invalid/missing) degrades to null, never throws. */
function parseMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Composite recall score: wRel·relevance + wRec·recency + wConf·confidence.
 *
 * relevance = Σ idf(matched query tokens) / Σ idf(all query tokens) — the
 * fraction of the query's information this memory matches (0..1). Query
 * tokens matching nothing inflate only the shared denominator, so relative
 * ordering is unaffected.
 *
 * recency = 2^(−age / halfLife), age measured from `referenceNow` back to
 * `updatedAt`, clamped ≥ 0. Invalid timestamps degrade to age 0.
 *
 * `queryTokens` are expected to be deduplicated, as produced by `tokenize()`.
 */
export function scoreMemory(args: {
  readonly memoryTokens: ReadonlySet<string>
  readonly queryTokens: readonly string[]
  readonly dfByToken: ReadonlyMap<string, number>
  readonly corpusSize: number
  readonly updatedAt: string
  readonly confidence: number
  readonly referenceNow: string
  readonly options?: RecallRankingOptions
}): number {
  const weights = { ...DEFAULT_RECALL_WEIGHTS, ...args.options?.weights }
  const rawHalfLife = args.options?.recencyHalfLifeMs
  const halfLife =
    typeof rawHalfLife === "number" && Number.isFinite(rawHalfLife) && rawHalfLife > 0
      ? rawHalfLife
      : DEFAULT_RECENCY_HALF_LIFE_MS

  let matchedIdf = 0
  let totalIdf = 0
  for (const t of args.queryTokens) {
    const w = idf(args.dfByToken.get(t) ?? 0, args.corpusSize)
    totalIdf += w
    if (args.memoryTokens.has(t)) matchedIdf += w
  }
  const relevance = totalIdf > 0 ? matchedIdf / totalIdf : 0

  const ref = parseMs(args.referenceNow)
  const upd = parseMs(args.updatedAt)
  const ageMs = ref !== null && upd !== null ? Math.max(0, ref - upd) : 0
  const recency = 2 ** (-ageMs / halfLife)

  const confidence = clamp01(args.confidence)

  return weights.relevance * relevance + weights.recency * recency + weights.confidence * confidence
}
