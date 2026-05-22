import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type Db = DatabaseSync

export function openDb(path: string): Db {
  const isMemory = path === ":memory:"
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL")
  }
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA synchronous = NORMAL")
  return db
}
