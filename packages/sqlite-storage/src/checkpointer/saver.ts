import type { RunnableConfig } from "@langchain/core/runnables"
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint"
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { Db } from "../internal/db.js"

interface CheckpointRow {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  type: string | null
  checkpoint: Uint8Array
  metadata: Uint8Array
}

interface WriteRow {
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

async function buildTuple(
  row: CheckpointRow,
  writes: WriteRow[],
  serde: Serde,
): Promise<CheckpointTuple> {
  const checkpoint = (await serde.loadsTyped(
    row.type ?? "json",
    row.checkpoint,
  )) as Checkpoint
  const metadata = (await serde.loadsTyped("json", row.metadata)) as CheckpointMetadata
  const pendingWrites: [string, string, unknown][] = await Promise.all(
    writes.map(async (w) => [
      w.task_id,
      w.channel,
      w.value != null ? await serde.loadsTyped(w.type ?? "json", w.value) : null,
    ] as [string, string, unknown]),
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

export class DawnSqliteSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Db) {
    super()
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return undefined
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const ckptId = config.configurable?.checkpoint_id as string | undefined

    let row: unknown
    if (ckptId) {
      row = this.db
        .prepare(
          "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?",
        )
        .get(threadId, ns, ckptId)
    } else {
      row = this.db
        .prepare(
          "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1",
        )
        .get(threadId, ns)
    }
    if (!row) return undefined

    const typedRow = row as CheckpointRow
    const writeRows = this.db
      .prepare(
        "SELECT task_id, channel, type, value FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_id, idx",
      )
      .all(
        typedRow.thread_id,
        typedRow.checkpoint_ns,
        typedRow.checkpoint_id,
      ) as unknown as WriteRow[]

    return buildTuple(typedRow, writeRows, this.serde as Serde)
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const before = options?.before?.configurable?.checkpoint_id as string | undefined
    const limit = options?.limit ?? -1

    const params: (string | number)[] = [threadId, ns]
    let sql =
      "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?"
    if (before) {
      sql += " AND checkpoint_id < ?"
      params.push(before)
    }
    sql += " ORDER BY checkpoint_id DESC"
    if (limit > 0) {
      sql += " LIMIT ?"
      params.push(limit)
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as CheckpointRow[]
    for (const row of rows) {
      // Note: list returns lightweight tuples without pendingWrites. Callers that
      // need writes should call getTuple(specificCheckpointId) for full hydration.
      // This matches the @langchain/langgraph-checkpoint-sqlite reference behavior.
      yield await buildTuple(row, [], this.serde as Serde)
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, string | number>,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) {
      throw new Error("[DawnSqliteSaver] config.configurable.thread_id is required")
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null
    // _newVersions is provided by LangGraph for version-tracking purposes but is
    // not persisted separately — versions live inside the serialized checkpoint payload.

    // Use the inherited serde (JsonPlusSerializer) so that LangChain objects such
    // as BaseMessage instances survive the round-trip through SQLite.
    const [checkpointType, checkpointBytes] = await this.serde.dumpsTyped(checkpoint)
    const [, metadataBytes] = await this.serde.dumpsTyped(metadata)

    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        ns,
        checkpoint.id,
        parentId,
        checkpointType,
        checkpointBytes,
        metadataBytes,
      )
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
      throw new Error("[DawnSqliteSaver] config.configurable.thread_id is required")
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const ckptId = config.configurable?.checkpoint_id as string | undefined
    if (!ckptId) {
      throw new Error("[DawnSqliteSaver] config.configurable.checkpoint_id is required")
    }

    // Serialize all values before opening the transaction (serde is async).
    const serialized: Array<{ channel: string; type: string; bytes: Uint8Array }> =
      await Promise.all(
        writes.map(async ([channel, value]) => {
          const [type, bytes] = await this.serde.dumpsTyped(value)
          return { channel, type, bytes }
        }),
      )

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.exec("BEGIN")
    try {
      serialized.forEach(({ channel, type, bytes }, idx) => {
        stmt.run(threadId, ns, ckptId, taskId, idx, channel, type, bytes)
      })
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    if (!threadId) throw new Error("[DawnSqliteSaver] deleteThread requires a thread_id")
    this.db.exec("BEGIN")
    try {
      this.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId)
      this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId)
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }
}
