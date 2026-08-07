import { runCheckpointerConformance } from "@dawn-ai/testing"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type DawnPostgresSaver, postgresCheckpointer } from "../src/node.js"

const enabled = process.env.DAWN_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer
let url: string

/** Fresh, never-migrated table set per saver — no truncation, no teardown. */
const freshPrefix = () => `t_${Math.random().toString(36).slice(2)}`

describe.skipIf(!enabled)("postgres-storage real-Postgres conformance", () => {
  beforeAll(async () => {
    // A loaded CI runner can take minutes to pull postgres:16 and accept the
    // first connection; Testcontainers' 60s default is the honest lever here,
    // not a blanket test retry that would hide a genuine failure.
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    url = container.getConnectionUri()
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  runCheckpointerConformance({
    name: "postgresCheckpointer",
    makeSaver: () => postgresCheckpointer({ connectionString: url, tablePrefix: freshPrefix() }),
    describe,
    // Both are real capabilities here: list() hydrates pendingWrites and
    // evaluates options.filter app-side.
    supports: { listPendingWrites: true, listFilter: true },
    close: (saver) => (saver as DawnPostgresSaver).close(),
  })

  test("concurrent cold-start migrations against a virgin database all succeed", async () => {
    // Separate savers means separate pools and separate memoized ready()s —
    // the in-process memo cannot help, so this only passes because the
    // migration takes pg_advisory_xact_lock. Without it, concurrent CREATE
    // TABLE IF NOT EXISTS / migration-row inserts fail with 23505.
    const prefix = freshPrefix()
    const savers = Array.from({ length: 8 }, () =>
      postgresCheckpointer({ connectionString: url, tablePrefix: prefix }),
    )
    try {
      const results = await Promise.allSettled(savers.map((s) => s.ready()))
      expect(results.filter((r) => r.status === "rejected")).toEqual([])

      // The migrated schema is usable, and was applied exactly once.
      const [first] = savers
      const checkpoint = {
        v: 4,
        id: "ckpt-1",
        ts: "2026-08-07T00:00:00.000Z",
        channel_values: { messages: ["ok"] },
        channel_versions: { messages: 2 },
        versions_seen: {},
      }
      await first?.put(
        { configurable: { thread_id: "t1", checkpoint_ns: "" } },
        checkpoint,
        { source: "loop", step: 1, parents: {} },
        { messages: 2 },
      )
      const tuple = await first?.getTuple({
        configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "ckpt-1" },
      })
      expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["ok"] })
    } finally {
      await Promise.all(savers.map((s) => s.close()))
    }
  }, 60_000)
})
