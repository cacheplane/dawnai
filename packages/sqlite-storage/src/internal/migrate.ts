import type { DatabaseSync } from "node:sqlite"

export interface Migration {
  readonly version: number
  readonly up: string
}

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")
  const row = db.prepare("SELECT max(version) AS v FROM schema_version").get() as {
    v: number | null
  }
  const current = row?.v ?? 0
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  for (const m of sorted) {
    if (m.version <= current) continue
    db.exec("BEGIN")
    try {
      db.exec(m.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(m.version)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }
}
