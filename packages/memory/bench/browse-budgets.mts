// Measures the five §11 SERVER budgets against a seeded store and reports pass/fail.
//
//   pnpm --filter @dawn-ai/memory bench:budgets -- [rowCount] [--assert]
//
// It reads the COMPILED ceilings, so it must be built first — that is why the package
// script builds and this file is not meant to be run bare. Node 24+ only (native .mts);
// older Node dies at load with ERR_UNKNOWN_FILE_EXTENSION and exit 1, the same code
// --assert uses for a real miss.
//
// Companion to browse-plans.mts, which prints QUERY PLANS. This one prints TIMINGS
// against approved ceilings, and with --assert exits non-zero on a miss. Timings move
// with machine load; a miss on a loaded machine is a re-run, not a finding, which is why
// the header line records the load the run happened under.
import { mkdtempSync, rmSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
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
const rowCountArg = args.find((arg) => !arg.startsWith("--"))
const rowCount = Number(rowCountArg ?? 100_000)
if (!Number.isInteger(rowCount) || rowCount < 1) {
  throw new Error(`rowCount must be a positive integer, got ${JSON.stringify(rowCountArg)}`)
}
/** 20 samples so nearest-rank p95 is the 19th — a real observation, not an interpolation. */
const SAMPLES = 20
/** The design's resident cap, which is also the maximum request limit: one head refresh
 *  covers the whole resident span, which is what makes convergence arithmetic. Duplicated
 *  from BROWSE_RESIDENT_CAP in @dawn-ai/inspector (browse/browse-machine.ts), which this
 *  package cannot import; if that moves, this bench certifies a span that no longer exists. */
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

interface Shape {
  readonly id: BrowseBudgetId
  readonly run: () => Promise<unknown>
}

/**
 * Round-robin, one sample of every shape per iteration, rather than 20 back-to-back per
 * shape. Nearest-rank p95 over 20 samples discards only the single worst, so a stall that
 * spans two consecutive samples blows that shape's p95 outright. Interleaved, the same
 * stall costs each shape one sample instead of charging all of it to whichever shape held
 * the CPU — and if it is long enough to matter, every row moves together, which reads as
 * the machine load it is.
 */
async function measure(
  shapes: readonly Shape[],
): Promise<Partial<Record<BrowseBudgetId, number[]>>> {
  const timings: Partial<Record<BrowseBudgetId, number[]>> = {}
  for (const shape of shapes) {
    timings[shape.id] = []
    await shape.run() // warm: the first call pays for statement preparation
  }
  for (let i = 0; i < SAMPLES; i += 1) {
    for (const shape of shapes) {
      const started = performance.now()
      await shape.run()
      timings[shape.id]?.push(performance.now() - started)
    }
  }
  return timings
}

try {
  // Constructing the store runs the migrations, so it must precede seed(): the INSERT
  // below prepares against a table that does not exist yet otherwise.
  const store = sqliteMemoryStore({ path })
  seed()
  console.log(`rows: ${rowCount}, samples: ${SAMPLES}, load: ${(loadavg()[0] ?? 0).toFixed(2)}\n`)

  const measurements = await measure([
    { id: "windowed-fetch", run: () => store.browse({ limit: 200 }) },
    // A filtered window is rows + COUNT in one transaction; the COUNT is the shape §11
    // budgets separately, and this is the only way to exercise it through the store.
    {
      id: "filtered-count",
      run: () =>
        store.browse({ limit: 200, filters: [{ field: "status", op: "in", values: ["active"] }] }),
    },
    { id: "head-refresh", run: () => store.browse({ limit: RESIDENT_CAP }) },
    {
      id: "non-default-sort",
      run: () => store.browse({ limit: 200, orderBy: [{ field: "confidence", dir: "desc" }] }),
    },
    {
      // 49865 is a multiple of the seed's 9973 whose decimal is a prefix of no other row's
      // (498650 is past 100k), so the needle really does match one row.
      id: "content-contains",
      run: () =>
        store.browse({
          limit: 200,
          filters: [{ field: "content", op: "contains", value: "rare needle 49865" }],
        }),
    },
  ])

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
