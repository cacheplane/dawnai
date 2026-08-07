import { Pool } from "pg"
import type { PostgresStoreOptions } from "./options.js"
import {
  assertIdentifier,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  qualify,
  runMigrations,
  THREADS_MIGRATIONS,
} from "./schema.js"

export type ThreadStatus = "idle" | "busy" | "interrupted"

export interface Thread {
  readonly thread_id: string
  readonly created_at: string
  readonly updated_at: string
  readonly metadata: Record<string, unknown>
  readonly status: ThreadStatus
}

export interface CreateThreadInput {
  readonly thread_id?: string
  readonly metadata?: Record<string, unknown>
}

/**
 * The threads contract, declared structurally here rather than imported from
 * `@dawn-ai/sqlite-storage`. Identical shape, so either store satisfies the
 * other's type — but this package's emitted `.d.ts` must not point published
 * consumers at a Node-only sqlite package to get its types.
 */
export interface ThreadsStore {
  createThread(input: CreateThreadInput): Promise<Thread>
  getThread(threadId: string): Promise<Thread | undefined>
  deleteThread(threadId: string): Promise<void>
  listThreads(): Promise<Thread[]>
  updateStatus(threadId: string, status: ThreadStatus): Promise<void>
  /**
   * Shallow-merge `patch` into the thread's existing metadata. No-op if the
   * thread does not exist.
   */
  updateMetadata(threadId: string, patch: Record<string, unknown>): Promise<void>
}

/** A threads store that also owns Postgres lifecycle. */
export interface PostgresThreadsStore extends ThreadsStore {
  /** Apply migrations. Idempotent and memoized; call at boot to migrate eagerly. */
  ready(): Promise<void>
  /** Close the underlying pool. No-op if an external pool was injected. */
  close(): Promise<void>
}

export type PostgresThreadsStoreOptions = PostgresStoreOptions

const COLUMNS = "thread_id, created_at, updated_at, metadata, status"

/** `metadata` arrives already parsed — `pg` decodes jsonb for us. */
interface ThreadRow {
  thread_id: string
  created_at: string
  updated_at: string
  metadata: Record<string, unknown> | null
  status: ThreadStatus
}

function rowToThread(row: ThreadRow): Thread {
  return {
    thread_id: row.thread_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata ?? {},
    status: row.status,
  }
}

/**
 * Web Crypto rather than `node:crypto`, so this module stays importable from an
 * edge entry point. Format matches the sqlite store's `t-` plus 8 hex digits.
 */
function newThreadId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return `t-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

/**
 * A Postgres-backed threads store.
 *
 * Postgres is a shared, multi-writer database and an edge deployment is
 * multi-instance by definition, so two of the sqlite store's single-writer
 * assumptions are corrected here: `createThread` upserts instead of throwing on
 * a duplicate (callers check-then-create, which races across instances), and
 * `updateMetadata` merges inside one statement instead of reading, merging in
 * JS and writing back (a lost update under concurrency).
 */
export function createPostgresThreadsStore(
  options: PostgresThreadsStoreOptions = {},
): PostgresThreadsStore {
  const schema = options.schema ?? DEFAULT_SCHEMA
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  const table = qualify({ schema, prefix }, "threads")
  const ownsPool = !options.pool
  const pool =
    options.pool ??
    new Pool(options.connectionString ? { connectionString: options.connectionString } : {})

  let initP: Promise<void> | undefined
  const ready = (): Promise<void> => {
    initP ??= runMigrations(pool, THREADS_MIGRATIONS, { schema, prefix, component: "threads" })
    return initP
  }

  const selectOne = async (threadId: string): Promise<Thread | undefined> => {
    const res = await pool.query<ThreadRow>(
      `SELECT ${COLUMNS} FROM ${table} WHERE thread_id = $1`,
      [threadId],
    )
    const row = res.rows[0]
    return row ? rowToThread(row) : undefined
  }

  return {
    ready,
    async close() {
      if (ownsPool) await pool.end()
    },

    async createThread(input) {
      await ready()
      const threadId = input.thread_id ?? newThreadId()
      const metadata = JSON.stringify(input.metadata ?? {})
      // Bounded retry: DO NOTHING yields no row when the id already exists, and
      // the follow-up SELECT can itself find nothing if another instance
      // deleted that thread in between. Re-inserting is the only way to settle.
      for (let attempt = 0; attempt < 3; attempt++) {
        const now = new Date().toISOString()
        const inserted = await pool.query<ThreadRow>(
          `INSERT INTO ${table} (thread_id, created_at, updated_at, metadata, status)
           VALUES ($1, $2, $2, $3::jsonb, 'idle')
           ON CONFLICT (thread_id) DO NOTHING
           RETURNING ${COLUMNS}`,
          [threadId, now, metadata],
        )
        const row = inserted.rows[0]
        if (row) return rowToThread(row)
        const existing = await selectOne(threadId)
        if (existing) return existing
      }
      throw new Error(
        `[postgres-storage] createThread could not settle for ${JSON.stringify(threadId)}`,
      )
    },

    async getThread(threadId) {
      await ready()
      return selectOne(threadId)
    },

    async deleteThread(threadId) {
      await ready()
      await pool.query(`DELETE FROM ${table} WHERE thread_id = $1`, [threadId])
    },

    async listThreads() {
      await ready()
      // COLLATE "C" is byte ordering; the database's own collation is
      // locale-sensitive and could reorder equal-looking ISO timestamps.
      const res = await pool.query<ThreadRow>(
        `SELECT ${COLUMNS} FROM ${table} ORDER BY updated_at COLLATE "C" DESC`,
      )
      return res.rows.map(rowToThread)
    },

    async updateStatus(threadId, status) {
      await ready()
      await pool.query(`UPDATE ${table} SET status = $1, updated_at = $2 WHERE thread_id = $3`, [
        status,
        new Date().toISOString(),
        threadId,
      ])
    },

    async updateMetadata(threadId, patch) {
      await ready()
      // `||` on jsonb is a shallow merge — a nested object is replaced wholesale,
      // matching the sqlite store's object spread. Doing it in one statement
      // means a concurrent patch from another instance cannot be lost.
      await pool.query(
        `UPDATE ${table} SET metadata = metadata || $1::jsonb, updated_at = $2
         WHERE thread_id = $3`,
        [JSON.stringify(patch), new Date().toISOString(), threadId],
      )
    },
  }
}
