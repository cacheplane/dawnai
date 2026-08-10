// Reproducible baselines for docs/superpowers/specs/2026-08-09-server-controlled-exploration-design.md §5.5.
//
// pnpm --filter @dawn-ai/memory build
// node packages/memory/bench/browse-plans.mts [rowCount]
//
// Seeds rows with a direct bulk insert (the store's put() also tokenizes, which is
// irrelevant here and 50x slower), then times the query shapes the design measured and
// prints the SQLite plan for the guarded vs unguarded keyset.
//
// Every timing is a WHOLE browse() call: window + COUNT(*) in one transaction, plus
// JSON decode of 200 records. §5.5's figures are per-statement, so these run higher
// (e.g. 1.4 ms here for a window whose SQL alone is 0.05 ms against a 0.54 ms count).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { sqliteMemoryStore } from "../dist/index.js"

const rowCount = Number(process.argv[2] ?? 100_000)
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

function plan(label: string, sql: string, params: string[]): void {
  const db = new DatabaseSync(path)
  try {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
    console.log(`${label.padEnd(44)} ${rows.map((r) => r.detail).join(" | ")}`)
  } finally {
    db.close()
  }
}

try {
  const store = sqliteMemoryStore({ path })
  seed()
  console.log(`rows: ${rowCount}\n`)

  const first = await store.browse({ limit: 200 })
  await time("default order, limit 200", () => store.browse({ limit: 200 }))
  await time("keyset continuation, limit 200", () =>
    store.browse({ limit: 200, cursor: first.continuation as string }),
  )
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
  rmSync(dir, { recursive: true, force: true })
}
