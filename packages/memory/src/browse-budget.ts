/**
 * The §11 server budgets of the server-controlled-exploration design, as data, plus the
 * comparison the bench and its test share. Deliberately NOT exported from `index.ts` or
 * `browse.ts`: this is bench vocabulary, not part of the package's public surface.
 */
export type BrowseBudgetId =
  | "windowed-fetch"
  | "filtered-count"
  | "head-refresh"
  | "non-default-sort"
  | "content-contains"

/** Ceilings approved for SQLite at 100 000 rows. Every one is grounded in a §5.5
 *  measurement; the margin covers real payload decode. */
export const SQLITE_BROWSE_BUDGETS_MS: Readonly<Partial<Record<BrowseBudgetId, number>>> = {
  "windowed-fetch": 10,
  "filtered-count": 25,
  "head-refresh": 50,
  "non-default-sort": 50,
  "content-contains": 150,
}

/** Postgres. §11 approves only two numbers, and BOTH are estimates — no container bench
 *  has ever run. The other three shapes stay deliberately absent so the checker reports
 *  them as unbudgeted rather than inventing a ceiling. */
export const POSTGRES_BROWSE_BUDGETS_MS: Readonly<Partial<Record<BrowseBudgetId, number>>> = {
  "windowed-fetch": 30,
  "filtered-count": 100,
}

/** Nearest-rank p95. With 20 samples that is the 19th — no interpolation, so the number
 *  reported is a measurement that actually happened. */
export function percentileMs(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return Number.NaN
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1] as number
}

export interface BrowseBudgetRow {
  readonly id: BrowseBudgetId
  readonly p95Ms: number
  readonly budgetMs: number | null
  readonly status: "pass" | "fail" | "unbudgeted"
}

export interface BrowseBudgetReport {
  readonly rows: readonly BrowseBudgetRow[]
  readonly ok: boolean
}

export function checkBrowseBudgets(
  measurements: Readonly<Partial<Record<BrowseBudgetId, readonly number[]>>>,
  budgets: Readonly<Partial<Record<BrowseBudgetId, number>>>,
): BrowseBudgetReport {
  const rows: BrowseBudgetRow[] = []
  for (const [id, samples] of Object.entries(measurements) as [
    BrowseBudgetId,
    readonly number[],
  ][]) {
    const p95Ms = percentileMs(samples, 0.95)
    const budgetMs = budgets[id] ?? null
    rows.push({
      id,
      p95Ms,
      budgetMs,
      status: budgetMs === null ? "unbudgeted" : p95Ms <= budgetMs ? "pass" : "fail",
    })
  }
  return { rows, ok: rows.every((row) => row.status !== "fail") }
}

export function formatBrowseBudgetReport(report: BrowseBudgetReport): string {
  return report.rows
    .map(
      (row) =>
        `${row.id.padEnd(20)} p95 ${row.p95Ms.toFixed(2).padStart(8)} ms  ` +
        `budget ${(row.budgetMs === null ? "—" : `${row.budgetMs} ms`).padStart(8)}  ${row.status}`,
    )
    .join("\n")
}
