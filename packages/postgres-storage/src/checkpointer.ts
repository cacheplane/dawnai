import type { RunnableConfig } from "@langchain/core/runnables"
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint"
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { withTransaction } from "./internal/tx.js"
import type { PostgresStoreOptions } from "./options.js"
import {
  assertIdentifier,
  CHECKPOINTER_MIGRATIONS,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  qualify,
  runMigrations,
} from "./schema.js"
import { type SqlPool, throwNoPool } from "./sql.js"

const CHECKPOINT_COLUMNS =
  "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata"

type CheckpointRow = {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  type: string | null
  checkpoint: Uint8Array
  metadata: Uint8Array
}

type WriteRow = {
  checkpoint_id: string
  task_id: string
  channel: string
  type: string | null
  value: Uint8Array | null
}

/**
 * Serializer protocol — matches the shape of BaseCheckpointSaver.serde
 * (JsonPlusSerializer) without importing the private type.
 */
interface Serde {
  dumpsTyped(data: unknown): Promise<[string, Uint8Array]>
  loadsTyped(type: string, data: Uint8Array | string): Promise<unknown>
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key) =>
      Object.hasOwn(b as Record<string, unknown>, key) &&
      structurallyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

/** Shallow metadata match: every filter key must equal the stored value. */
function matchesFilter(metadata: unknown, filter: Record<string, unknown>): boolean {
  if (typeof metadata !== "object" || metadata === null) return false
  const record = metadata as Record<string, unknown>
  return Object.entries(filter).every(([key, value]) => structurallyEqual(record[key], value))
}

async function buildTuple(
  row: CheckpointRow,
  writes: readonly WriteRow[],
  serde: Serde,
): Promise<CheckpointTuple> {
  const checkpoint = (await serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint
  const metadata = (await serde.loadsTyped("json", row.metadata)) as CheckpointMetadata
  const pendingWrites: [string, string, unknown][] = await Promise.all(
    writes.map(
      async (w) =>
        [
          w.task_id,
          w.channel,
          w.value != null ? await serde.loadsTyped(w.type ?? "json", w.value) : null,
        ] as [string, string, unknown],
    ),
  )

  const config: RunnableConfig = {
    configurable: {
      thread_id: row.thread_id,
      checkpoint_ns: row.checkpoint_ns,
      checkpoint_id: row.checkpoint_id,
    },
  }

  const base: CheckpointTuple = { config, checkpoint, metadata, pendingWrites }

  if (row.parent_checkpoint_id != null) {
    return {
      ...base,
      parentConfig: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      },
    }
  }
  return base
}

export type PostgresCheckpointerOptions = PostgresStoreOptions

/**
 * A LangGraph checkpointer backed by Postgres, storing the serialized
 * checkpoint, metadata and pending-write values as opaque BYTEA.
 *
 * BYTEA rather than jsonb is the whole design: Dawn's payloads reach Postgres
 * carrying raw model and tool output, and jsonb rejects a NUL byte (22P05) and
 * a lone surrogate (22P02) outright. Bytes produced by the inherited
 * `JsonPlusSerializer` round-trip losslessly, matching the SQLite saver.
 */
export class DawnPostgresSaver extends BaseCheckpointSaver {
  private readonly pool: SqlPool
  private readonly ownsPool: boolean
  private readonly schema: string
  private readonly prefix: string
  private readonly checkpointsTable: string
  private readonly writesTable: string
  private readonly assumeMigrated: boolean
  private initP: Promise<void> | undefined

  constructor(options: PostgresCheckpointerOptions = {}) {
    super()
    const schema = options.schema ?? DEFAULT_SCHEMA
    const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
    assertIdentifier("schema", schema)
    assertIdentifier("tablePrefix", prefix)
    this.schema = schema
    this.prefix = prefix
    this.checkpointsTable = qualify({ schema, prefix }, "checkpoints")
    this.writesTable = qualify({ schema, prefix }, "writes")
    this.ownsPool = options.ownsPool ?? false
    this.assumeMigrated = options.assumeMigrated ?? false
    this.pool = options.pool ?? throwNoPool()
  }

  /**
   * Apply migrations once per process; every method awaits this first. Call it
   * directly to migrate at boot instead of on the first checkpoint. Concurrent
   * callers share the single in-flight promise, and cross-process concurrency
   * is handled by the advisory lock inside `runMigrations`.
   */
  ready(): Promise<void> {
    // See `assumeMigrated` in options.ts: a resolved promise, not a cheaper
    // migration — `runMigrations` costs a transaction plus an advisory lock
    // even when there is nothing left to apply.
    this.initP ??= this.assumeMigrated
      ? Promise.resolve()
      : runMigrations(this.pool, CHECKPOINTER_MIGRATIONS, {
          schema: this.schema,
          prefix: this.prefix,
          component: "checkpointer",
        })
    return this.initP
  }

