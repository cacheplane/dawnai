import type { Score } from "./types.js"

export interface NormalizedScore {
  readonly score: number
  readonly label?: string
  readonly reason?: string
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

export function normalizeScore(raw: Score): NormalizedScore {
  if (typeof raw === "boolean") return { score: raw ? 1 : 0 }
  if (typeof raw === "number") return { score: clamp01(raw) }
  const out: NormalizedScore = { score: clamp01(raw.score) }
  return {
    ...out,
    ...(raw.label !== undefined ? { label: raw.label } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
  }
}
