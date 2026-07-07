// Pure, backend-agnostic hybrid ranking core. Both sqliteMemoryStore and
// @dawn-ai/memory-pgvector call these after doing their own retrieval, so recall
// ranking is byte-identical across backends. No I/O, no clock, no randomness.
import {
  type RecallRankingOptions,
  type RecallWeights,
  recencyDecay,
  scoreMemory,
} from "./score.js"
import { tokenize } from "./tokenize.js"
import type { MemoryRecord, VectorRankingOptions } from "./types.js"
import { fuseRRF } from "./vector.js"

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
function newestUpdatedAt(records: readonly MemoryRecord[]): string {
  return records.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), "")
}
function tokensFor(rec: MemoryRecord, tk: (s: string) => string[]): string[] {
  const values = Object.values(rec.data).filter((v) => typeof v === "string") as string[]
  return tk([rec.content, rec.tags.join(" "), values.join(" ")].join(" "))
}

/**
 * Rank keyword candidates by IDF relevance (+ recency/confidence per weights).
 * `candidates` are the rows the store retrieved as matching ≥1 query token;
 * `dfByToken`/`corpusSize` are the store's live stats. Returns the full sorted
 * list (caller pages + tag-filters). `now` absent → newest candidate's updatedAt.
 * `tokenize` defaults to the shared `tokenize()` — callers pass their own only if
 * they index tokens differently (both stores pass the imported `tokenize`).
 */
export function rankKeywordCandidates(
  candidates: readonly MemoryRecord[],
  dfByToken: ReadonlyMap<string, number>,
  corpusSize: number,
  queryTokens: readonly string[],
  now: string | undefined,
  options?: RecallRankingOptions,
  tk: (s: string) => string[] = tokenize,
): MemoryRecord[] {
  if (candidates.length === 0) return []
  const referenceNow = now ?? newestUpdatedAt(candidates)
  const scored = candidates.map((record) => ({
    record,
    score: scoreMemory({
      memoryTokens: new Set(tokensFor(record, tk)),
      queryTokens: [...queryTokens],
      dfByToken,
      corpusSize,
      updatedAt: record.updatedAt,
      confidence: record.confidence,
      referenceNow,
      ...(options ? { options } : {}),
    }),
  }))
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      cmp(b.record.updatedAt, a.record.updatedAt) ||
      cmp(a.record.id, b.record.id),
  )
  return scored.map((s) => s.record)
}

function finite(n: unknown, d: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : d
}

/**
 * Fuse a keyword-ranked list and a vector-ranked list (already cosine-sorted and
 * sliced to vectorK by the store) via co-equal RRF, then a bounded recency/
 * confidence second stage. Returns the fused sorted records (caller pages +
 * tag-filters). `options.recencyHalfLifeMs` should be pre-resolved by the caller
 * (the pure fn cannot see recall config).
 */
export function fuseHybrid(args: {
  readonly keywordRanked: readonly MemoryRecord[]
  readonly vectorRanked: readonly MemoryRecord[]
  readonly now?: string | undefined
  readonly options?: VectorRankingOptions | undefined
}): MemoryRecord[] {
  const v = args.options ?? {}
  const wKeyword = finite(v.weights?.keyword, 1)
  const wVector = finite(v.weights?.vector, 1)
  const wRec = finite(v.recencyWeight, 0.3)
  const wConf = finite(v.confidenceWeight, 0.1)

  const byId = new Map<string, MemoryRecord>()
  for (const r of args.keywordRanked) byId.set(r.id, r)
  for (const r of args.vectorRanked) if (!byId.has(r.id)) byId.set(r.id, r)
  if (byId.size === 0) return []

  const rrf = fuseRRF(
    [
      { ids: args.keywordRanked.map((r) => r.id), weight: wKeyword },
      { ids: args.vectorRanked.map((r) => r.id), weight: wVector },
    ],
    typeof v.rrfK === "number" ? { k: v.rrfK } : undefined,
  )
  const referenceNow = args.now ?? newestUpdatedAt([...byId.values()])
  const fused = [...byId.values()].map((record) => {
    const base = rrf.get(record.id) ?? 0
    const rec = recencyDecay(record.updatedAt, referenceNow, v.recencyHalfLifeMs)
    const conf = record.confidence < 0 ? 0 : record.confidence > 1 ? 1 : record.confidence
    return { record, score: base * (1 + wRec * rec + wConf * conf) }
  })
  fused.sort(
    (a, b) =>
      b.score - a.score ||
      cmp(b.record.updatedAt, a.record.updatedAt) ||
      cmp(a.record.id, b.record.id),
  )
  return fused.map((s) => s.record)
}

export type { RecallWeights }
