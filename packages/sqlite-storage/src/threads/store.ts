import { randomBytes } from "node:crypto"
import type { Db } from "../internal/db.js"

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

export interface ThreadsStore {
  createThread(input: CreateThreadInput): Promise<Thread>
  getThread(threadId: string): Promise<Thread | undefined>
  deleteThread(threadId: string): Promise<void>
  listThreads(): Promise<Thread[]>
  updateStatus(threadId: string, status: ThreadStatus): Promise<void>
  /**
   * Shallow-merge `patch` into the thread's existing metadata. No-op if the
   * thread does not exist. Used to persist durable per-thread runtime facts
   * (e.g. the last route key) so they survive a server restart.
   */
  updateMetadata(threadId: string, patch: Record<string, unknown>): Promise<void>
}

interface ThreadRow {
  thread_id: string
  created_at: string
  updated_at: string
  metadata: string
  status: ThreadStatus
}

function rowToThread(row: ThreadRow): Thread {
  return {
    thread_id: row.thread_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    status: row.status,
  }
}

function newThreadId(): string {
  return `t-${randomBytes(4).toString("hex")}`
}

export function makeThreadsStore(db: Db): ThreadsStore {
  return {
    async createThread(input) {
      const now = new Date().toISOString()
      const threadId = input.thread_id ?? newThreadId()
      const metadata = JSON.stringify(input.metadata ?? {})
      db.prepare(
        "INSERT INTO threads(thread_id, created_at, updated_at, metadata, status) VALUES (?, ?, ?, ?, 'idle')",
      ).run(threadId, now, now, metadata)
      return {
        thread_id: threadId,
        created_at: now,
        updated_at: now,
        metadata: input.metadata ?? {},
        status: "idle",
      }
    },
    async getThread(threadId) {
      const row = db
        .prepare(
          "SELECT thread_id, created_at, updated_at, metadata, status FROM threads WHERE thread_id = ?",
        )
        .get(threadId) as unknown as ThreadRow | undefined
      return row ? rowToThread(row) : undefined
    },
    async deleteThread(threadId) {
      db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId)
    },
    async listThreads() {
      const rows = db
        .prepare(
          "SELECT thread_id, created_at, updated_at, metadata, status FROM threads ORDER BY updated_at DESC",
        )
        .all() as unknown as ThreadRow[]
      return rows.map(rowToThread)
    },
    async updateStatus(threadId, status) {
      const now = new Date().toISOString()
      db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE thread_id = ?").run(
        status,
        now,
        threadId,
      )
    },
    async updateMetadata(threadId, patch) {
      const row = db
        .prepare("SELECT metadata FROM threads WHERE thread_id = ?")
        .get(threadId) as unknown as { metadata: string } | undefined
      if (!row) return
      const current = JSON.parse(row.metadata) as Record<string, unknown>
      const merged = JSON.stringify({ ...current, ...patch })
      const now = new Date().toISOString()
      db.prepare("UPDATE threads SET metadata = ?, updated_at = ? WHERE thread_id = ?").run(
        merged,
        now,
        threadId,
      )
    },
  }
}
