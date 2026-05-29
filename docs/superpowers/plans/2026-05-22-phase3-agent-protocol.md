# Phase 3 Sub-project 7 — Agent Protocol + SQLite Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dawn's `POST /runs/stream` with AP-compatible HTTP routes backed by a Dawn-native SQLite checkpointer + threads store, so conversation state survives process restart.

**Architecture:** New `@dawn-ai/sqlite-storage` package wraps `node:sqlite` to provide `sqliteCheckpointer` (a `BaseCheckpointSaver`) and `createThreadsStore`. Both are pluggable via `dawn.config.ts`. The dev server's HTTP layer is rewritten to expose AP routes (`/threads`, `/threads/{id}/runs/stream`, `/threads/{id}/state`, etc.) and the existing in-process `MemorySaver` in `@dawn-ai/langchain` is replaced by a caller-injected checkpointer.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, `node:sqlite` (built-in, Node 22+), `@langchain/langgraph-checkpoint` (for `BaseCheckpointSaver` types), biome.

**Spec:** `docs/superpowers/specs/2026-05-22-phase3-agent-protocol-design.md`

---

## File map

**New (`packages/sqlite-storage/`)**
- `package.json`, `tsconfig.json`, `vitest.config.ts`
- `src/index.ts` — public re-exports
- `src/internal/db.ts` — `openDb(path)` opens `DatabaseSync`, enables WAL + FK pragmas
- `src/internal/migrate.ts` — `runMigrations(db, current, migrations)` with `schema_version` table
- `src/checkpointer/schema.ts` — DDL for `checkpoints` + `writes`
- `src/checkpointer/serde.ts` — encode/decode JSON+BLOB checkpoint payloads
- `src/checkpointer/saver.ts` — `DawnSqliteSaver` (subclass of `BaseCheckpointSaver`)
- `src/checkpointer/index.ts` — `sqliteCheckpointer({path})` factory
- `src/threads/schema.ts` — DDL for `threads`
- `src/threads/store.ts` — CRUD impl
- `src/threads/index.ts` — `createThreadsStore({path})` factory + types
- `test/checkpointer.test.ts`, `test/threads.test.ts`, `test/migrate.test.ts`

**Modified**
- `packages/core/src/types.ts` — add `checkpointer`, `threadsStore` to `DawnConfig`; export `ThreadsStore` type
- `packages/langchain/src/agent-adapter.ts` — accept checkpointer from caller; drop `MemorySaver` import
- `packages/cli/src/lib/runtime/execute-route.ts` — instantiate sqlite defaults, thread `threadsStore` through
- `packages/cli/src/lib/dev/runtime-server.ts` — full rewrite of HTTP routes (AP shape)
- `examples/chat/web/app/api/permission-resume/route.ts` — point proxy at `/threads/{id}/resume`
- `examples/chat/web/app/page.tsx` — pass `threadId` directly to AP endpoints; create thread on first send
- Test harness packing: `test/generated/run-generated-app.test.ts`, `test/generated/harness.ts`, `test/generated/cli-testing-export.test.ts`, `test/runtime/run-runtime-contract.test.ts`, `test/smoke/run-smoke.test.ts`, `packages/create-dawn-app/src/index.ts`

**New tests**
- `test/runtime/run-agent-protocol.test.ts` — integration: persistence across restart

---

## Task 1: Scaffold `@dawn-ai/sqlite-storage` package

**Files:**
- Create: `packages/sqlite-storage/package.json`
- Create: `packages/sqlite-storage/tsconfig.json`
- Create: `packages/sqlite-storage/vitest.config.ts`
- Create: `packages/sqlite-storage/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@dawn-ai/sqlite-storage",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/cacheplane/dawnai/tree/main/packages/sqlite-storage#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/cacheplane/dawnai.git",
    "directory": "packages/sqlite-storage"
  },
  "bugs": { "url": "https://github.com/cacheplane/dawnai/issues" },
  "engines": { "node": ">=22.12.0" },
  "files": ["dist"],
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src tsconfig.json vitest.config.ts",
    "test": "vitest --run --config vitest.config.ts --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@langchain/langgraph-checkpoint": "^0.1.0"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@langchain/langgraph-checkpoint": "^0.1.0",
    "@types/node": "25.6.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../config-typescript/node.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
})
```

- [ ] **Step 4: Create stub src/index.ts**

```ts
export {}
```

- [ ] **Step 5: Install + verify build**

Run: `cd /Users/blove/repos/dawn && pnpm install && pnpm --filter @dawn-ai/sqlite-storage build`
Expected: `dist/index.js` and `dist/index.d.ts` created, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite-storage pnpm-lock.yaml
git commit -m "feat(sqlite-storage): scaffold package"
```

---

## Task 2: `openDb` helper with WAL + FK pragmas

**Files:**
- Create: `packages/sqlite-storage/src/internal/db.ts`
- Create: `packages/sqlite-storage/test/db.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/sqlite-storage/test/db.test.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDb } from "../src/internal/db.js"

describe("openDb", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-sqlite-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("opens a database with WAL journal_mode and foreign_keys ON", () => {
    const db = openDb(join(dir, "test.sqlite"))
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(journal.journal_mode).toBe("wal")
    expect(fk.foreign_keys).toBe(1)
    db.close()
  })

  it("creates parent directory if missing", () => {
    const path = join(dir, "nested", "deep", "test.sqlite")
    const db = openDb(path)
    expect(db).toBeDefined()
    db.close()
  })
})
```

- [ ] **Step 2: Run test (expect fail)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: FAIL — cannot find `../src/internal/db.js`.

- [ ] **Step 3: Implement**

```ts
// packages/sqlite-storage/src/internal/db.ts
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type Db = DatabaseSync

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA synchronous = NORMAL")
  return db
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sqlite-storage/src/internal/db.ts packages/sqlite-storage/test/db.test.ts
git commit -m "feat(sqlite-storage): openDb helper with WAL + FK pragmas"
```

---

## Task 3: Schema migration runner

**Files:**
- Create: `packages/sqlite-storage/src/internal/migrate.ts`
- Create: `packages/sqlite-storage/test/migrate.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/sqlite-storage/test/migrate.test.ts
import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { runMigrations } from "../src/internal/migrate.js"

