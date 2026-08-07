import type {
  BaseCheckpointSaver,
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint"
import { expect, test } from "vitest"

/** A payload SQLite's BLOB round-trips but a jsonb column rejects (SQLSTATE 22P05). */
const NUL = "before\u0000after"
/** Unpaired high surrogate — rejected by jsonb columns (SQLSTATE 22P02). */
const LONE_SURROGATE = "lone\ud800end"

/** RunnableConfig, without pulling @langchain/core into this package's graph. */
type SaverConfig = Parameters<BaseCheckpointSaver["getTuple"]>[0]

/**
 * A checkpoint plus the `newVersions` LangGraph would pass alongside it.
 *
 * `newVersions` is REALISTIC (one entry per written channel) on purpose: a
 * backend that externalizes `channel_values` keyed by version silently drops
 * them when `newVersions` is empty, so an empty map would let that divergence
 * pass unnoticed.
 */
function mk(
  id: string,
  channelValues: Record<string, unknown>,
  version = 2,
): { checkpoint: Checkpoint; newVersions: ChannelVersions } {
  const channelVersions: ChannelVersions = {}
  for (const key of Object.keys(channelValues)) channelVersions[key] = version
  return {
    checkpoint: {
      v: 4,
      id,
      ts: "2026-08-07T00:00:00.000Z",
      channel_values: channelValues,
      channel_versions: channelVersions,
      versions_seen: { agent: { ...channelVersions } },
    },
    newVersions: { ...channelVersions },
  }
}

const meta = (
  over: { source?: CheckpointMetadata["source"]; step?: number } = {},
): CheckpointMetadata => ({
  source: over.source ?? "loop",
  step: over.step ?? 1,
  parents: {},
})

const cfg = (threadId: string, ns = "", checkpointId?: string): SaverConfig => ({
  configurable: {
    thread_id: threadId,
    checkpoint_ns: ns,
    ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
  },
})

async function collect(gen: AsyncGenerator<CheckpointTuple>): Promise<CheckpointTuple[]> {
  const out: CheckpointTuple[] = []
  for await (const tuple of gen) out.push(tuple)
  return out
}

const noteOf = (metadata: CheckpointMetadata | undefined): unknown =>
  (metadata as { note?: unknown } | undefined)?.note

/**
 * The contract every checkpointer must satisfy. Run against Dawn's SQLite saver
 * (in-process, always) and any other backend (e.g. Postgres, gated) so they
 * cannot drift. Pass vitest's `describe`; `makeSaver` returns a FRESH empty
 * saver per call.
 *
 * Asserted through the PUBLIC saver API only — never the tables. The backends
 * genuinely differ underneath (SQLite stores the whole Checkpoint as one BLOB;
 * another saver may split payloads across columns or externalize channel values
 * keyed by version), and none of that is contract.
 *
 * Two behaviors are CAPABILITY FLAGS rather than assertions, because SQLite
 * deliberately does less than a backend legitimately can:
 *   - `listPendingWrites` — SQLite's `list()` yields lightweight tuples with
 *     `pendingWrites: []` and expects callers needing writes to re-fetch via
 *     `getTuple`.
 *   - `listFilter` — SQLite ignores `options.filter` entirely.
 * Asserting SQLite's shortcuts as contract would fail a richer backend for
 * being better, so each backend declares what it actually promises instead.
 *
 * The two hostile round-trips (a NUL byte and a lone surrogate, in metadata AND
 * in a channel name and value) are not edge-case trivia: they are exactly where
 * a jsonb-backed store diverges from the BLOB-backed incumbent, and Dawn
 * produces such payloads for real — sandbox stdout flows unmodified into tool
 * results and from there into checkpoint metadata. They are deliberately NOT
 * asserted for a pending write's channel column, which is plain text in every
 * backend (SQLite transcodes a lone surrogate there to U+FFFD) and is fed by
 * the graph definition rather than by model or tool output.
 */
export function runCheckpointerConformance(opts: {
  readonly name: string
  readonly makeSaver: () => Promise<BaseCheckpointSaver> | BaseCheckpointSaver
  readonly describe: (name: string, fn: () => void) => void
  readonly close?: (saver: BaseCheckpointSaver) => Promise<void> | void
  readonly supports?: {
    /** `list()` hydrates `pendingWrites` (SQLite: no). */
    readonly listPendingWrites?: boolean
    /** `list({ filter })` narrows by metadata (SQLite: no). */
    readonly listFilter?: boolean
  }
}): void {
  const { name, makeSaver, describe, close, supports } = opts
  describe(`Checkpointer conformance: ${name}`, () => {
    test("put + getTuple round-trips the checkpoint, channel values and metadata", async () => {
      const s = await makeSaver()
      try {
        const { checkpoint, newVersions } = mk("ckpt-1", { messages: ["hi"], count: 3 })
        const metadata = meta({ step: 7 })
        const returned = await s.put(cfg("t1"), checkpoint, metadata, newVersions)
        expect(returned.configurable?.thread_id).toBe("t1")
        expect(returned.configurable?.checkpoint_ns).toBe("")
        expect(returned.configurable?.checkpoint_id).toBe("ckpt-1")

        const tuple = await s.getTuple(cfg("t1", "", "ckpt-1"))
        expect(tuple?.checkpoint.id).toBe("ckpt-1")
        expect(tuple?.checkpoint.ts).toBe(checkpoint.ts)
        expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["hi"], count: 3 })
        expect(tuple?.checkpoint.channel_versions).toEqual(checkpoint.channel_versions)
        expect(tuple?.checkpoint.versions_seen).toEqual(checkpoint.versions_seen)
        expect(tuple?.metadata).toEqual(metadata)
        expect(tuple?.config.configurable?.thread_id).toBe("t1")
        expect(tuple?.config.configurable?.checkpoint_ns).toBe("")
        expect(tuple?.config.configurable?.checkpoint_id).toBe("ckpt-1")
      } finally {
        await close?.(s)
      }
    })
    test("getTuple without a checkpoint_id returns the newest checkpoint", async () => {
      const s = await makeSaver()
      try {
        const a = mk("ckpt-a", { messages: ["a"] })
        const b = mk("ckpt-b", { messages: ["b"] })
        await s.put(cfg("t1"), a.checkpoint, meta({ step: 0 }), a.newVersions)
        await s.put(cfg("t1"), b.checkpoint, meta({ step: 1 }), b.newVersions)
        expect((await s.getTuple(cfg("t1")))?.checkpoint.id).toBe("ckpt-b")
      } finally {
        await close?.(s)
      }
    })
    test("getTuple returns undefined for an unknown thread or checkpoint", async () => {
      const s = await makeSaver()
      try {
        expect(await s.getTuple(cfg("t-missing"))).toBeUndefined()
        const a = mk("ckpt-a", { messages: ["a"] })
        await s.put(cfg("t1"), a.checkpoint, meta(), a.newVersions)
        expect(await s.getTuple(cfg("t1", "", "ckpt-nope"))).toBeUndefined()
      } finally {
        await close?.(s)
      }
    })
    test("put replaces a checkpoint written under the same id", async () => {
      const s = await makeSaver()
      try {
        const first = mk("ckpt-1", { messages: ["v1"] })
        const second = mk("ckpt-1", { messages: ["v2"] }, 3)
        await s.put(cfg("t1"), first.checkpoint, meta({ step: 1 }), first.newVersions)
        await s.put(cfg("t1"), second.checkpoint, meta({ step: 2 }), second.newVersions)
        const tuple = await s.getTuple(cfg("t1", "", "ckpt-1"))
        expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["v2"] })
        expect(tuple?.metadata?.step).toBe(2)
        expect(await collect(s.list(cfg("t1")))).toHaveLength(1)
      } finally {
        await close?.(s)
      }
    })
    test("the parent chain is recorded: root has none, children point back", async () => {
      const s = await makeSaver()
      try {
        const root = mk("ckpt-1", { messages: ["a"] })
        const rootConfig = await s.put(
          cfg("t1"),
          root.checkpoint,
          meta({ step: 0 }),
          root.newVersions,
        )
        const child = mk("ckpt-2", { messages: ["a", "b"] }, 3)
        await s.put(rootConfig, child.checkpoint, meta({ step: 1 }), child.newVersions)

        expect((await s.getTuple(cfg("t1", "", "ckpt-1")))?.parentConfig).toBeUndefined()
        const childTuple = await s.getTuple(cfg("t1", "", "ckpt-2"))
        expect(childTuple?.parentConfig?.configurable?.thread_id).toBe("t1")
        expect(childTuple?.parentConfig?.configurable?.checkpoint_ns).toBe("")
        expect(childTuple?.parentConfig?.configurable?.checkpoint_id).toBe("ckpt-1")
      } finally {
        await close?.(s)
      }
    })
    test("putWrites is visible in getTuple().pendingWrites, in call order", async () => {
      const s = await makeSaver()
      try {
        const a = mk("ckpt-1", { messages: ["a"] })
        const config = await s.put(cfg("t1"), a.checkpoint, meta(), a.newVersions)
        await s.putWrites(
          config,
          [
            ["messages", { role: "ai", text: "one" }],
            ["counter", 2],
          ],
          "task-1",
        )
        expect((await s.getTuple(cfg("t1", "", "ckpt-1")))?.pendingWrites).toEqual([
          ["task-1", "messages", { role: "ai", text: "one" }],
          ["task-1", "counter", 2],
        ])
      } finally {
        await close?.(s)
      }
    })
    test("putWrites is idempotent on (task_id, idx)", async () => {
      const s = await makeSaver()
      try {
        const a = mk("ckpt-1", { messages: ["a"] })
        const config = await s.put(cfg("t1"), a.checkpoint, meta(), a.newVersions)
        await s.putWrites(config, [["messages", "a"]], "task-1")
        await s.putWrites(config, [["messages", "a"]], "task-1")
        expect((await s.getTuple(cfg("t1", "", "ckpt-1")))?.pendingWrites).toEqual([
          ["task-1", "messages", "a"],
        ])
      } finally {
        await close?.(s)
      }
    })
    test("writes are scoped to their own checkpoint", async () => {
      const s = await makeSaver()
      try {
        const a = mk("ckpt-1", { messages: ["a"] })
        const b = mk("ckpt-2", { messages: ["b"] }, 3)
        const configA = await s.put(cfg("t1"), a.checkpoint, meta({ step: 0 }), a.newVersions)
        await s.put(configA, b.checkpoint, meta({ step: 1 }), b.newVersions)
        await s.putWrites(configA, [["messages", "only-for-1"]], "task-1")
        expect((await s.getTuple(cfg("t1", "", "ckpt-2")))?.pendingWrites).toEqual([])
      } finally {
        await close?.(s)
      }
    })
    test("list yields checkpoints newest-first", async () => {
      const s = await makeSaver()
      try {
        for (const id of ["ckpt-a", "ckpt-b", "ckpt-c"]) {
          const c = mk(id, { messages: [id] })
          await s.put(cfg("t1"), c.checkpoint, meta(), c.newVersions)
        }
        expect((await collect(s.list(cfg("t1")))).map((t) => t.checkpoint.id)).toEqual([
          "ckpt-c",
          "ckpt-b",
          "ckpt-a",
        ])
      } finally {
        await close?.(s)
      }
    })
    test("list honors limit", async () => {
      const s = await makeSaver()
      try {
        for (const id of ["ckpt-a", "ckpt-b", "ckpt-c"]) {
          const c = mk(id, { messages: [id] })
          await s.put(cfg("t1"), c.checkpoint, meta(), c.newVersions)
        }
        expect(
          (await collect(s.list(cfg("t1"), { limit: 2 }))).map((t) => t.checkpoint.id),
        ).toEqual(["ckpt-c", "ckpt-b"])
      } finally {
        await close?.(s)
      }
    })
    test("list honors before, exclusively", async () => {
      const s = await makeSaver()
      try {
        for (const id of ["ckpt-a", "ckpt-b", "ckpt-c"]) {
          const c = mk(id, { messages: [id] })
          await s.put(cfg("t1"), c.checkpoint, meta(), c.newVersions)
        }
        const tuples = await collect(s.list(cfg("t1"), { before: cfg("t1", "", "ckpt-c") }))
        expect(tuples.map((t) => t.checkpoint.id)).toEqual(["ckpt-b", "ckpt-a"])
      } finally {
        await close?.(s)
      }
    })
    test("list on an unknown thread yields nothing", async () => {
      const s = await makeSaver()
      try {
        expect(await collect(s.list(cfg("t-missing")))).toEqual([])
      } finally {
        await close?.(s)
      }
    })
    test("checkpoint_ns isolates checkpoints, writes and listing", async () => {
      const s = await makeSaver()
      try {
        const root = mk("ckpt-1", { messages: ["root"] })
        const sub = mk("ckpt-1", { messages: ["sub"] })
        const rootConfig = await s.put(cfg("t1"), root.checkpoint, meta(), root.newVersions)
        await s.put(cfg("t1", "child"), sub.checkpoint, meta(), sub.newVersions)
        await s.putWrites(rootConfig, [["messages", "root-write"]], "task-1")

        expect((await s.getTuple(cfg("t1", "", "ckpt-1")))?.checkpoint.channel_values).toEqual({
          messages: ["root"],
        })
        const subTuple = await s.getTuple(cfg("t1", "child", "ckpt-1"))
        expect(subTuple?.checkpoint.channel_values).toEqual({ messages: ["sub"] })
        expect(subTuple?.config.configurable?.checkpoint_ns).toBe("child")
        expect(subTuple?.pendingWrites).toEqual([])
        expect(await collect(s.list(cfg("t1", "child")))).toHaveLength(1)
      } finally {
        await close?.(s)
      }
    })
    test("deleteThread removes that thread's checkpoints and writes, leaving others", async () => {
      const s = await makeSaver()
      try {
        const doomed = mk("ckpt-1", { messages: ["doomed"] })
        const keeper = mk("ckpt-1", { messages: ["keeper"] })
        const doomedConfig = await s.put(cfg("t1"), doomed.checkpoint, meta(), doomed.newVersions)
        const keeperConfig = await s.put(cfg("t2"), keeper.checkpoint, meta(), keeper.newVersions)
        await s.putWrites(doomedConfig, [["messages", "gone"]], "task-1")
        await s.putWrites(keeperConfig, [["messages", "kept"]], "task-1")
        await s.put(cfg("t1", "child"), doomed.checkpoint, meta(), doomed.newVersions)

        await s.deleteThread("t1")
        expect(await s.getTuple(cfg("t1", "", "ckpt-1"))).toBeUndefined()
        expect(await s.getTuple(cfg("t1", "child", "ckpt-1"))).toBeUndefined()
        expect(await collect(s.list(cfg("t1")))).toEqual([])
        const kept = await s.getTuple(cfg("t2", "", "ckpt-1"))
        expect(kept?.checkpoint.channel_values).toEqual({ messages: ["keeper"] })
        expect(kept?.pendingWrites).toEqual([["task-1", "messages", "kept"]])

        // Re-putting the same id proves the old writes really went away rather
        // than lingering to re-attach.
        await s.put(cfg("t1"), doomed.checkpoint, meta(), doomed.newVersions)
        expect((await s.getTuple(cfg("t1", "", "ckpt-1")))?.pendingWrites).toEqual([])
      } finally {
        await close?.(s)
      }
    })
    test("round-trips a NUL byte in metadata, a channel name and a channel value", async () => {
      const s = await makeSaver()
      try {
        // Hostile bytes go everywhere the payload travels: a channel NAME and a
        // channel VALUE inside the serialized checkpoint (which also carries
        // them into channel_versions and versions_seen), an extra metadata
        // field, and a pending-write value. NOT into the write's channel
        // column: that is a plain text column in every backend, and channel
        // names come from the graph definition, never from model or tool output.
        const { checkpoint, newVersions } = mk("ckpt-1", { [NUL]: NUL, messages: [NUL] })
        const metadata: CheckpointMetadata<{ note: string }> = { ...meta(), note: NUL }
        const config = await s.put(cfg("t1"), checkpoint, metadata, newVersions)
        await s.putWrites(config, [["messages", NUL]], "task-1")

        const tuple = await s.getTuple(cfg("t1", "", "ckpt-1"))
        expect(tuple?.checkpoint.channel_values).toEqual({ [NUL]: NUL, messages: [NUL] })
        expect(tuple?.checkpoint.channel_versions).toEqual(checkpoint.channel_versions)
        expect(tuple?.checkpoint.versions_seen).toEqual(checkpoint.versions_seen)
        expect(noteOf(tuple?.metadata)).toBe(NUL)
        expect(tuple?.pendingWrites).toEqual([["task-1", "messages", NUL]])
      } finally {
        await close?.(s)
      }
    })
    test("round-trips a lone surrogate in metadata, a channel name and a channel value", async () => {
      const s = await makeSaver()
      try {
        const values = { [LONE_SURROGATE]: LONE_SURROGATE, messages: [LONE_SURROGATE] }
        const { checkpoint, newVersions } = mk("ckpt-1", values)
        const metadata: CheckpointMetadata<{ note: string }> = { ...meta(), note: LONE_SURROGATE }
        const config = await s.put(cfg("t1"), checkpoint, metadata, newVersions)
        await s.putWrites(config, [["messages", LONE_SURROGATE]], "task-1")

        const tuple = await s.getTuple(cfg("t1", "", "ckpt-1"))
        expect(tuple?.checkpoint.channel_values).toEqual(values)
        expect(tuple?.checkpoint.channel_versions).toEqual(checkpoint.channel_versions)
        expect(tuple?.checkpoint.versions_seen).toEqual(checkpoint.versions_seen)
        expect(noteOf(tuple?.metadata)).toBe(LONE_SURROGATE)
        expect(tuple?.pendingWrites).toEqual([["task-1", "messages", LONE_SURROGATE]])
      } finally {
        await close?.(s)
      }
    })
    test.skipIf(supports?.listPendingWrites !== true)(
      "list hydrates pendingWrites (declared capability)",
      async () => {
        const s = await makeSaver()
        try {
          const a = mk("ckpt-1", { messages: ["a"] })
          const config = await s.put(cfg("t1"), a.checkpoint, meta(), a.newVersions)
          await s.putWrites(config, [["messages", "w"]], "task-1")
          const [tuple] = await collect(s.list(cfg("t1")))
          expect(tuple?.pendingWrites).toEqual([["task-1", "messages", "w"]])
        } finally {
          await close?.(s)
        }
      },
    )
    test.skipIf(supports?.listFilter !== true)(
      "list narrows by metadata filter (declared capability)",
      async () => {
        const s = await makeSaver()
        try {
          const a = mk("ckpt-a", { messages: ["a"] })
          const b = mk("ckpt-b", { messages: ["b"] })
          await s.put(cfg("t1"), a.checkpoint, meta({ source: "input", step: 0 }), a.newVersions)
          await s.put(cfg("t1"), b.checkpoint, meta({ source: "loop", step: 1 }), b.newVersions)
          const tuples = await collect(s.list(cfg("t1"), { filter: { source: "loop" } }))
          expect(tuples.map((t) => t.checkpoint.id)).toEqual(["ckpt-b"])
        } finally {
          await close?.(s)
        }
      },
    )
  })
}