  /** Close the pool if this store owns it (`ownsPool`); otherwise a no-op. */
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end()
  }

  /** Pending writes for the given checkpoints, grouped by checkpoint id. */
  private async loadWrites(
    threadId: string,
    ns: string,
    checkpointIds: readonly string[],
  ): Promise<Map<string, WriteRow[]>> {
    const grouped = new Map<string, WriteRow[]>()
    if (checkpointIds.length === 0) return grouped
    const res = await this.pool.query<WriteRow>(
      `SELECT checkpoint_id, task_id, channel, type, value FROM ${this.writesTable}
       WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = ANY($3::text[])
       ORDER BY task_id COLLATE "C", idx`,
      [threadId, ns, [...checkpointIds]],
    )
    for (const row of res.rows) {
      const existing = grouped.get(row.checkpoint_id)
      if (existing) existing.push(row)
      else grouped.set(row.checkpoint_id, [row])
    }
    return grouped
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return undefined
    await this.ready()
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const ckptId = config.configurable?.checkpoint_id as string | undefined

    const res = ckptId
      ? await this.pool.query<CheckpointRow>(
          `SELECT ${CHECKPOINT_COLUMNS} FROM ${this.checkpointsTable}
           WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`,
          [threadId, ns, ckptId],
        )
      : await this.pool.query<CheckpointRow>(
          `SELECT ${CHECKPOINT_COLUMNS} FROM ${this.checkpointsTable}
           WHERE thread_id = $1 AND checkpoint_ns = $2
           ORDER BY checkpoint_id COLLATE "C" DESC LIMIT 1`,
          [threadId, ns],
        )
    const row = res.rows[0]
    if (!row) return undefined

    const writes = await this.loadWrites(row.thread_id, row.checkpoint_ns, [row.checkpoint_id])
    return buildTuple(row, writes.get(row.checkpoint_id) ?? [], this.serde as Serde)
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return
    await this.ready()
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const before = options?.before?.configurable?.checkpoint_id as string | undefined
    const limit = options?.limit ?? -1
    const filter = options?.filter

    const params: (string | number)[] = [threadId, ns]
    let sql = `SELECT ${CHECKPOINT_COLUMNS} FROM ${this.checkpointsTable}
       WHERE thread_id = $1 AND checkpoint_ns = $2`
    if (before) {
      params.push(before)
      sql += ` AND checkpoint_id COLLATE "C" < $${params.length}`
    }
    // COLLATE "C" is byte ordering, matching SQLite's BINARY collation. The
    // database's own collation is locale-sensitive and would diverge on
    // mixed-case ids.
    sql += ` ORDER BY checkpoint_id COLLATE "C" DESC`
    // A metadata filter is evaluated in JS (metadata is opaque BYTEA), so the
    // row cap cannot be pushed into SQL without dropping matches beyond it.
    if (limit > 0 && !filter) {
      params.push(limit)
      sql += ` LIMIT $${params.length}`
    }

    const serde = this.serde as Serde
    const res = await this.pool.query<CheckpointRow>(sql, params)
    const selected: CheckpointRow[] = []
    for (const row of res.rows) {
      if (filter) {
        const metadata = await serde.loadsTyped("json", row.metadata)
        if (!matchesFilter(metadata, filter)) continue
      }
      selected.push(row)
      if (limit > 0 && selected.length >= limit) break
    }

    const writes = await this.loadWrites(
      threadId,
      ns,
      selected.map((row) => row.checkpoint_id),
    )
    for (const row of selected) {
      yield await buildTuple(row, writes.get(row.checkpoint_id) ?? [], serde)
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) {
      throw new Error("[DawnPostgresSaver] config.configurable.thread_id is required")
    }
    await this.ready()
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null
    // _newVersions is provided by LangGraph for version-tracking purposes but is
    // not persisted separately — versions live inside the serialized checkpoint payload.

    // Use the inherited serde (JsonPlusSerializer) so that LangChain objects such
    // as BaseMessage instances survive the round-trip through Postgres.
    const [checkpointType, checkpointBytes] = await this.serde.dumpsTyped(checkpoint)
    const [, metadataBytes] = await this.serde.dumpsTyped(metadata)

    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO ${this.checkpointsTable}
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
           parent_checkpoint_id = EXCLUDED.parent_checkpoint_id,
           type = EXCLUDED.type,
           checkpoint = EXCLUDED.checkpoint,
           metadata = EXCLUDED.metadata`,
        [threadId, ns, checkpoint.id, parentId, checkpointType, checkpointBytes, metadataBytes],
      )
    })

    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: [string, unknown][],
    taskId: string,
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) {
      throw new Error("[DawnPostgresSaver] config.configurable.thread_id is required")
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const ckptId = config.configurable?.checkpoint_id as string | undefined
    if (!ckptId) {
      throw new Error("[DawnPostgresSaver] config.configurable.checkpoint_id is required")
    }
    await this.ready()

    // Serialize all values before opening the transaction (serde is async).
    const serialized = await Promise.all(
      writes.map(async ([channel, value]) => {
        const [type, bytes] = await this.serde.dumpsTyped(value)
        return { channel, type, bytes }
      }),
    )

    await withTransaction(this.pool, async (client) => {
      for (const [idx, { channel, type, bytes }] of serialized.entries()) {
        await client.query(
          `INSERT INTO ${this.writesTable}
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET
             channel = EXCLUDED.channel, type = EXCLUDED.type, value = EXCLUDED.value`,
          [threadId, ns, ckptId, taskId, idx, channel, type, bytes],
        )
      }
    })
  }

  async deleteThread(threadId: string): Promise<void> {
    if (!threadId) throw new Error("[DawnPostgresSaver] deleteThread requires a thread_id")
    await this.ready()
    await withTransaction(this.pool, async (client) => {
      await client.query(`DELETE FROM ${this.writesTable} WHERE thread_id = $1`, [threadId])
      await client.query(`DELETE FROM ${this.checkpointsTable} WHERE thread_id = $1`, [threadId])
    })
  }
}

/** Build a Postgres-backed LangGraph checkpointer. Migrations run lazily. */
export function postgresCheckpointer(options: PostgresCheckpointerOptions = {}): DawnPostgresSaver {
  return new DawnPostgresSaver(options)
}