function memDb(): DatabaseSync {
  return new DatabaseSync(":memory:")
}

describe("runMigrations", () => {
  it("creates schema_version table and applies all migrations on fresh db", () => {
    const db = memDb()
    runMigrations(db, [
      { version: 1, up: "CREATE TABLE t1(id INTEGER)" },
      { version: 2, up: "CREATE TABLE t2(id INTEGER)" },
    ])
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(["schema_version", "t1", "t2"])
    const v = db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number }
    expect(v.v).toBe(2)
  })

  it("skips migrations already applied", () => {
    const db = memDb()
    runMigrations(db, [{ version: 1, up: "CREATE TABLE t1(id INTEGER)" }])
    // Re-run with v2 added; v1 must not re-execute.
    runMigrations(db, [
      { version: 1, up: "CREATE TABLE t1(id INTEGER)" }, // would error if re-run
      { version: 2, up: "CREATE TABLE t2(id INTEGER)" },
    ])
    const v = db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number }
    expect(v.v).toBe(2)
  })
})
```

- [ ] **Step 2: Run test (expect fail)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/sqlite-storage/src/internal/migrate.ts
import type { DatabaseSync } from "node:sqlite"

export interface Migration {
  readonly version: number
  readonly up: string
}

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")
  const row = db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number | null }
  const current = row?.v ?? 0
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  for (const m of sorted) {
    if (m.version <= current) continue
    db.exec("BEGIN")
    try {
      db.exec(m.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(m.version)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sqlite-storage/src/internal/migrate.ts packages/sqlite-storage/test/migrate.test.ts
git commit -m "feat(sqlite-storage): migration runner with schema_version"
```

---

## Task 4: Checkpointer schema + serde

**Files:**
- Create: `packages/sqlite-storage/src/checkpointer/schema.ts`
- Create: `packages/sqlite-storage/src/checkpointer/serde.ts`
- Create: `packages/sqlite-storage/test/serde.test.ts`

- [ ] **Step 1: Write schema module**

```ts
// packages/sqlite-storage/src/checkpointer/schema.ts
import type { Migration } from "../internal/migrate.js"

export const CHECKPOINTER_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB NOT NULL,
        metadata BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE INDEX idx_checkpoints_thread ON checkpoints(thread_id, checkpoint_ns);
      CREATE TABLE writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `,
  },
]
```

- [ ] **Step 2: Write failing serde test**

```ts
// packages/sqlite-storage/test/serde.test.ts
import { describe, expect, it } from "vitest"
import { decodeBlob, encodeBlob } from "../src/checkpointer/serde.js"

