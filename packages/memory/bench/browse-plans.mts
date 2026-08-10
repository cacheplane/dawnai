// Reproducible baselines for §5.5 of the server-controlled-exploration design. That
// document lives in the cacheplane/pretable repo, NOT here:
// docs/superpowers/specs/2026-08-09-server-controlled-exploration-design.md.
//
// pnpm --filter @dawn-ai/memory build
// node packages/memory/bench/browse-plans.mts [rowCount]
//
// Seeds rows with a direct bulk insert (the store's put() also tokenizes, which is
// irrelevant here and 50x slower), then times the query shapes the design measured and
// prints the SQLite plans that prove which index each one rides.
//
// Every timing is a WHOLE browse() call — window + COUNT(*) in one transaction, plus
// JSON decode of 200 records — EXCEPT the two indented `statement` rows. §5.5's figures
// are per-statement, so those two are the only ones that compare with its table
// directly. All of them move with machine load (a busy machine doubles them), so the
// PLAN lines below, not the milliseconds, are the stable evidence about indexes.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { sqliteMemoryStore } from "../dist/index.js"

const rowCount = Number(process.argv[2] ?? 100_000)
// Checked before the temp dir exists, so a typo cannot leave one behind: `abc` used to
// seed NaN rows and then fail four statements later on a null cursor.
if (!Number.isInteger(rowCount) || rowCount < 1) {
  throw new Error(`rowCount must be a positive integer, got ${JSON.stringify(process.argv[2])}`)
}
const dir = mkdtempSync(join(tmpdir(), "dawn-bench-"))
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

async function time(label: string, run: () => Promise<unknown>): Promise<void> {
  await run() // warm
  const started = performance.now()
  for (let i = 0; i < 5; i += 1) await run()
  console.log(`${label.padEnd(44)} ${((performance.now() - started) / 5).toFixed(2)} ms`)
}

// One statement on its own connection, prepared once — the per-statement shape §5.5's
// table reports, without browse()'s transaction, second statement and JSON decode.
function timeSql(label: string, sql: string, params: string[]): void {
  const db = new DatabaseSync(path)
  try {
    const statement = db.prepare(sql)
    statement.all(...params) // warm
    const started = performance.now()
    for (let i = 0; i < 5; i += 1) statement.all(...params)
    console.log(`${label.padEnd(44)} ${((performance.now() - started) / 5).toFixed(2)} ms`)
  } finally {
    db.close()
  }
}

function plan(label: string, sql: string, params: string[]): void {
  const db = new DatabaseSync(path)
  try {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
    console.log(`${label.padEnd(44)} ${rows.map((r) => r.detail).join(" | ")}`)
  } finally {
    db.close()
  }
}

// The two statements browse({ limit: 200 }) issues, verbatim — copied, not derived, so
// the plan printed below is the plan the store gets. The column list is the store's
// (everything rowToRecord reads, minus the embedding BLOB).
const windowSql = `SELECT id, kind, namespace, content, data, source, confidence, tags, status,
        supersedes, created_at, updated_at, effective_at, expires_at
 FROM memories ORDER BY updated_at DESC, id ASC LIMIT 200`
const countSql = "SELECT COUNT(*) AS n FROM memories"

try {
  const store = sqliteMemoryStore({ path })
  seed()
  console.log(`rows: ${rowCount}\n`)

  const first = await store.browse({ limit: 200 })
  await time("default order, limit 200", () => store.browse({ limit: 200 }))
  // The decomposition of the row above. §5.5 budgets 0.54 ms for the window statement
  // and reports the COUNT separately; the browse() figure is their sum plus decode, so
  // reading it against 0.54 ms alone looks like a 3x miss and is not one.
  timeSql("  window statement (§5.5: 0.54 ms)", windowSql, [])
  timeSql("  unfiltered COUNT(*) statement", countSql, [])
  // Hoisted so the narrowing survives into the closure. Null below one full window:
  // browse() only issues a continuation when the window FILLED.
  const cursor = first.continuation
  if (cursor) {
    await time("keyset continuation, limit 200", () => store.browse({ limit: 200, cursor }))
  } else {
    console.log(`${"keyset continuation, limit 200".padEnd(44)} skipped (< 200 rows)`)
  }
  await time("status IN + default order", () =>
    store.browse({ limit: 200, filters: [{ field: "status", op: "in", values: ["active"] }] }),
  )
  await time("non-default sort (confidence DESC)", () =>
    store.browse({ limit: 200, orderBy: [{ field: "confidence", dir: "desc" }] }),
  )
  await time("content contains, rare term", () =>
    store.browse({
      limit: 200,
      filters: [{ field: "content", op: "contains", value: "rare needle 9973" }],
    }),
  )
  // Both arms SEARCH the namespace-leading index, so both are sargable; neither can
  // also satisfy the ORDER BY, so both sort in a temp b-tree whose cost tracks the
  // MATCHED row count. §5.5's 0.63 ms is the selective arm — reading the broad one
  // against it looks like a lost index and is not.
  await time("namespace prefix as byte range, broad", () =>
    store.browse({ limit: 200, namespacePrefix: "route=/ns1" }),
  )
  await time("namespace prefix as byte range, selective", () =>
    store.browse({ limit: 200, namespacePrefix: "route=/ns123" }),
  )
  await time("namespace exact", () => store.browse({ limit: 200, namespace: "route=/ns1" }))

  console.log("")
  // The tripwire §5.5 actually rests on. `SCAN … USING INDEX idx_mem_updated_id` is the
  // HEALTHY reading: an ordered traversal of the index that LIMIT exits early, which is
  // why the timing is flat from 100k to 1M. `USE TEMP B-TREE FOR ORDER BY` here means
  // the index is gone or unusable — repair `idx_mem_updated_id` before trusting any
  // number above, because every timing here would then be measuring a sort.
  plan("default order window", windowSql, [])
  const stamp = "2026-01-02T00:00:00.000Z"
  plan(
    "keyset WITH the leading guard",
    "SELECT id FROM memories WHERE updated_at <= ? AND (updated_at < ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at DESC, id ASC LIMIT 200",
    [stamp, stamp, stamp, "r000000001"],
  )
  plan(
    "keyset WITHOUT the leading guard",
    "SELECT id FROM memories WHERE (updated_at < ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at DESC, id ASC LIMIT 200",
    [stamp, stamp, "r000000001"],
  )
} finally {
  // The store's connection (and its -wal/-shm) is still open here: MemoryStore exposes
  // no close(), and sqliteMemoryStore keeps its DatabaseSync private, so there is
  // nothing to close from out here. POSIX unlinks open files; Windows refuses, so this
  // must not be allowed to throw over the results that were just printed.
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.log(`\ncould not remove ${dir}: ${(err as Error).message}`)
  }
}
