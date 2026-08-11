import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { sqliteMemoryStore } from "../src/index.js"

const dirs: string[] = []
function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-idx-"))
  dirs.push(dir)
  return join(dir, "m.sqlite")
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function inspect(path: string) {
  const db = new DatabaseSync(path)
  try {
    // Existence, not max(version): a max() reads the HEAD version, so every future
    // migration would move an assertion whose only subject is "did v4 run".
    const applied =
      db.prepare("SELECT 1 AS ok FROM schema_version WHERE version = 4").get() !== undefined
    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_mem_updated_id'")
      .get() as { sql: string } | undefined
    return { appliedV4: applied, indexSql: index?.sql }
  } finally {
    db.close()
  }
}

describe("browse ordering index", () => {
  it("migration v4 creates (updated_at DESC, id ASC)", () => {
    const path = dbPath()
    sqliteMemoryStore({ path })
    const { appliedV4, indexSql } = inspect(path)
    expect(appliedV4).toBe(true)
    // Directions must be IN the DDL: a plain-ASC composite scanned backwards gives
    // the wrong tie-break direction, which silently breaks keyset paging.
    expect(indexSql).toContain("updated_at DESC")
    expect(indexSql).toContain("id ASC")
  })

  it("applies to an existing database that predates it, and is idempotent", () => {
    const path = dbPath()
    sqliteMemoryStore({ path })
    // Both halves of the rewind carry weight: the version rows are what gate a re-run,
    // and an index left in place would let `IF NOT EXISTS` mask a migration that
    // never fired. `>= 4`, not `= 4`, because runMigrations gates on max(version) —
    // any later row left behind holds the high-water mark past 4 and skips it.
    const db = new DatabaseSync(path)
    db.exec("DROP INDEX idx_mem_updated_id")
    db.exec("DELETE FROM schema_version WHERE version >= 4")
    db.close()
    const rewound = inspect(path)
    expect(rewound.appliedV4).toBe(false)
    expect(rewound.indexSql).toBeUndefined()

    sqliteMemoryStore({ path })
    const reapplied = inspect(path)
    expect(reapplied.appliedV4).toBe(true)
    expect(reapplied.indexSql).toContain("updated_at DESC")

    sqliteMemoryStore({ path })
    const reopened = inspect(path)
    expect(reopened.appliedV4).toBe(true)
    expect(reopened.indexSql).toContain("updated_at DESC")
  })
})