describe("checkpoint serde", () => {
  it("round-trips a simple object", () => {
    const obj = { messages: [{ role: "user", content: "hi" }], step: 3 }
    const buf = encodeBlob(obj)
    expect(buf).toBeInstanceOf(Uint8Array)
    expect(decodeBlob(buf)).toEqual(obj)
  })

  it("round-trips null and undefined values", () => {
    expect(decodeBlob(encodeBlob({ a: null }))).toEqual({ a: null })
  })

  it("preserves nested structure", () => {
    const obj = { a: { b: { c: [1, 2, 3] } } }
    expect(decodeBlob(encodeBlob(obj))).toEqual(obj)
  })
})
```

- [ ] **Step 3: Run test (expect fail)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: FAIL.

- [ ] **Step 4: Implement serde**

```ts
// packages/sqlite-storage/src/checkpointer/serde.ts
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeBlob(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

export function decodeBlob(buf: Uint8Array): unknown {
  return JSON.parse(decoder.decode(buf))
}
```

- [ ] **Step 5: Run test (expect pass)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite-storage/src/checkpointer/schema.ts packages/sqlite-storage/src/checkpointer/serde.ts packages/sqlite-storage/test/serde.test.ts
git commit -m "feat(sqlite-storage): checkpointer schema + JSON serde"
```

---

## Task 5: `DawnSqliteSaver` (BaseCheckpointSaver subclass)

**Context:** `BaseCheckpointSaver` from `@langchain/langgraph-checkpoint` requires four methods: `getTuple(config)`, `list(config, options)`, `put(config, checkpoint, metadata, newVersions)`, `putWrites(config, writes, taskId)`. Read those signatures in `node_modules/@langchain/langgraph-checkpoint/dist/base.d.ts` if unsure.

**Files:**
- Create: `packages/sqlite-storage/src/checkpointer/saver.ts`
- Create: `packages/sqlite-storage/src/checkpointer/index.ts`
- Create: `packages/sqlite-storage/test/checkpointer.test.ts`

- [ ] **Step 1: Write failing contract test (put → getTuple round-trip)**

```ts
// packages/sqlite-storage/test/checkpointer.test.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sqliteCheckpointer } from "../src/checkpointer/index.js"

describe("DawnSqliteSaver", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-ckpt-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function newSaver() { return sqliteCheckpointer({ path: join(dir, "ckpt.sqlite") }) }

  it("put + getTuple round-trip preserves checkpoint payload", async () => {
    const saver = newSaver()
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const checkpoint = {
      v: 1,
      id: "ckpt-1",
      ts: "2026-05-22T00:00:00Z",
      channel_values: { messages: ["hi"] },
      channel_versions: { messages: 1 },
      versions_seen: {},
      pending_sends: [],
    }
    const metadata = { source: "input", step: 0, writes: null, parents: {} }
    await saver.put(config, checkpoint as never, metadata as never, {})
    const tuple = await saver.getTuple({
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "ckpt-1" },
    })
    expect(tuple).toBeDefined()
    expect(tuple?.checkpoint.id).toBe("ckpt-1")
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["hi"] })
  })

  it("getTuple without checkpoint_id returns the latest by checkpoint_id desc", async () => {
    const saver = newSaver()
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const mk = (id: string) => ({
      v: 1, id, ts: "x", channel_values: {}, channel_versions: {}, versions_seen: {}, pending_sends: [],
    })
    await saver.put(cfg, mk("a") as never, { source: "input", step: 0, writes: null, parents: {} } as never, {})
    await saver.put(cfg, mk("b") as never, { source: "input", step: 1, writes: null, parents: {} } as never, {})
    const t = await saver.getTuple(cfg)
    expect(t?.checkpoint.id).toBe("b")
  })

  it("list yields checkpoints in reverse id order", async () => {
    const saver = newSaver()
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const mk = (id: string) => ({
      v: 1, id, ts: "x", channel_values: {}, channel_versions: {}, versions_seen: {}, pending_sends: [],
    })
    await saver.put(cfg, mk("a") as never, { source: "input", step: 0, writes: null, parents: {} } as never, {})
    await saver.put(cfg, mk("b") as never, { source: "input", step: 1, writes: null, parents: {} } as never, {})
    const ids: string[] = []
    for await (const t of saver.list(cfg)) ids.push(t.checkpoint.id)
    expect(ids).toEqual(["b", "a"])
  })

  it("putWrites is idempotent on (thread_id, ns, ckpt_id, task_id, idx)", async () => {
    const saver = newSaver()
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "ckpt-1" } }
    await saver.putWrites(cfg, [["messages", "a"]], "task-1")
    await saver.putWrites(cfg, [["messages", "a"]], "task-1") // must not throw
    expect(true).toBe(true)
  })

  it("persists across saver instances (file-backed)", async () => {
    const path = join(dir, "ckpt.sqlite")
    const s1 = sqliteCheckpointer({ path })
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "" } }
    const c = { v: 1, id: "c1", ts: "x", channel_values: { x: 1 }, channel_versions: {}, versions_seen: {}, pending_sends: [] }
    await s1.put(cfg, c as never, { source: "input", step: 0, writes: null, parents: {} } as never, {})
    const s2 = sqliteCheckpointer({ path })
    const t = await s2.getTuple({ configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "c1" } })
    expect(t?.checkpoint.channel_values).toEqual({ x: 1 })
  })
})
```

- [ ] **Step 2: Run test (expect fail)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: FAIL.

- [ ] **Step 3: Implement DawnSqliteSaver**

```ts
// packages/sqlite-storage/src/checkpointer/saver.ts
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Db } from "../internal/db.js"
import { decodeBlob, encodeBlob } from "./serde.js"

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

export class DawnSqliteSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Db) {
    super()
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return undefined
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const ckptId = config.configurable?.checkpoint_id as string | undefined

    let row: CheckpointRow | undefined
    if (ckptId) {
      row = this.db
        .prepare(
          "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?",
        )
        .get(threadId, ns, ckptId) as CheckpointRow | undefined
    } else {
      row = this.db
        .prepare(
          "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1",
        )
        .get(threadId, ns) as CheckpointRow | undefined
    }
    if (!row) return undefined

    const checkpoint = decodeBlob(row.checkpoint) as Checkpoint
    const metadata = decodeBlob(row.metadata) as CheckpointMetadata

    const writeRows = this.db
      .prepare(
        "SELECT task_id, channel, type, value FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_id, idx",
      )
      .all(threadId, ns, row.checkpoint_id) as WriteRow[]
    const pendingWrites: [string, string, unknown][] = writeRows.map((w) => [
      w.task_id,
      w.channel,
      w.value ? decodeBlob(w.value) : null,
    ])

    return {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    }
  }

  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig; filter?: Record<string, unknown> },
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const before = options?.before?.configurable?.checkpoint_id as string | undefined
    const limit = options?.limit ?? -1

    const params: unknown[] = [threadId, ns]
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
    const rows = this.db.prepare(sql).all(...params) as CheckpointRow[]
    for (const row of rows) {
      yield {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint: decodeBlob(row.checkpoint) as Checkpoint,
        metadata: decodeBlob(row.metadata) as CheckpointMetadata,
        parentConfig: row.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
          : undefined,
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, string | number>,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, ns, checkpoint.id, parentId, null, encodeBlob(checkpoint), encodeBlob(metadata))
    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: [string, unknown][],
    taskId: string,
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ""
    const ckptId = config.configurable?.checkpoint_id as string
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.exec("BEGIN")
    try {
      writes.forEach(([channel, value], idx) => {
        stmt.run(threadId, ns, ckptId, taskId, idx, channel, null, value == null ? null : encodeBlob(value))
      })
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }
}
```

- [ ] **Step 4: Implement factory**

```ts
// packages/sqlite-storage/src/checkpointer/index.ts
import { openDb } from "../internal/db.js"
import { runMigrations } from "../internal/migrate.js"
import { CHECKPOINTER_MIGRATIONS } from "./schema.js"
import { DawnSqliteSaver } from "./saver.js"

export interface SqliteCheckpointerOptions {
  readonly path: string
}

export function sqliteCheckpointer(options: SqliteCheckpointerOptions): DawnSqliteSaver {
  const db = openDb(options.path)
  runMigrations(db, CHECKPOINTER_MIGRATIONS)
  return new DawnSqliteSaver(db)
}

export { DawnSqliteSaver } from "./saver.js"
```

- [ ] **Step 5: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: PASS (all 5 checkpointer tests + earlier tests).

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite-storage/src/checkpointer packages/sqlite-storage/test/checkpointer.test.ts
git commit -m "feat(sqlite-storage): DawnSqliteSaver implementing BaseCheckpointSaver"
```

---

## Task 6: Threads store

**Files:**
- Create: `packages/sqlite-storage/src/threads/schema.ts`
- Create: `packages/sqlite-storage/src/threads/store.ts`
- Create: `packages/sqlite-storage/src/threads/index.ts`
- Create: `packages/sqlite-storage/test/threads.test.ts`

- [ ] **Step 1: Define schema**

```ts
// packages/sqlite-storage/src/threads/schema.ts
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
```

- [ ] **Step 2: Write failing test**

```ts
// packages/sqlite-storage/test/threads.test.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createThreadsStore } from "../src/threads/index.js"

describe("createThreadsStore", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-threads-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function newStore() { return createThreadsStore({ path: join(dir, "threads.sqlite") }) }

  it("create + get round-trips metadata and assigns timestamps", async () => {
    const store = newStore()
    const t = await store.createThread({ metadata: { user: "brian" } })
    expect(t.thread_id).toMatch(/^t-/)
    expect(t.status).toBe("idle")
    expect(t.metadata).toEqual({ user: "brian" })
    const fetched = await store.getThread(t.thread_id)
    expect(fetched?.thread_id).toBe(t.thread_id)
    expect(fetched?.metadata).toEqual({ user: "brian" })
  })

  it("accepts explicit thread_id", async () => {
    const store = newStore()
    const t = await store.createThread({ thread_id: "t-explicit" })
    expect(t.thread_id).toBe("t-explicit")
  })

  it("getThread returns undefined for unknown id", async () => {
    const store = newStore()
    expect(await store.getThread("t-missing")).toBeUndefined()
  })

  it("deleteThread removes the thread", async () => {
    const store = newStore()
    const t = await store.createThread({})
    await store.deleteThread(t.thread_id)
    expect(await store.getThread(t.thread_id)).toBeUndefined()
  })

  it("listThreads returns most-recently-updated first", async () => {
    const store = newStore()
    const a = await store.createThread({ thread_id: "t-a" })
    await new Promise((r) => setTimeout(r, 2))
    const b = await store.createThread({ thread_id: "t-b" })
    const list = await store.listThreads()
    expect(list[0]?.thread_id).toBe(b.thread_id)
    expect(list[1]?.thread_id).toBe(a.thread_id)
  })
})
```

- [ ] **Step 3: Run test (expect fail)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: FAIL.

- [ ] **Step 4: Implement store**

```ts
// packages/sqlite-storage/src/threads/store.ts
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
        .prepare("SELECT thread_id, created_at, updated_at, metadata, status FROM threads WHERE thread_id = ?")
        .get(threadId) as ThreadRow | undefined
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
        .all() as ThreadRow[]
      return rows.map(rowToThread)
    },
    async updateStatus(threadId, status) {
      const now = new Date().toISOString()
      db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE thread_id = ?").run(status, now, threadId)
    },
  }
}
```

- [ ] **Step 5: Implement factory**

```ts
// packages/sqlite-storage/src/threads/index.ts
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

