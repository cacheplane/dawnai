import { openDb } from "../internal/db.js"
import { runMigrations } from "../internal/migrate.js"
import { DawnSqliteSaver } from "./saver.js"
import { CHECKPOINTER_MIGRATIONS } from "./schema.js"

export interface SqliteCheckpointerOptions {
  readonly path: string
}

export function sqliteCheckpointer(options: SqliteCheckpointerOptions): DawnSqliteSaver {
  const db = openDb(options.path)
  runMigrations(db, CHECKPOINTER_MIGRATIONS)
  return new DawnSqliteSaver(db)
}

export { DawnSqliteSaver } from "./saver.js"
