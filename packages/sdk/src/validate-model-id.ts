import { CURATED_MODEL_IDS } from "./known-model-ids.js"
import { inferProvider } from "./model-provider.js"

export type ModelIdValidation =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly provider: string
      /** Nearest curated ids for the provider, closest first, max 3. */
      readonly suggestions: readonly string[]
    }

/**
 * Advisory check of a model id against the curated per-provider lists.
 * Silent (ok: true) for uncurated or unresolvable providers — the lists are
 * suggestions, not gates; consumers must warn, never hard-fail.
 */
export function validateModelId(opts: {
  readonly model: string
  readonly provider?: string
}): ModelIdValidation {
  const provider = opts.provider ?? inferProvider(opts.model)
  if (!provider) return { ok: true }

  const curated = (CURATED_MODEL_IDS as Readonly<Record<string, readonly string[] | undefined>>)[
    provider
  ]
  if (!curated) return { ok: true }
  if (curated.includes(opts.model)) return { ok: true }

  const suggestions = [...curated]
    .map((id) => ({ distance: levenshtein(opts.model, id), id }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((entry) => entry.id)

  return { ok: false, provider, suggestions }
}

function levenshtein(a: string, b: string): number {
  const cols = b.length + 1
  const dist: number[] = Array.from({ length: cols }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prevDiagonal = dist[0] ?? 0
    dist[0] = i
    for (let j = 1; j < cols; j++) {
      const previous = dist[j] ?? 0
      dist[j] = Math.min(
        previous + 1,
        (dist[j - 1] ?? 0) + 1,
        prevDiagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prevDiagonal = previous
    }
  }
  return dist[cols - 1] ?? 0
}