export type { Thread, ThreadStatus, ThreadsStore, CreateThreadInput } from "./store.js"
```

- [ ] **Step 6: Run tests (expect pass)**

Run: `pnpm --filter @dawn-ai/sqlite-storage test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sqlite-storage/src/threads packages/sqlite-storage/test/threads.test.ts
git commit -m "feat(sqlite-storage): threads store CRUD"
```

---

## Task 7: Public exports

**Files:**
- Modify: `packages/sqlite-storage/src/index.ts`

- [ ] **Step 1: Write re-exports**

```ts
// packages/sqlite-storage/src/index.ts
export { sqliteCheckpointer, DawnSqliteSaver } from "./checkpointer/index.js"
export type { SqliteCheckpointerOptions } from "./checkpointer/index.js"
export { createThreadsStore } from "./threads/index.js"
export type {
  Thread,
  ThreadStatus,
  ThreadsStore,
  CreateThreadInput,
  ThreadsStoreOptions,
} from "./threads/index.js"
```

(Note: `ThreadsStoreOptions` is re-exported; ensure the threads `index.ts` exports it.)

- [ ] **Step 2: Add ThreadsStoreOptions export**

Edit `packages/sqlite-storage/src/threads/index.ts` to add:

```ts
export type { ThreadsStoreOptions }
```

at the bottom (and convert the existing inline `interface` into an explicit export).

- [ ] **Step 3: Build + typecheck**

Run: `pnpm --filter @dawn-ai/sqlite-storage build && pnpm --filter @dawn-ai/sqlite-storage typecheck`
Expected: clean.

- [ ] **Step 4: Lint**

Run: `pnpm --filter @dawn-ai/sqlite-storage lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/sqlite-storage/src/index.ts packages/sqlite-storage/src/threads/index.ts
git commit -m "feat(sqlite-storage): public exports"
```

---

## Task 8: Extend `DawnConfig` with `checkpointer` + `threadsStore`

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Read current DawnConfig**

```bash
grep -n "DawnConfig" /Users/blove/repos/dawn/packages/core/src/types.ts
```

- [ ] **Step 2: Add imports + fields**

Add these imports at the top of `packages/core/src/types.ts`:

```ts
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
```

Inside the `DawnConfig` interface, add:

```ts
readonly checkpointer?: BaseCheckpointSaver
readonly threadsStore?: ThreadsStore
```

- [ ] **Step 3: Add @dawn-ai/sqlite-storage to core's package.json**

Edit `packages/core/package.json`, add to `peerDependencies`:

```json
"@dawn-ai/sqlite-storage": "workspace:*",
"@langchain/langgraph-checkpoint": "^0.1.0"
```

And to `devDependencies`:

```json
"@dawn-ai/sqlite-storage": "workspace:*",
"@langchain/langgraph-checkpoint": "^0.1.0"
```

- [ ] **Step 4: Install + typecheck**

Run: `cd /Users/blove/repos/dawn && pnpm install && pnpm --filter @dawn-ai/core typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): add checkpointer + threadsStore to DawnConfig"
```

---

## Task 9: `agent-adapter` accepts external checkpointer

**Context:** Currently `packages/langchain/src/agent-adapter.ts` constructs a process-level `MemorySaver` singleton. Replace that with a caller-supplied `BaseCheckpointSaver`.

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`

