import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { SQLInputValue } from "node:sqlite"
import { DatabaseSync } from "node:sqlite"
import { DEFAULT_CANDIDATE_POOL, type RecallRankingOptions, scoreMemory } from "./score.js"
import { tokenize } from "./tokenize.js"
import type { MemoryQuery, MemoryRecord, MemoryStore } from "./types.js"

// ---------------------------------------------------------------------------
// Inline DB helpers (mirrors packages/sqlite-storage/src/internal — not
// re-exported from that package's public API, so we replicate the tiny shim).
// ---------------------------------------------------------------------------

function openDb(path: string): DatabaseSync {
  const isMemory = path === ":memory:"
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL")
  }
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA synchronous = NORMAL")
  return db
}

interface Migration {
  readonly version: number
  readonly up: string
}

function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")
  const row = db.prepare("SELECT max(version) AS v FROM schema_version").get() as {
    v: number | null
  }
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, namespace TEXT NOT NULL,
        content TEXT NOT NULL, data TEXT NOT NULL, source TEXT NOT NULL,
        confidence REAL NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL,
        supersedes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        effective_at TEXT, expires_at TEXT
      );
      CREATE INDEX idx_mem_ns_status_updated ON memories(namespace, status, updated_at DESC);
      CREATE TABLE memory_tokens (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, token TEXT NOT NULL
      );
      CREATE INDEX idx_memtok_token ON memory_tokens(token);
      CREATE INDEX idx_memtok_mem ON memory_tokens(memory_id);
    `,
  },
]

// ---------------------------------------------------------------------------
// Row ↔ record conversion
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    kind: row.kind as MemoryRecord["kind"],
    namespace: row.namespace as string,
    content: row.content as string,
    data: JSON.parse(row.data as string) as Record<string, unknown>,
    source: JSON.parse(row.source as string) as MemoryRecord["source"],
    confidence: row.confidence as number,
    tags: JSON.parse(row.tags as string) as string[],
    status: row.status as MemoryRecord["status"],
    ...(row.supersedes ? { supersedes: JSON.parse(row.supersedes as string) as string[] } : {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...(row.effective_at ? { effectiveAt: row.effective_at as string } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}),
  }
}

// Codepoint compare — matches SQLite BINARY collation, no ICU dependence.
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function tokensFor(rec: MemoryRecord): string[] {
  const values = Object.values(rec.data).filter((v) => typeof v === "string") as string[]
  return tokenize([rec.content, rec.tags.join(" "), values.join(" ")].join(" "))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function sqliteMemoryStore(opts: {
  path: string
  /** Recall ranking tuning; all fields defaulted. See score.ts. */
  recall?: RecallRankingOptions
}): MemoryStore {
  const db = openDb(opts.path)
  runMigrations(db, MIGRATIONS)

  function reindex(rec: MemoryRecord): void {
    db.prepare("DELETE FROM memory_tokens WHERE memory_id = ?").run(rec.id)
    const ins = db.prepare("INSERT INTO memory_tokens(memory_id, token) VALUES (?, ?)")
    for (const t of tokensFor(rec)) ins.run(rec.id, t)
  }

  function getById(id: string): MemoryRecord | null {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRecord(row) : null
  }

  function putRecord(rec: MemoryRecord): void {
    db.prepare(
      `INSERT OR REPLACE INTO memories
       (id,kind,namespace,content,data,source,confidence,tags,status,supersedes,created_at,updated_at,effective_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      rec.id,
      rec.kind,
      rec.namespace,
      rec.content,
      JSON.stringify(rec.data),
      JSON.stringify(rec.source),
      rec.confidence,
      JSON.stringify(rec.tags),
      rec.status,
      rec.supersedes ? JSON.stringify(rec.supersedes) : null,
      rec.createdAt,
      rec.updatedAt,
      rec.effectiveAt ?? null,
      rec.expiresAt ?? null,
    )
    reindex(rec)
  }

  return {
    async put(rec) {
      putRecord(rec)
    },
    async get(id) {
      return getById(id)
    },
    async search(q: MemoryQuery) {
      const status = q.status ?? "active"
      const limit = q.limit ?? 8
      const terms = q.query ? tokenize(q.query) : []

      // Shared base filter (namespace + status [+ kind]) — the "corpus".
      let baseSql = `m.namespace = ? AND m.status = ?`
      const baseParams: SQLInputValue[] = [q.namespace, status]
      if (q.kind) {
        baseSql += ` AND m.kind = ?`
        baseParams.push(q.kind)
      }

      if (terms.length === 0) {
        // Query-less path: EXACTLY the pre-ranking behavior (index fragment,
        // listCandidates-adjacent consumers depend on pure recency order).
        const rows = db
          .prepare(
            `SELECT m.* FROM memories m WHERE ${baseSql} ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
          )
          .all(...baseParams, limit) as Record<string, unknown>[]
        let records = rows.map(rowToRecord)
        if (q.tags && q.tags.length > 0) {
          const want = new Set(q.tags)
          records = records.filter((r) => r.tags.some((t) => want.has(t)))
        }
        return records
      }

      // Ranked path — see docs/superpowers/specs/2026-07-05-smarter-recall-design.md.
      const rawPool = opts.recall?.candidatePool
      const pool =
        typeof rawPool === "number" && Number.isFinite(rawPool) && rawPool > 0
          ? Math.floor(rawPool)
          : DEFAULT_CANDIDATE_POOL
      const placeholders = terms.map(() => "?").join(",")

      // 1) Candidate pool: rows matching ≥1 query token, newest first (pool
      //    truncation by recency is deterministic).
      const candidateRows = db
        .prepare(
          `SELECT m.* FROM memories m WHERE ${baseSql}
           AND m.id IN (SELECT memory_id FROM memory_tokens WHERE token IN (${placeholders}))
           ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`,
        )
        .all(...baseParams, ...terms, pool) as Record<string, unknown>[]
      const candidates = candidateRows.map(rowToRecord)
      if (candidates.length === 0) return []

      // 2) Corpus stats, computed live (nothing cached → nothing to go stale).
      const corpusSize = (
        db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${baseSql}`).get(...baseParams) as {
          n: number
        }
      ).n
      const dfRows = db
        .prepare(
          `SELECT t.token AS token, COUNT(DISTINCT t.memory_id) AS df
           FROM memory_tokens t JOIN memories m ON m.id = t.memory_id
           WHERE ${baseSql} AND t.token IN (${placeholders}) GROUP BY t.token`,
        )
        .all(...baseParams, ...terms) as { token: string; df: number }[]
      const dfByToken = new Map(dfRows.map((r) => [r.token, r.df]))

      // 3) Score. Candidate token sets are recomputed via the same helper
      //    reindex() uses, so they are guaranteed consistent with the table.
      //    Pool is updated_at-DESC ordered, so candidates[0] is the newest —
      //    the data-derived reference when the caller supplies no clock.
      const referenceNow = q.now ?? candidates[0]?.updatedAt ?? ""
      const scored = candidates.map((record) => ({
        record,
        score: scoreMemory({
          memoryTokens: new Set(tokensFor(record)),
          queryTokens: terms,
          dfByToken,
          corpusSize,
          updatedAt: record.updatedAt,
          confidence: record.confidence,
          referenceNow,
          ...(opts.recall ? { options: opts.recall } : {}),
        }),
      }))

      // 4) Sort (score DESC, updated_at DESC, id ASC — stable) and page.
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          cmp(b.record.updatedAt, a.record.updatedAt) ||
          cmp(a.record.id, b.record.id),
      )
      let records = scored.slice(0, limit).map((s) => s.record)

      // 5) Tag post-filter on the returned page — today's semantics, unchanged.
      if (q.tags && q.tags.length > 0) {
        const want = new Set(q.tags)
        records = records.filter((r) => r.tags.some((t) => want.has(t)))
      }
      return records
    },
    async update(id, patch) {
      const current = getById(id)
      if (!current) throw new Error(`memory not found: ${id}`)
      putRecord({ ...current, ...patch, id })
    },
    async supersede(id, bySupersedingId) {
      if (!getById(id)) throw new Error(`memory not found: ${id}`)
      db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(id)
      const superseding = getById(bySupersedingId)
      if (superseding) {
        const links = new Set([...(superseding.supersedes ?? []), id])
        db.prepare("UPDATE memories SET supersedes = ? WHERE id = ?").run(
          JSON.stringify([...links]),
          bySupersedingId,
        )
      }
    },
    async delete(id) {
      db.prepare("DELETE FROM memories WHERE id = ?").run(id)
    },
    async listCandidates(namespacePrefix) {
      const rows = db
        .prepare(
          "SELECT * FROM memories WHERE status = 'candidate' AND namespace LIKE ? ORDER BY created_at DESC",
        )
        .all(`${namespacePrefix}%`) as Record<string, unknown>[]
      return rows.map(rowToRecord)
    },
  }
}
