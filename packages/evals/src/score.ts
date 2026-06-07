import type { Score } from "./types.js"

export interface NormalizedScore {
  readonly score: number
  readonly label?: string
  readonly reason?: string
}

function clamp01(n: number): number {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

export function normalizeScore(raw: Score): NormalizedScore {
  if (typeof raw === "boolean") return { score: raw ? 1 : 0 }
  if (typeof raw === "number") return { score: clamp01(raw) }
  if (raw === null || typeof raw !== "object") return { score: 0 }
  const out: NormalizedScore = { score: clamp01(raw.score) }
  return {
    ...out,
    ...(raw.label !== undefined ? { label: raw.label } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
  }
}