- [ ] **Step 1: Locate the MemorySaver site**

```bash
grep -n "MemorySaver\|checkpointer" /Users/blove/repos/dawn/packages/langchain/src/agent-adapter.ts
```

- [ ] **Step 2: Add `checkpointer` to `AgentOptions`**

In `packages/langchain/src/agent-adapter.ts`, find the `AgentOptions` interface and add:

```ts
readonly checkpointer?: BaseCheckpointSaver
```

with `import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"` at top.

- [ ] **Step 3: Replace MemorySaver fallback**

Replace the `const checkpointer = new MemorySaver()` line with:

```ts
const checkpointer = options.checkpointer
if (!checkpointer) {
  throw new Error(
    "[dawn] agent-adapter requires a checkpointer. Pass one in AgentOptions (the CLI runtime instantiates sqliteCheckpointer by default).",
  )
}
```

Remove the `import { MemorySaver } from "@langchain/langgraph"` line.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @dawn-ai/langchain typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts
git commit -m "refactor(langchain): require external checkpointer in agent-adapter"
```

---

## Task 10: `execute-route` instantiates sqlite defaults

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Inspect current wiring**

```bash
grep -n "createAgent\|checkpointer\|permissionsStore\|MemorySaver" /Users/blove/repos/dawn/packages/cli/src/lib/runtime/execute-route.ts
```

- [ ] **Step 2: Add imports**

At the top of `execute-route.ts`:

```ts
import { sqliteCheckpointer, createThreadsStore, type ThreadsStore } from "@dawn-ai/sqlite-storage"
import { join } from "node:path"
```

- [ ] **Step 3: Instantiate defaults after loading config**

Where `config` is loaded (just after permissions wiring), add:

```ts
const checkpointer =
  config.checkpointer ?? sqliteCheckpointer({ path: join(appRoot, ".dawn/checkpoints.sqlite") })
const threadsStore: ThreadsStore =
  config.threadsStore ?? createThreadsStore({ path: join(appRoot, ".dawn/threads.sqlite") })
```

(Use the same `appRoot` variable already used by the permissions wiring.)

- [ ] **Step 4: Pass `checkpointer` to agent-adapter call**

Find the `createAgent(...)` or `agentAdapter(...)` invocation and add `checkpointer` to the options object.

- [ ] **Step 5: Export `threadsStore` for the HTTP layer**

Change `executeResolvedRoute` (or the surrounding factory) to return `threadsStore` alongside whatever it currently returns. If it returns a function, change the runtime-server caller to receive both.

Concrete shape: add to the route descriptor returned by `resolveRoute(...)`:

```ts
return { ...existing, threadsStore, checkpointer }
```

- [ ] **Step 6: Add package deps**

Edit `packages/cli/package.json`:

```json
"dependencies": {
  "@dawn-ai/sqlite-storage": "workspace:*"
}
```

- [ ] **Step 7: Install + typecheck**

Run: `pnpm install && pnpm --filter @dawn-ai/cli typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): instantiate sqlite checkpointer + threadsStore defaults"
```

---

## Task 11: AP routes — threads CRUD

**Context:** `packages/cli/src/lib/dev/runtime-server.ts` currently has one `POST /runs/stream` and one resume endpoint. Replace with AP-shaped routes. Read the file in full first.

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Create: `test/runtime/run-agent-protocol.test.ts` (integration, deferred to Task 15)

- [ ] **Step 1: Read the existing server**

```bash
wc -l /Users/blove/repos/dawn/packages/cli/src/lib/dev/runtime-server.ts
```

Read entire file before editing.

- [ ] **Step 2: Extract a `routeHandler` helper**

At the top of the request listener, add a small URL pattern matcher. Add this helper above the listener:

```ts
type RouteMatcher = {
  method: string
  pattern: RegExp
  handle: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
}

function matchRoute(routes: RouteMatcher[], req: IncomingMessage): { handle: RouteMatcher["handle"]; params: Record<string, string> } | undefined {
  const url = new URL(req.url ?? "/", "http://localhost")
  for (const r of routes) {
    if (r.method !== req.method) continue
    const m = url.pathname.match(r.pattern)
    if (!m) continue
    const params = m.groups ?? {}
    return { handle: r.handle, params }
  }
  return undefined
}
```

- [ ] **Step 3: Add `POST /threads`**

```ts
{
  method: "POST",
  pattern: /^\/threads$/,
  handle: async (req, res) => {
    const body = await readJson(req)
    const thread = await threadsStore.createThread({ metadata: body?.metadata })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(thread))
  },
}
```

- [ ] **Step 4: Add `GET /threads/:thread_id`**

```ts
{
  method: "GET",
  pattern: /^\/threads\/(?<thread_id>[^/]+)$/,
  handle: async (_req, res, params) => {
    const t = await threadsStore.getThread(params.thread_id)
    if (!t) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "thread not found", code: "thread_not_found" }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(t))
  },
}
```

- [ ] **Step 5: Add `DELETE /threads/:thread_id`**

```ts
{
  method: "DELETE",
  pattern: /^\/threads\/(?<thread_id>[^/]+)$/,
  handle: async (_req, res, params) => {
    await threadsStore.deleteThread(params.thread_id)
    res.writeHead(204).end()
  },
}
```

- [ ] **Step 6: Provide `readJson` helper if missing**

```ts
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}
```

- [ ] **Step 7: Smoke test the new endpoints with curl**

Start the server (in another terminal):
```bash
cd examples/chat/server && pnpm dawn dev
```

Run:
```bash
curl -X POST -H "content-type: application/json" -d '{"metadata":{"user":"brian"}}' http://localhost:3001/threads
```
Expected: JSON `{thread_id: "t-...", ...}`.

```bash
curl http://localhost:3001/threads/t-xxxx
curl -X DELETE http://localhost:3001/threads/t-xxxx
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts
git commit -m "feat(cli): AP threads CRUD endpoints"
```

---

## Task 12: AP routes — runs/stream, runs/wait, state, resume

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`

