import { openDb } from "../internal/db.js"
import { runMigrations } from "../internal/migrate.js"
import { THREADS_MIGRATIONS } from "./schema.js"
import { makeThreadsStore } from "./store.js"

export interface ThreadsStoreOptions {
  readonly path: string
}

export function createThreadsStore(options: ThreadsStoreOptions) {
  const db = openDb(options.path)
  runMigrations(db, THREADS_MIGRATIONS)
  return makeThreadsStore(db)
}

export type { CreateThreadInput, Thread, ThreadStatus, ThreadsStore } from "./store.js"
