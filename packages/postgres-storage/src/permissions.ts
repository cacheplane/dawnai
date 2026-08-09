import type { PermissionMode, PermissionsFile, PermissionsStore } from "@dawn-ai/permissions"
import { matchPermission } from "@dawn-ai/permissions"
import type { PostgresStoreOptions } from "./options.js"
import {
  assertIdentifier,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  PERMISSIONS_MIGRATIONS,
  qualify,
  runMigrations,
} from "./schema.js"
import { throwNoPool } from "./sql.js"

export interface PostgresPermissionsStoreOptions extends PostgresStoreOptions {
  /**
   * Config-seeded allow/deny lists (from `dawn.config.ts`). Applied in memory
   * on every construction and NEVER written to Postgres — config is the source
   * of truth for itself, exactly as in the file-backed store.
   */
  readonly config?: PermissionsFile
  /** Resolved permission mode. Defaults to `interactive`. */
  readonly mode?: PermissionMode
}

/** A permissions store that also owns Postgres lifecycle. */
export interface PostgresPermissionsStore extends PermissionsStore {
  /** Apply migrations. Idempotent and memoized; call at boot to migrate eagerly. */
  ready(): Promise<void>
  /** Close the pool if this store owns it (`ownsPool`); otherwise a no-op. */
  close(): Promise<void>
}

type MutableMap = Record<string, string[]>

interface PermissionRow {
  kind: string
  tool: string
  pattern: string
}

function cloneMap(src: Readonly<Record<string, readonly string[]>>): MutableMap {
  const out: MutableMap = {}
  for (const [key, patterns] of Object.entries(src)) out[key] = [...patterns]
  return out
}

/**
 * A Postgres-backed permissions store.
 *
 * `PermissionsStore.match()` is SYNCHRONOUS — it is called from inside tool
 * execution and cannot await a query — so this store is a cache with async
 * hydration: `load()` pulls the runtime grants into memory, `match()` reads
 * memory and delegates the decision to `matchPermission` (the same function the
 * file store uses, so deny-wins / prefix-except-"tool" semantics cannot drift),
 * and `addAllow` writes the row and updates the map in the same call.
 *
 * The row-per-grant insert is atomic, so the file store's in-process write
 * queue disappears; and because grants live in a shared table, a second
 * instance sees them after its next `load()` — the thing a per-process
 * permissions.json cannot do.
 */
export function createPostgresPermissionsStore(
  options: PostgresPermissionsStoreOptions = {},
): PostgresPermissionsStore {
  const schema = options.schema ?? DEFAULT_SCHEMA
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  const table = qualify({ schema, prefix }, "permissions")
  const mode: PermissionMode = options.mode ?? "interactive"
  const ownsPool = options.ownsPool ?? false
  const pool = options.pool ?? throwNoPool()

  const configAllow = cloneMap(options.config?.allow ?? {})
  const configDeny = cloneMap(options.config?.deny ?? {})
  let runtimeAllow: MutableMap = {}
  let runtimeDeny: MutableMap = {}

  const assumeMigrated = options.assumeMigrated ?? false

  let initP: Promise<void> | undefined
  const ready = (): Promise<void> => {
    // See `assumeMigrated` in options.ts: a resolved promise, not a cheaper
    // migration — `runMigrations` costs a transaction plus an advisory lock
    // even when there is nothing left to apply.
    initP ??= assumeMigrated
      ? Promise.resolve()
      : runMigrations(pool, PERMISSIONS_MIGRATIONS, {
          schema,
          prefix,
          component: "permissions",
        })
    return initP
  }

  /**
   * The mode state machine, identical to the file store's: `bypass` yields
   * empty maps (so every match is "unknown"), `non-interactive` sees config
   * only, `interactive` concatenates runtime grants onto config per tool key.
   */
  const effective = (config: MutableMap, runtime: MutableMap): Record<string, string[]> => {
    if (mode === "bypass") return {}
    const out: Record<string, string[]> = {}
    for (const [key, patterns] of Object.entries(config)) out[key] = [...patterns]
    if (mode === "interactive") {
      for (const [key, patterns] of Object.entries(runtime)) {
        out[key] = [...(out[key] ?? []), ...patterns]
      }
    }
    return out
  }

  return {
    mode,
    ready,
    async close() {
      if (ownsPool) await pool.end()
    },

    match(tool: string, candidate: string) {
      return matchPermission(
        tool,
        candidate,
        effective(configAllow, runtimeAllow),
        effective(configDeny, runtimeDeny),
      )
    },

    async load() {
      // Runtime grants are only ever consulted in interactive mode, so the
      // other two modes skip the query (and the migration) entirely —
      // mirroring the file store, which does not read permissions.json either.
      if (mode !== "interactive") return
      await ready()
      const res = await pool.query<PermissionRow>(
        `SELECT kind, tool, pattern FROM ${table} WHERE scope = 'runtime'`,
      )
      const allow: MutableMap = {}
      const deny: MutableMap = {}
      for (const row of res.rows) {
        const target = row.kind === "deny" ? deny : allow
        const list = target[row.tool] ?? []
        list.push(row.pattern)
        target[row.tool] = list
      }
      // Replace, don't merge: the table is authoritative, so a grant revoked
      // out of band (an operator DELETE) disappears on the next load. The cost
      // is a narrow race — an addAllow that commits after this SELECT but
      // updates its cache before this assignment loses its in-memory entry
      // until the next load; the row itself is already durable.
      runtimeAllow = allow
      runtimeDeny = deny
    },

    async addAllow(tool: string, pattern: string) {
      await ready()
      await pool.query(
        `INSERT INTO ${table} (scope, kind, tool, pattern, created_at)
         VALUES ('runtime', 'allow', $1, $2, $3)
         ON CONFLICT (scope, kind, tool, pattern) DO NOTHING`,
        [tool, pattern, new Date().toISOString()],
      )
      // The cache update is what makes the grant visible to the synchronous
      // match() the instant this resolves — no reload in between.
      const list = runtimeAllow[tool] ?? []
      if (!list.includes(pattern)) list.push(pattern)
      runtimeAllow[tool] = list
    },
  }
}