- [ ] **Step 1: Add `POST /threads/:thread_id/runs/stream`**

Move the existing `/runs/stream` body into this handler, but require `params.thread_id`. The body shape becomes `{input, route, config?}` (was `{message, route, threadId}`). Pass `params.thread_id` as the `threadId` into the agent invocation.

```ts
{
  method: "POST",
  pattern: /^\/threads\/(?<thread_id>[^/]+)\/runs\/stream$/,
  handle: async (req, res, params) => {
    const body = await readJson(req)
    // Ensure thread exists; create if missing (AP idempotence)
    if (!(await threadsStore.getThread(params.thread_id))) {
      await threadsStore.createThread({ thread_id: params.thread_id })
    }
    await threadsStore.updateStatus(params.thread_id, "busy")
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    try {
      const route = await resolveRoute(body.route)
      await streamResolvedRoute({
        route,
        input: body.input,
        threadId: params.thread_id,
        onChunk: (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
        onInterrupt: (envelope) => {
          res.write("event: interrupt\n")
          res.write(`data: ${JSON.stringify(envelope)}\n\n`)
        },
      })
      res.write("event: done\ndata: {}\n\n")
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`)
    } finally {
      await threadsStore.updateStatus(params.thread_id, "idle")
      res.end()
    }
  },
}
```

(Names: replace `streamResolvedRoute`, `resolveRoute` with whatever the current execute-route exports — read it to confirm.)

- [ ] **Step 2: Add `POST /threads/:thread_id/runs/wait`**

```ts
{
  method: "POST",
  pattern: /^\/threads\/(?<thread_id>[^/]+)\/runs\/wait$/,
  handle: async (req, res, params) => {
    const body = await readJson(req)
    if (!(await threadsStore.getThread(params.thread_id))) {
      await threadsStore.createThread({ thread_id: params.thread_id })
    }
    await threadsStore.updateStatus(params.thread_id, "busy")
    try {
      const route = await resolveRoute(body.route)
      const final = await invokeResolvedRoute({
        route,
        input: body.input,
        threadId: params.thread_id,
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(final))
    } finally {
      await threadsStore.updateStatus(params.thread_id, "idle")
    }
  },
}
```

If `invokeResolvedRoute` doesn't exist, create it in `packages/cli/src/lib/runtime/execute-route.ts` as a thin wrapper that calls `agent.invoke(input, {configurable: {thread_id}})`.

- [ ] **Step 3: Add `GET /threads/:thread_id/state`**

```ts
{
  method: "GET",
  pattern: /^\/threads\/(?<thread_id>[^/]+)\/state$/,
  handle: async (_req, res, params) => {
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: params.thread_id, checkpoint_ns: "" },
    })
    if (!tuple) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "no state for thread", code: "no_state" }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        values: tuple.checkpoint.channel_values,
        next: tuple.checkpoint.pending_sends ?? [],
        config: tuple.config,
        metadata: tuple.metadata,
        created_at: tuple.checkpoint.ts,
        parent_config: tuple.parentConfig,
      }),
    )
  },
}
```

The `checkpointer` reference must be threaded through the server constructor; update the server-factory signature to accept `{checkpointer, threadsStore}` alongside whatever route resolution it already has.

- [ ] **Step 4: Move resume endpoint under threads**

Locate the existing `POST /api/permission-resume` (or wherever sub-project 4.5's resume lives). Replace its route with:

```ts
{
  method: "POST",
  pattern: /^\/threads\/(?<thread_id>[^/]+)\/resume$/,
  handle: async (req, res, params) => {
    const body = await readJson(req)
    const pending = pendingByThread.get(params.thread_id)
    if (!pending || pending.interruptId !== body.interruptId) {
      res.writeHead(409, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "stale interrupt_id", code: "stale_interrupt" }))
      return
    }
    pending.resolve(body.decision)
    pendingByThread.delete(params.thread_id)
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
  },
}
```

- [ ] **Step 5: Remove dead `/runs/stream` route**

Delete the un-thread-keyed `/runs/stream` handler entirely.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: clean.

- [ ] **Step 7: Manual curl smoke**

```bash
curl -X POST -H "content-type: application/json" -d '{}' http://localhost:3001/threads
# returns {"thread_id":"t-aaaa",...}

curl -N -X POST -H "content-type: application/json" \
  -d '{"input":{"messages":[{"role":"user","content":"hi"}]},"route":"chat"}' \
  http://localhost:3001/threads/t-aaaa/runs/stream
# streams SSE

