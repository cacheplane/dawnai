import type { Migration } from "../internal/migrate.js"

export const THREADS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'idle'
      );
      CREATE INDEX idx_threads_updated ON threads(updated_at DESC);
    `,
  },
]
