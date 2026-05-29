import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { runMigrations } from "../src/internal/migrate.js"

function memDb(): DatabaseSync {
  return new DatabaseSync(":memory:")
}

describe("runMigrations", () => {
  it("creates schema_version table and applies all migrations on fresh db", () => {
    const db = memDb()
    runMigrations(db, [
      { version: 1, up: "CREATE TABLE t1(id INTEGER)" },
      { version: 2, up: "CREATE TABLE t2(id INTEGER)" },
    ])
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(["schema_version", "t1", "t2"])
    const v = db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number }
    expect(v.v).toBe(2)
  })

  it("skips migrations already applied", () => {
    const db = memDb()
    runMigrations(db, [{ version: 1, up: "CREATE TABLE t1(id INTEGER)" }])
    runMigrations(db, [
      { version: 1, up: "CREATE TABLE t1(id INTEGER)" },
      { version: 2, up: "CREATE TABLE t2(id INTEGER)" },
    ])
    const v = db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number }
    expect(v.v).toBe(2)
  })
})