curl http://localhost:3001/threads/t-aaaa/state
# returns {values, next, config, ...}
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): AP runs/stream, runs/wait, state, resume endpoints"
```

---

## Task 13: Update chat example to call AP endpoints

**Files:**
- Modify: `examples/chat/web/app/api/chat/route.ts`
- Modify: `examples/chat/web/app/api/permission-resume/route.ts`
- Modify: `examples/chat/web/app/page.tsx`

- [ ] **Step 1: Read current proxy routes**

```bash
cat /Users/blove/repos/dawn/examples/chat/web/app/api/chat/route.ts
cat /Users/blove/repos/dawn/examples/chat/web/app/api/permission-resume/route.ts
```

- [ ] **Step 2: Update `/api/chat` proxy to first create thread (if new), then call `runs/stream`**

```ts
// examples/chat/web/app/api/chat/route.ts
const DAWN = process.env.DAWN_SERVER_URL ?? "http://localhost:3001"

export async function POST(req: Request) {
  const body = (await req.json()) as { threadId: string; message: string; route: string }
  // Idempotent: server creates if missing.
  const upstream = await fetch(`${DAWN}/threads/${encodeURIComponent(body.threadId)}/runs/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { messages: [{ role: "user", content: body.message }] },
      route: body.route,
    }),
  })
  return new Response(upstream.body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}
```

- [ ] **Step 3: Update `/api/permission-resume` proxy**

```ts
// examples/chat/web/app/api/permission-resume/route.ts
const DAWN = process.env.DAWN_SERVER_URL ?? "http://localhost:3001"

export async function POST(req: Request) {
  const body = (await req.json()) as { threadId: string; interruptId: string; decision: "once" | "always" | "deny" }
  const upstream = await fetch(`${DAWN}/threads/${encodeURIComponent(body.threadId)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ interruptId: body.interruptId, decision: body.decision }),
  })
  return new Response(upstream.body, { status: upstream.status })
}
```

- [ ] **Step 4: No changes needed in `page.tsx`**

The web page already passes `threadId` through `/api/chat`; the proxy now puts it in the URL path. Verify there's nothing else that needs updating:

```bash
grep -n "runs/stream\|threads\|permission-resume" /Users/blove/repos/dawn/examples/chat/web/app/page.tsx
```

- [ ] **Step 5: Manual smoke via browser**

```bash
cd examples/chat && pnpm dev
```

Open browser to `http://localhost:3000`. Send a message on `/chat` route. Verify SSE events stream. Then send a second message in the same thread and verify the agent has the prior context (state survived).

Then kill the Dawn server, restart it, send another message in the same browser session → verify the prior conversation context is still present (proves checkpoint persisted).

- [ ] **Step 6: Commit**

```bash
git add examples/chat/web/app/api/chat/route.ts examples/chat/web/app/api/permission-resume/route.ts
git commit -m "feat(chat-example): proxy AP-shaped endpoints"
```

---

## Task 14: Verification harness packing

**Files:**
- Modify: `test/generated/run-generated-app.test.ts`
- Modify: `test/generated/harness.ts`
- Modify: `test/generated/cli-testing-export.test.ts`
- Modify: `test/runtime/run-runtime-contract.test.ts`
- Modify: `test/smoke/run-smoke.test.ts`
- Modify: `packages/create-dawn-app/src/index.ts`

- [ ] **Step 1: Find every `@dawn-ai/permissions` reference**

```bash
grep -rn "@dawn-ai/permissions" /Users/blove/repos/dawn/test /Users/blove/repos/dawn/packages/create-dawn-app/src
```

These are the sites that need `@dawn-ai/sqlite-storage` added in parallel.

- [ ] **Step 2: Per file, mirror the permissions pattern**

For each file, add `"@dawn-ai/sqlite-storage"` everywhere `"@dawn-ai/permissions"` appears:
- `packageNames` arrays
- `PackedTarballs` interface fields
- Override maps
- `toPackedTarballs` function bodies
- Fixture snapshots
- `pnpm.overrides` blocks

Example diff per array:

```ts
const packageNames = [
  "@dawn-ai/core",
  "@dawn-ai/cli",
  "@dawn-ai/langchain",
  "@dawn-ai/workspace",
  "@dawn-ai/permissions",
  "@dawn-ai/sqlite-storage", // NEW
] as const
```

Example diff per interface:

```ts
interface PackedTarballs {
  core: string
  cli: string
  langchain: string
  workspace: string
  permissions: string
  sqliteStorage: string // NEW
}
```

- [ ] **Step 3: Run framework + runtime + smoke verification**

Run each test suite individually first:

```bash
cd /Users/blove/repos/dawn
pnpm --filter dawn-tests test:framework
pnpm --filter dawn-tests test:runtime
pnpm --filter dawn-tests test:smoke
```

Expected: each passes (they pack the new package alongside others).

- [ ] **Step 4: Commit**

```bash
git add test packages/create-dawn-app/src/index.ts
git commit -m "test: pack @dawn-ai/sqlite-storage in verification harnesses"
```

---

## Task 15: Integration test — persistence across restart

**Files:**
- Create: `test/runtime/run-agent-protocol.test.ts`

- [ ] **Step 1: Write the test**

