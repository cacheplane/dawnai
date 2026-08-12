// Measures the five §11 SERVER budgets against a seeded store and reports pass/fail.
//
//   pnpm --filter @dawn-ai/memory build
//   node packages/memory/bench/browse-budgets.mts [rowCount] [--assert]
//
// Companion to browse-plans.mts, which prints QUERY PLANS. This one prints TIMINGS
// against approved ceilings, and with --assert exits non-zero on a miss. Timings move
// with machine load; a miss on a loaded machine is a re-run, not a finding.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  type BrowseBudgetId,
  checkBrowseBudgets,
  formatBrowseBudgetReport,
  SQLITE_BROWSE_BUDGETS_MS,
} from "../dist/browse-budget.js"
import { sqliteMemoryStore } from "../dist/index.js"

const args = process.argv.slice(2)
const assertBudgets = args.includes("--assert")
const rowCount = Number(args.find((arg) => !arg.startsWith("--")) ?? 100_000)
if (!Number.isInteger(rowCount) || rowCount < 1) {
  throw new Error(`rowCount must be a positive integer, got ${JSON.stringify(args[0])}`)
}
/** 20 samples so nearest-rank p95 is the 19th — a real observation, not an interpolation. */
const SAMPLES = 20
/** The design's resident cap, which is also the maximum request limit: one head refresh
 *  covers the whole resident span, which is what makes convergence arithmetic. */
const RESIDENT_CAP = 1_000

const dir = mkdtempSync(join(tmpdir(), "dawn-budget-"))
const path = join(dir, "bench.sqlite")

function seed(): void {
  const db = new DatabaseSync(path)
  const insert = db.prepare(
    `INSERT INTO memories
       (id,kind,namespace,content,data,source,confidence,tags,status,supersedes,created_at,updated_at,effective_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,NULL)`,
  )
  const kinds = ["semantic", "episodic", "procedural", "reflection"]
  const statuses = ["candidate", "active", "superseded"]
  db.exec("BEGIN")
  for (let i = 0; i < rowCount; i += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()
    insert.run(
      `r${String(i).padStart(9, "0")}`,
      kinds[i % kinds.length] as string,
      `route=/ns${i % 500}`,
      i % 9973 === 0 ? `rare needle ${i}` : `common filler content ${i}`,
      "{}",
      '{"type":"eval","id":"bench"}',
      (i % 100) / 100,
      "[]",
      statuses[i % statuses.length] as string,
      stamp,
      stamp,
    )
  }
  db.exec("COMMIT")
  db.close()
}

async function sample(run: () => Promise<unknown>): Promise<number[]> {
  await run() // warm: the first call pays for statement preparation
  const timings: number[] = []
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now()
    await run()
    timings.push(performance.now() - started)
  }
  return timings
}

try {
  const store = sqliteMemoryStore({ path })
  seed()
  console.log(`rows: ${rowCount}, samples: ${SAMPLES}\n`)

  const measurements: Partial<Record<BrowseBudgetId, number[]>> = {}
  measurements["windowed-fetch"] = await sample(() => store.browse({ limit: 200 }))
  // A filtered window is rows + COUNT in one transaction; the COUNT is the shape §11
  // budgets separately, and this is the only way to exercise it through the store.
  measurements["filtered-count"] = await sample(() =>
    store.browse({ limit: 200, filters: [{ field: "status", op: "in", values: ["active"] }] }),
  )
  measurements["head-refresh"] = await sample(() => store.browse({ limit: RESIDENT_CAP }))
  measurements["non-default-sort"] = await sample(() =>
    store.browse({ limit: 200, orderBy: [{ field: "confidence", dir: "desc" }] }),
  )
  measurements["content-contains"] = await sample(() =>
    store.browse({
      limit: 200,
      filters: [{ field: "content", op: "contains", value: "rare needle 9973" }],
    }),
  )

  const report = checkBrowseBudgets(measurements, SQLITE_BROWSE_BUDGETS_MS)
  console.log(formatBrowseBudgetReport(report))
  if (assertBudgets && !report.ok) {
    console.error("\nAt least one shape missed its approved ceiling.")
    process.exitCode = 1
  }
} finally {
  // MemoryStore exposes no close(), so the connection is still open here. POSIX unlinks
  // open files; Windows refuses, and that must not throw over the results.
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.log(`\ncould not remove ${dir}: ${(err as Error).message}`)
  }
}
