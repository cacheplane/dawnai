import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDb } from "../src/internal/db.js"

describe("openDb", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-sqlite-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("opens a database with WAL journal_mode, foreign_keys ON, and synchronous=NORMAL", () => {
    const db = openDb(join(dir, "test.sqlite"))
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number }
    expect(journal.journal_mode).toBe("wal")
    expect(fk.foreign_keys).toBe(1)
    expect(sync.synchronous).toBe(1)
    db.close()
  })

  it("creates parent directory if missing", () => {
    const path = join(dir, "nested", "deep", "test.sqlite")
    const db = openDb(path)
    expect(db).toBeDefined()
    db.close()
  })
})