```ts
// test/runtime/run-agent-protocol.test.ts
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildPackedApp } from "./harness.js" // existing helper from runtime tests
import { fetch } from "undici"

describe("agent protocol persistence", () => {
  let appDir: string
  let server: ChildProcess | undefined
  let port: number

  beforeEach(async () => {
    appDir = mkdtempSync(join(tmpdir(), "dawn-ap-"))
    await buildPackedApp(appDir) // packs core+cli+langchain+workspace+permissions+sqlite-storage
    port = 4000 + Math.floor(Math.random() * 1000)
  })

  afterEach(() => {
    server?.kill("SIGKILL")
    rmSync(appDir, { recursive: true, force: true })
  })

  async function startServer(): Promise<void> {
    server = spawn("pnpm", ["dawn", "dev", "--port", String(port)], { cwd: appDir, stdio: "pipe" })
    // Wait for "listening on" log
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server start timeout")), 30_000)
      server?.stdout?.on("data", (chunk) => {
        if (chunk.toString().includes("listening")) { clearTimeout(t); resolve() }
      })
    })
  }

  it("state survives server restart", async () => {
    await startServer()
    const base = `http://localhost:${port}`
    const created = await (await fetch(`${base}/threads`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json() as { thread_id: string }
    const threadId = created.thread_id

    // Drive a run
    const runResp = await fetch(`${base}/threads/${threadId}/runs/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { messages: [{ role: "user", content: "hi" }] }, route: "chat" }),
    })
    expect(runResp.status).toBe(200)

    // Capture state
    const state1 = await (await fetch(`${base}/threads/${threadId}/state`)).json() as { values: { messages: unknown[] } }
    expect(state1.values.messages.length).toBeGreaterThan(0)

    // Kill + restart server, then re-read state
    server?.kill("SIGTERM")
    await new Promise((r) => setTimeout(r, 500))
    await startServer()

    const state2 = await (await fetch(`http://localhost:${port}/threads/${threadId}/state`)).json() as { values: { messages: unknown[] } }
    expect(state2.values.messages.length).toBe(state1.values.messages.length)
  }, 60_000)
})
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/blove/repos/dawn
pnpm --filter dawn-tests vitest --run test/runtime/run-agent-protocol.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/runtime/run-agent-protocol.test.ts
git commit -m "test(runtime): AP persistence across server restart"
```

---

## Task 16: Update phase memory + PR

**Files:**
- Modify: `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md`

- [ ] **Step 1: Add sub-project 7 ✅ entry**

Edit the file: find sub-project list, add:

```md
7. ✅ **Agent Protocol HTTP endpoints + Dawn-native SQLite checkpointer** — shipped in [PR #NNN](https://github.com/cacheplane/dawnai/pull/NNN). New `@dawn-ai/sqlite-storage` package ships `sqliteCheckpointer` (BaseCheckpointSaver via `node:sqlite`, no native deps) and `createThreadsStore`. `dawn.config.ts.checkpointer` + `.threadsStore` are pluggable. HTTP layer rewritten to AP shape: `POST /threads`, `GET/DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. Conversation state survives process restart; verified by `test/runtime/run-agent-protocol.test.ts`. `MemorySaver` removed from `@dawn-ai/langchain`; caller must inject checkpointer.
```

- [ ] **Step 2: Push branch + open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat: phase3 sub-project 7 — agent protocol + sqlite storage" --body "$(cat <<'EOF'
## Summary
- New `@dawn-ai/sqlite-storage` package: Dawn-native `BaseCheckpointSaver` + threads store on `node:sqlite` (no native deps).
- HTTP layer rewritten to AP shape (`/threads`, `/threads/{id}/runs/stream`, `/state`, `/resume`).
- `MemorySaver` removed from `@dawn-ai/langchain`; checkpointer is now pluggable via `dawn.config.ts`.
- Conversation state survives server restart (verified by new integration test).

## Test plan
- [ ] Unit tests for checkpointer + threads store + migrations
- [ ] Integration test (`run-agent-protocol.test.ts`) persistence-across-restart
- [ ] Resume regression under new `/threads/{id}/resume` URL
- [ ] Chrome MCP smoke against chat example: send two messages in same thread, restart server, verify context

Spec: `docs/superpowers/specs/2026-05-22-phase3-agent-protocol-design.md`
Plan: `docs/superpowers/plans/2026-05-22-phase3-agent-protocol.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Update memory file with PR number once opened**

Replace `PR #NNN` with the actual number.

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/plans/2026-05-22-phase3-agent-protocol.md
git commit -m "docs: phase3 sub-project 7 implementation plan"
git push
```

---

## Self-Review Notes

**Spec coverage check:**
- AP endpoint surface (spec §"Endpoint surface") → Tasks 11-12
- Request/response shapes (spec §"Request/response shapes") → Tasks 11-12 handlers
- SQLite checkpointer (spec §"File structure" → sqlite-storage package) → Tasks 1-5, 7
- Threads store (spec §"File structure" → threads/) → Task 6
- `DawnConfig` extension (spec §"Updates to existing packages") → Task 8
- `agent-adapter` rewiring (spec §"Updates to existing packages") → Task 9
- `execute-route` defaults (spec §"Updates to existing packages") → Task 10
- Chat-example proxy update (spec §"Updates to existing packages") → Task 13
- Verification harness packing (spec §"Verification harness packing") → Task 14
- Integration test for restart persistence (spec §"Testing strategy") → Task 15
- Threads-store unit tests (spec §"Testing strategy") → Task 6
- Checkpointer contract tests (spec §"Testing strategy") → Task 5
- Migration tests (spec §"Testing strategy") → Task 3
- Resume regression (spec §"Testing strategy") → covered in Task 13 manual smoke + Task 15 by extension; if needed add packed automation later

**Out-of-scope items intentionally not implemented:** Assistants resource, cron, multi-tenant auth, Postgres backend, websockets, migration tooling for in-memory threads.

**Type consistency check:**
- `sqliteCheckpointer({path})` factory name used identically in Tasks 5, 8, 10
- `createThreadsStore({path})` used identically in Tasks 6, 8, 10
- `ThreadsStore` interface name consistent throughout
- `DawnSqliteSaver` class name consistent
- `BaseCheckpointSaver` import from `@langchain/langgraph-checkpoint` consistent
- HTTP route URL paths match between server (Tasks 11-12) and client proxies (Task 13)
- `pendingByThread` map name from sub-project 4.5 preserved in Task 12
