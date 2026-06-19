# Long-Term Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Dawn agents cross-thread persistent memory — route-local `memory.md` plus a typed, namespaced `node:sqlite` collection with generated `remember`/`recall` tools, deterministic keyword+recency recall, and candidate-default write governance.

**Architecture:** A new `@dawn-ai/memory` package holds the `MemoryRecord` model + `sqliteMemoryStore` (built on `@dawn-ai/sqlite-storage`'s `openDb`/`runMigrations`). Two new `@dawn-ai/core` capability markers (`memory-md` for the route profile, `memory` for the typed collection) contribute prompt fragments + `remember`/`recall` tools. `defineMemory` (in `@dawn-ai/sdk`) declares a route's zod schema; typegen emits typed tool signatures. The CLI wires registration, typegen detection, a config resolver, and a `dawn memory` command.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, biome, zod, `node:sqlite` (no FTS5 → tokenized `LIKE`), `@dawn-ai/sqlite-storage`, `@dawn-ai/permissions`, `@copilotkit/aimock` (deterministic tests).

**Branch:** `feat/long-term-memory` (created off main). Spec: `docs/superpowers/specs/2026-06-18-long-term-memory-design.md`.

**Conventions every task:** prefix shell commands with `cd /Users/blove/repos/dawn` (cwd resets per call). Run one test file with `pnpm --filter <pkg> exec vitest run <relpath> -t "<name>"`. Lint via the package's script (`pnpm --filter <pkg> run lint`) — NEVER bare `biome check --write` (wrong config → mass reformat). Verify the COMMITTED state is lint-clean before moving on. Commit after each task with the shown message.

---

## File Structure

**New package `@dawn-ai/memory`** (`packages/memory/`):
- `src/types.ts` — `MemoryRecord`, `MemoryQuery`, `MemoryStore`, `MemoryScopeTuple`.
- `src/namespace.ts` — `serializeNamespace(tuple)` / scope helpers.
- `src/tokenize.ts` — `tokenize(text)` (lowercase term split) for the FTS5-substitute index.
- `src/reconcile.ts` — pure `classifyWrite(incoming, candidates, identityKeys)` → ADD/UPDATE/SUPERSEDE.
- `src/sqlite-store.ts` — `sqliteMemoryStore({ path })`: schema migrations + `MemoryStore` impl.
- `src/index.ts` — barrel.
- `test/*.test.ts` — unit tests (`:memory:` DB).

**`@dawn-ai/sdk`** (`packages/sdk/src/`):
- `memory.ts` — `defineMemory({ kind, scope, schema })` + `DefinedMemory` type.
- `index.ts` — export `defineMemory`.

**`@dawn-ai/core`** (`packages/core/src/`):
- `capabilities/built-in/memory-md.ts` — L2 route-`memory.md` prompt fragment (mirrors `agents-md.ts`).
- `capabilities/built-in/memory.ts` — L3 capability: `remember`/`recall` tools + memory-index prompt fragment.
- `types.ts` — add `DawnConfig.memory` field.

**`@dawn-ai/cli`** (`packages/cli/src/`):
- `lib/runtime/execute-route.ts` — register both markers; `resolveMemoryStore()`.
- `lib/typegen/run-typegen.ts` — `MEMORY_EXTRA_TOOLS` + `hasMemory()` detection.
- `lib/runtime/load-memory.ts` — load a route's `memory.ts` (`defineMemory` default export) via tsx, like `load-evals`.
- `commands/memory.ts` — `dawn memory list|search|inspect|approve|reject|forget`.

**`@dawn-ai/testing`** (`packages/testing/src/`):
- `memory.ts` — `seedMemory(store-or-path, records)` helper + re-export.

**`@dawn-ai/evals`** (`packages/evals/src/`):
- `scorers/memory.ts` — `memoryRecalled`, `memoryIsolated`, `memoryFresh` scorers.

**Research template** (`packages/devkit/templates/app-research/`): a `memory.ts` + seeded memory + a memory eval.

---

## PHASE 1 — Route-local `memory.md` (L2)

Smallest, self-contained: a prompt-fragment capability that injects `<routeDir>/memory.md` after the workspace AGENTS.md memory. Mirrors `packages/core/src/capabilities/built-in/agents-md.ts`.

### Task 1.1: `memory-md` capability marker

**Files:**
- Create: `packages/core/src/capabilities/built-in/memory-md.ts`
- Test: `packages/core/test/capabilities/memory-md.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/capabilities/memory-md.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMemoryMdMarker } from "../../src/capabilities/built-in/memory-md.js"

const ctx = { routeManifest: {} as never, descriptor: undefined, appRoot: "/unused" }

describe("memory-md capability", () => {
  let routeDir: string
  beforeEach(() => { routeDir = mkdtempSync(join(tmpdir(), "dawn-memmd-")) })
  afterEach(() => rmSync(routeDir, { recursive: true, force: true }))

  it("does not activate when memory.md is absent", async () => {
    expect(await createMemoryMdMarker().detect(routeDir, ctx)).toBe(false)
  })

  it("injects memory.md contents under a heading when present", async () => {
    writeFileSync(join(routeDir, "memory.md"), "Prefer pnpm. Use Vitest.", "utf8")
    const marker = createMemoryMdMarker()
    expect(await marker.detect(routeDir, ctx)).toBe(true)
    const contribution = await marker.load(routeDir, ctx)
    const rendered = contribution.promptFragment?.render({})
    expect(rendered).toContain("Prefer pnpm. Use Vitest.")
    expect(rendered).toContain("# Route Memory")
  })

  it("renders empty for a whitespace-only file", async () => {
    writeFileSync(join(routeDir, "memory.md"), "   \n  ", "utf8")
    const contribution = await createMemoryMdMarker().load(routeDir, ctx)
    expect(contribution.promptFragment?.render({})).toBe("")
  })
})
```

- [ ] **Step 2: Run test → FAIL** (`Cannot find module '.../memory-md.js'`)

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core exec vitest run test/capabilities/memory-md.test.ts`

- [ ] **Step 3: Implement** (mirror `agents-md.ts`; the file lives in the *route dir*, re-read per turn, 32 KiB cap)

```ts
// packages/core/src/capabilities/built-in/memory-md.ts
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CapabilityMarker } from "../types.js"

const MAX_MEMORY_BYTES = 32 * 1024
const MEMORY_HEADER = `# Route Memory

The block below is the live contents of this route's \`memory.md\`, re-read every turn. It is stable, human-editable context for this route only.

---`

const MEMORY_FILE = "memory.md"

/**
 * Injects <routeDir>/memory.md into the system prompt under a "# Route Memory"
 * heading. Opt-in by file presence; re-read every turn. Route-scoped profile
 * memory — distinct from the global workspace AGENTS.md (agents-md.ts).
 */
export function createMemoryMdMarker(): CapabilityMarker {
  return {
    name: "memory-md",
    detect: async (routeDir) => existsSync(join(routeDir, MEMORY_FILE)),
    load: async (routeDir) => {
      const path = join(routeDir, MEMORY_FILE)
      return {
        promptFragment: {
          placement: "after_user_prompt",
          render: () => renderRouteMemory(path),
        },
      }
    },
  }
}

function renderRouteMemory(path: string): string {
  if (!existsSync(path)) return ""
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return ""
  }
  if (size > MAX_MEMORY_BYTES) {
    return `${MEMORY_HEADER}\n\n(route memory.md is ${size} bytes; exceeds 32 KiB limit — not loaded)`
  }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return ""
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ""
  return `${MEMORY_HEADER}\n\n${trimmed}`
}
```

- [ ] **Step 4: Run test → PASS** (3 tests). Then `pnpm --filter @dawn-ai/core run typecheck` (or the package's build script) clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/core/src/capabilities/built-in/memory-md.ts packages/core/test/capabilities/memory-md.test.ts
git commit -m "feat(core): route-local memory.md capability (L2)"
```

### Task 1.2: Register `memory-md` + export

**Files:**
- Modify: `packages/core/src/capabilities/built-in/index.ts` (or the barrel that re-exports markers — confirm with `grep -rn "createAgentsMdMarker" packages/core/src`)
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (the `createCapabilityRegistry([...])` array)

- [ ] **Step 1: Export the marker.** Add `export { createMemoryMdMarker } from "./memory-md.js"` next to the `createAgentsMdMarker` export (find the file with `grep -rn "createAgentsMdMarker" packages/core/src | grep export`).

- [ ] **Step 2: Register in the CLI runtime.** In `packages/cli/src/lib/runtime/execute-route.ts`, add `createMemoryMdMarker()` to the `createCapabilityRegistry([...])` array (import it from `@dawn-ai/core`), placing it right after `createAgentsMdMarker()`.

- [ ] **Step 3: Verify** the package builds and the existing capability tests still pass:

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/cli exec tsc -b tsconfig.build.json`
Expected: green.

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/core/src/capabilities packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(core,cli): register memory-md capability"
```

---

## PHASE 2 — `@dawn-ai/memory` store

The typed-row collection. Pure logic + a `node:sqlite` store. No agent wiring yet.

### Task 2.1: Scaffold the package

**Files:**
- Create: `packages/memory/package.json`, `packages/memory/tsconfig.json`, `packages/memory/tsconfig.build.json`, `packages/memory/vitest.config.ts`, `packages/memory/biome.json`-less (uses shared config), `packages/memory/src/index.ts` (empty barrel for now)

- [ ] **Step 1: Mirror `@dawn-ai/sqlite-storage`'s package files.** Copy `packages/sqlite-storage/package.json` → `packages/memory/package.json`; change `"name"` to `"@dawn-ai/memory"`, keep `"version"` matching the fixed group's current version (read `packages/sqlite-storage/package.json` version), keep the same `scripts`, `exports`, `lint` (with `--config-path ../config-biome/biome.json`), `typecheck`, `build` shapes. Set `dependencies` to `{ "@dawn-ai/sqlite-storage": "workspace:*" }`. Copy `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` from sqlite-storage verbatim, adjusting any `references` paths (add a reference to `../sqlite-storage`). Create `packages/memory/src/index.ts` with `export {}`.

- [ ] **Step 2: Add to the changesets fixed group.** In `.changeset/config.json`, add `"@dawn-ai/memory"` to the `fixed` array (alphabetical position).

- [ ] **Step 3: Install + verify it builds.** Run `cd /Users/blove/repos/dawn && pnpm install && pnpm --filter @dawn-ai/memory build`. Expected: clean (empty package builds).

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/memory .changeset/config.json pnpm-lock.yaml
git commit -m "chore(memory): scaffold @dawn-ai/memory package"
```

### Task 2.2: Types

**Files:**
- Create: `packages/memory/src/types.ts`
- Test: `packages/memory/test/types.test.ts` (a compile-only/shape test)

- [ ] **Step 1: Write the failing test**

```ts
// packages/memory/test/types.test.ts
import { describe, expect, it } from "vitest"
import type { MemoryRecord } from "../src/types.js"

describe("MemoryRecord", () => {
  it("accepts a well-formed semantic record", () => {
    const rec: MemoryRecord = {
      id: "m1", kind: "semantic", namespace: "ws=acme|route=/support",
      content: "Tenant acme escalates billing above $500.",
      data: { subject: "billing", predicate: "escalate_above", value: "500" },
      source: { type: "run", id: "run1" },
      confidence: 0.9, tags: ["billing"], status: "active",
      createdAt: "2026-06-18T00:00:00.000Z", updatedAt: "2026-06-18T00:00:00.000Z",
    }
    expect(rec.kind).toBe("semantic")
  })
})
```

- [ ] **Step 2: Run → FAIL** (module missing)

- [ ] **Step 3: Implement** (exact shapes from the spec §"Memory object model" + §"Storage")

```ts
// packages/memory/src/types.ts
export type MemoryKind = "semantic" | "episodic" | "procedural" | "reflection"
export type MemoryStatus = "candidate" | "active" | "superseded"

export interface MemorySource {
  readonly type: "run" | "user" | "tool" | "eval" | "human"
  readonly id: string
}

export interface MemoryRecord {
  readonly id: string
  readonly kind: MemoryKind
  readonly namespace: string
  readonly content: string
  readonly data: Record<string, unknown>
  readonly source: MemorySource
  readonly confidence: number
  readonly tags: readonly string[]
  readonly status: MemoryStatus
  readonly supersedes?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly effectiveAt?: string
  readonly expiresAt?: string
}

export interface MemoryQuery {
  readonly namespace: string
  readonly query?: string
  readonly kind?: MemoryKind
  readonly tags?: readonly string[]
  readonly status?: MemoryStatus
  readonly limit?: number
}

export interface MemoryStore {
  put(rec: MemoryRecord): Promise<void>
  get(id: string): Promise<MemoryRecord | null>
  search(q: MemoryQuery): Promise<readonly MemoryRecord[]>
  update(id: string, patch: Partial<MemoryRecord>): Promise<void>
  supersede(id: string, bySupersedingId: string): Promise<void>
  delete(id: string): Promise<void>
  listCandidates(namespacePrefix: string): Promise<readonly MemoryRecord[]>
}
```

- [ ] **Step 4: Run → PASS.** Export from `src/index.ts`: `export type { MemoryRecord, MemoryQuery, MemoryStore, MemoryKind, MemoryStatus, MemorySource } from "./types.js"`.

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/memory/src packages/memory/test/types.test.ts
git commit -m "feat(memory): MemoryRecord/MemoryStore types"
```

### Task 2.3: `tokenize` (FTS5 substitute)

**Files:** Create `packages/memory/src/tokenize.ts`; Test `packages/memory/test/tokenize.test.ts`

- [ ] **Step 1: Failing test**

```ts
// packages/memory/test/tokenize.test.ts
import { describe, expect, it } from "vitest"
import { tokenize } from "../src/tokenize.js"

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics, dropping empties + short tokens", () => {
    expect(tokenize("Billing Escalate-Above $500!")).toEqual(["billing", "escalate", "above", "500"])
  })
  it("dedupes", () => {
    expect(tokenize("pnpm pnpm PNPM")).toEqual(["pnpm"])
  })
  it("drops 1-char tokens", () => {
    expect(tokenize("a bc d ef")).toEqual(["bc", "ef"])
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
// packages/memory/src/tokenize.ts
/** Lowercase, split on non-alphanumerics, drop 1-char tokens, dedupe (insertion order). */
export function tokenize(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}
```

- [ ] **Step 4: Run → PASS.** Add `export { tokenize } from "./tokenize.js"` to the barrel.

- [ ] **Step 5: Commit** `feat(memory): tokenize() keyword splitter`

### Task 2.4: `namespace` serialization

**Files:** Create `packages/memory/src/namespace.ts`; Test `packages/memory/test/namespace.test.ts`

- [ ] **Step 1: Failing test**

```ts
// packages/memory/test/namespace.test.ts
import { describe, expect, it } from "vitest"
import { serializeNamespace } from "../src/namespace.js"

describe("serializeNamespace", () => {
  it("serializes a scope tuple with stable key order", () => {
    expect(serializeNamespace({ route: "/support", workspace: "acme" })).toBe("workspace=acme|route=/support")
  })
  it("omits undefined dimensions and keeps the canonical order workspace,route,tenant,user,agent", () => {
    expect(serializeNamespace({ workspace: "acme", tenant: "t1", user: "u1" }))
      .toBe("workspace=acme|tenant=t1|user=u1")
  })
  it("throws on an empty tuple (fail-closed)", () => {
    expect(() => serializeNamespace({})).toThrow(/at least one/i)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
// packages/memory/src/namespace.ts
export interface MemoryScopeTuple {
  readonly workspace?: string
  readonly route?: string
  readonly tenant?: string
  readonly user?: string
  readonly agent?: string
}

const ORDER = ["workspace", "route", "tenant", "user", "agent"] as const

/** Serialize a scope tuple to a stable namespace string. Fail-closed on empty. */
export function serializeNamespace(tuple: MemoryScopeTuple): string {
  const parts: string[] = []
  for (const key of ORDER) {
    const value = tuple[key]
    if (value !== undefined && value !== "") parts.push(`${key}=${value}`)
  }
  if (parts.length === 0) {
    throw new Error("serializeNamespace: scope tuple must have at least one dimension")
  }
  return parts.join("|")
}
```

- [ ] **Step 4: Run → PASS.** Barrel: `export { serializeNamespace, type MemoryScopeTuple } from "./namespace.js"`.

- [ ] **Step 5: Commit** `feat(memory): namespace serialization`

### Task 2.5: `reconcile` (ADD/UPDATE/SUPERSEDE classifier)

**Files:** Create `packages/memory/src/reconcile.ts`; Test `packages/memory/test/reconcile.test.ts`

- [ ] **Step 1: Failing test**

```ts
// packages/memory/test/reconcile.test.ts
import { describe, expect, it } from "vitest"
import { classifyWrite } from "../src/reconcile.js"
import type { MemoryRecord } from "../src/types.js"

function rec(data: Record<string, unknown>, id = "x"): MemoryRecord {
  return { id, kind: "semantic", namespace: "ws=a", content: "", data,
    source: { type: "run", id: "r" }, confidence: 1, tags: [], status: "active",
    createdAt: "t", updatedAt: "t" }
}
const identity = ["subject", "predicate"]

describe("classifyWrite", () => {
  it("ADD when no candidate shares the identity key", () => {
    const out = classifyWrite(rec({ subject: "a", predicate: "p", value: "1" }), [], identity)
    expect(out.op).toBe("add")
  })
  it("UPDATE when identity matches and value is equal", () => {
    const existing = rec({ subject: "a", predicate: "p", value: "1" }, "e1")
    const out = classifyWrite(rec({ subject: "a", predicate: "p", value: "1" }), [existing], identity)
    expect(out).toEqual({ op: "update", targetId: "e1" })
  })
  it("SUPERSEDE when identity matches but value differs", () => {
    const existing = rec({ subject: "a", predicate: "p", value: "1" }, "e1")
    const out = classifyWrite(rec({ subject: "a", predicate: "p", value: "2" }), [existing], identity)
    expect(out).toEqual({ op: "supersede", targetId: "e1" })
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
// packages/memory/src/reconcile.ts
import type { MemoryRecord } from "./types.js"

export type WriteOp =
  | { op: "add" }
  | { op: "update"; targetId: string }
  | { op: "supersede"; targetId: string }

function identityOf(data: Record<string, unknown>, keys: readonly string[]): string {
  return keys.map((k) => JSON.stringify(data[k] ?? null)).join(" ")
}

/**
 * Deterministic write classification against existing candidates (no LLM).
 * ADD if no candidate shares the identity key; UPDATE if one does AND the full
 * `data` is deep-equal; SUPERSEDE if the identity matches but `data` differs.
 */
export function classifyWrite(
  incoming: MemoryRecord,
  candidates: readonly MemoryRecord[],
  identityKeys: readonly string[],
): WriteOp {
  const incomingId = identityOf(incoming.data, identityKeys)
  const match = candidates.find((c) => identityOf(c.data, identityKeys) === incomingId)
  if (!match) return { op: "add" }
  const same = JSON.stringify(match.data) === JSON.stringify(incoming.data)
  return same ? { op: "update", targetId: match.id } : { op: "supersede", targetId: match.id }
}
```

- [ ] **Step 4: Run → PASS.** Barrel: `export { classifyWrite, type WriteOp } from "./reconcile.js"`.

- [ ] **Step 5: Commit** `feat(memory): deterministic write reconciliation`

### Task 2.6: `sqliteMemoryStore`

**Files:** Create `packages/memory/src/sqlite-store.ts`; Test `packages/memory/test/sqlite-store.test.ts`. Reuse `openDb`/`runMigrations` from `@dawn-ai/sqlite-storage` (confirm their export paths with `grep -rn "export.*openDb\|export.*runMigrations" packages/sqlite-storage/src`).

- [ ] **Step 1: Failing test** (`:memory:` DB; covers put/get, namespace isolation, keyword search, recency order, supersede)

```ts
// packages/memory/test/sqlite-store.test.ts
import { describe, expect, it } from "vitest"
import { sqliteMemoryStore } from "../src/sqlite-store.js"
import type { MemoryRecord } from "../src/types.js"

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace" | "content">): MemoryRecord {
  return { kind: "semantic", data: {}, source: { type: "run", id: "r" }, confidence: 1,
    tags: [], status: "active", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z", ...over }
}

describe("sqliteMemoryStore", () => {
  it("put + get round-trips a record", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns1", content: "hello billing" }))
    expect((await s.get("a"))?.content).toBe("hello billing")
  })

  it("search is namespace-isolated", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns1", content: "billing escalation" }))
    await s.put(rec({ id: "b", namespace: "ns2", content: "billing escalation" }))
    const res = await s.search({ namespace: "ns1", query: "billing" })
    expect(res.map((r) => r.id)).toEqual(["a"])
  })

  it("search matches on tokenized keywords and orders by recency (updatedAt desc)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "old", namespace: "ns", content: "escalate billing", updatedAt: "2026-01-01T00:00:00.000Z" }))
    await s.put(rec({ id: "new", namespace: "ns", content: "escalate billing", updatedAt: "2026-02-01T00:00:00.000Z" }))
    await s.put(rec({ id: "other", namespace: "ns", content: "unrelated note" }))
    const res = await s.search({ namespace: "ns", query: "billing" })
    expect(res.map((r) => r.id)).toEqual(["new", "old"])
  })

  it("search defaults to active status (excludes candidate/superseded)", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "a", namespace: "ns", content: "billing", status: "candidate" }))
    expect(await s.search({ namespace: "ns", query: "billing" })).toHaveLength(0)
    expect(await s.search({ namespace: "ns", query: "billing", status: "candidate" })).toHaveLength(1)
  })

  it("supersede flips the old record's status and links it", async () => {
    const s = sqliteMemoryStore({ path: ":memory:" })
    await s.put(rec({ id: "old", namespace: "ns", content: "v1" }))
    await s.put(rec({ id: "new", namespace: "ns", content: "v2" }))
    await s.supersede("old", "new")
    expect((await s.get("old"))?.status).toBe("superseded")
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (one `memories` table + a `memory_tokens` table populated from `tokenize(content + tags + data-values)`; search = JOIN on matching tokens, filter namespace+status, order by `updated_at DESC`)

```ts
// packages/memory/src/sqlite-store.ts
import { openDb, runMigrations } from "@dawn-ai/sqlite-storage"
import { tokenize } from "./tokenize.js"
import type { MemoryQuery, MemoryRecord, MemoryStore } from "./types.js"

const MIGRATIONS = [
  {
    version: 1,
    up: `
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        namespace TEXT NOT NULL,
        content TEXT NOT NULL,
        data TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        tags TEXT NOT NULL,
        status TEXT NOT NULL,
        supersedes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        effective_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX idx_mem_ns_status_updated ON memories(namespace, status, updated_at DESC);
      CREATE TABLE memory_tokens (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        token TEXT NOT NULL
      );
      CREATE INDEX idx_memtok_token ON memory_tokens(token);
      CREATE INDEX idx_memtok_mem ON memory_tokens(memory_id);
    `,
  },
]

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    kind: row.kind as MemoryRecord["kind"],
    namespace: row.namespace as string,
    content: row.content as string,
    data: JSON.parse(row.data as string),
    source: JSON.parse(row.source as string),
    confidence: row.confidence as number,
    tags: JSON.parse(row.tags as string),
    status: row.status as MemoryRecord["status"],
    ...(row.supersedes ? { supersedes: JSON.parse(row.supersedes as string) } : {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...(row.effective_at ? { effectiveAt: row.effective_at as string } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}),
  }
}

function tokensFor(rec: MemoryRecord): string[] {
  const values = Object.values(rec.data).filter((v) => typeof v === "string") as string[]
  return tokenize([rec.content, rec.tags.join(" "), values.join(" ")].join(" "))
}

export function sqliteMemoryStore(opts: { path: string }): MemoryStore {
  const db = openDb(opts.path)
  runMigrations(db, MIGRATIONS)

  function reindex(rec: MemoryRecord): void {
    db.prepare("DELETE FROM memory_tokens WHERE memory_id = ?").run(rec.id)
    const ins = db.prepare("INSERT INTO memory_tokens(memory_id, token) VALUES (?, ?)")
    for (const t of tokensFor(rec)) ins.run(rec.id, t)
  }

  return {
    async put(rec) {
      db.prepare(
        `INSERT OR REPLACE INTO memories
         (id,kind,namespace,content,data,source,confidence,tags,status,supersedes,created_at,updated_at,effective_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        rec.id, rec.kind, rec.namespace, rec.content, JSON.stringify(rec.data),
        JSON.stringify(rec.source), rec.confidence, JSON.stringify(rec.tags), rec.status,
        rec.supersedes ? JSON.stringify(rec.supersedes) : null,
        rec.createdAt, rec.updatedAt, rec.effectiveAt ?? null, rec.expiresAt ?? null,
      )
      reindex(rec)
    },
    async get(id) {
      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined
      return row ? rowToRecord(row) : null
    },
    async search(q: MemoryQuery) {
      const status = q.status ?? "active"
      const limit = q.limit ?? 8
      const terms = q.query ? tokenize(q.query) : []
      const params: unknown[] = [q.namespace, status]
      let sql = `SELECT m.* FROM memories m WHERE m.namespace = ? AND m.status = ?`
      if (q.kind) { sql += ` AND m.kind = ?`; params.push(q.kind) }
      if (terms.length > 0) {
        const placeholders = terms.map(() => "?").join(",")
        sql += ` AND m.id IN (SELECT memory_id FROM memory_tokens WHERE token IN (${placeholders}))`
        params.push(...terms)
      }
      sql += ` ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`
      params.push(limit)
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
      let records = rows.map(rowToRecord)
      if (q.tags && q.tags.length > 0) {
        const want = new Set(q.tags)
        records = records.filter((r) => r.tags.some((t) => want.has(t)))
      }
      return records
    },
    async update(id, patch) {
      const current = await this.get(id)
      if (!current) throw new Error(`memory not found: ${id}`)
      const next = { ...current, ...patch, id, updatedAt: patch.updatedAt ?? new Date(0).toISOString() }
      // NOTE: updatedAt must be supplied by the caller; do not call Date.now() here (determinism).
      await this.put(next as MemoryRecord)
    },
    async supersede(id, bySupersedingId) {
      const old = await this.get(id)
      if (!old) throw new Error(`memory not found: ${id}`)
      db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(id)
      const superseding = await this.get(bySupersedingId)
      if (superseding) {
        const links = new Set([...(superseding.supersedes ?? []), id])
        db.prepare("UPDATE memories SET supersedes = ? WHERE id = ?").run(
          JSON.stringify([...links]), bySupersedingId,
        )
      }
    },
    async delete(id) {
      db.prepare("DELETE FROM memories WHERE id = ?").run(id)
    },
    async listCandidates(namespacePrefix) {
      const rows = db.prepare(
        "SELECT * FROM memories WHERE status = 'candidate' AND namespace LIKE ? ORDER BY created_at DESC",
      ).all(`${namespacePrefix}%`) as Record<string, unknown>[]
      return rows.map(rowToRecord)
    },
  }
}
```

NOTE for the implementer: `update()`'s `updatedAt` must come from the caller — Dawn forbids `Date.now()`/`new Date()` in library code for determinism (see other packages). The `new Date(0)` fallback above is a placeholder guard; callers always pass `updatedAt`. If `tsc` flags the `this` usage inside object-literal methods, hoist `get`/`put` into local `const` functions and call those (mirror how `aimock-runner.ts` hoists `getRecordingsSince`).

- [ ] **Step 4: Run → PASS** (5 tests). Barrel: `export { sqliteMemoryStore } from "./sqlite-store.js"`.

- [ ] **Step 5: Run full package + lint**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/memory test && pnpm --filter @dawn-ai/memory run lint`
Expected: green, 0 lint errors.

- [ ] **Step 6: Commit** `feat(memory): sqliteMemoryStore (node:sqlite, tokenized keyword recall)`

---

## PHASE 3 — `defineMemory` + typegen + `remember`/`recall` tools (semantic)

### Task 3.1: `defineMemory` in `@dawn-ai/sdk`

**Files:** Create `packages/sdk/src/memory.ts`; export from `packages/sdk/src/index.ts`; Test `packages/sdk/test/memory.test.ts`. First read an existing `define*` (e.g. how `agent()`/config is defined) with `grep -rn "export function define\|export function agent" packages/sdk/src` to match the style.

- [ ] **Step 1: Failing test**

```ts
// packages/sdk/test/memory.test.ts
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineMemory } from "../src/memory.js"

describe("defineMemory", () => {
  it("returns the descriptor with kind, scope, and schema", () => {
    const schema = z.object({ subject: z.string(), predicate: z.string(), value: z.string() })
    const m = defineMemory({ kind: "semantic", scope: ["workspace", "route"], schema })
    expect(m.kind).toBe("semantic")
    expect(m.scope).toEqual(["workspace", "route"])
    expect(m.schema).toBe(schema)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
// packages/sdk/src/memory.ts
import type { z } from "zod"

export type MemoryScopeDimension = "workspace" | "route" | "tenant" | "user" | "agent"

export interface DefinedMemory<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly kind: "semantic" | "episodic" | "procedural" | "reflection"
  readonly scope: readonly MemoryScopeDimension[]
  readonly schema: S
  /** Identity keys for write reconciliation; defaults to ["subject","predicate"] for semantic. */
  readonly identity?: readonly string[]
}

/** Declare a route's typed long-term memory. Place in `memory.ts` next to index.ts. */
export function defineMemory<S extends z.ZodTypeAny>(def: {
  kind: DefinedMemory["kind"]
  scope: readonly MemoryScopeDimension[]
  schema: S
  identity?: readonly string[]
}): DefinedMemory<S> {
  return { kind: def.kind, scope: def.scope, schema: def.schema, ...(def.identity ? { identity: def.identity } : {}) }
}
```

- [ ] **Step 4: Run → PASS.** Export `defineMemory` + `DefinedMemory`/`MemoryScopeDimension` from `packages/sdk/src/index.ts`.

- [ ] **Step 5: Commit** `feat(sdk): defineMemory descriptor`

### Task 3.2: Loader for a route's `memory.ts`

**Files:** Create `packages/cli/src/lib/runtime/load-memory.ts`; Test `packages/cli/test/load-memory.test.ts`. Mirror `packages/cli/src/lib/runtime/load-evals.ts`'s tsx-import + default-export validation (read it first).

- [ ] **Step 1: Failing test** (build a temp route dir with a `memory.ts`, assert it loads the descriptor). Mirror `load-evals.test.ts`'s temp-app/symlink setup.

```ts
// packages/cli/test/load-memory.test.ts — sketch; mirror load-evals.test.ts setup exactly
// Build a temp dir with memory.ts exporting `defineMemory({kind:'semantic',scope:['route'],schema:z.object({subject:z.string()})})`,
// then: const def = await loadRouteMemory(join(dir, "memory.ts"));
// expect(def.kind).toBe("semantic"); expect(def.scope).toEqual(["route"]).
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** `loadRouteMemory(memoryFile): Promise<DefinedMemoryShape>` using `registerTsxLoader()` + `import(pathToFileURL(file).href)` (exact pattern from `load-evals.ts`). Use a LOCAL structural type (do NOT import `@dawn-ai/sdk` types into the CLI — same cycle-avoidance rule as `load-evals.ts`):

```ts
// packages/cli/src/lib/runtime/load-memory.ts
import { pathToFileURL } from "node:url"
import { registerTsxLoader } from "./register-tsx-loader.js"

export interface LoadedRouteMemory {
  readonly kind: "semantic" | "episodic" | "procedural" | "reflection"
  readonly scope: readonly string[]
  readonly schema: unknown            // a zod schema; structurally validated at use sites
  readonly identity?: readonly string[]
}

export async function loadRouteMemory(memoryFile: string): Promise<LoadedRouteMemory> {
  await registerTsxLoader()
  const mod = (await import(pathToFileURL(memoryFile).href)) as { default?: unknown }
  const def = mod.default
  if (!def || typeof def !== "object") {
    throw new Error(`Memory file ${memoryFile} must default-export defineMemory(...)`)
  }
  const d = def as Record<string, unknown>
  if (typeof d.kind !== "string" || !Array.isArray(d.scope) || !d.schema) {
    throw new Error(`Memory file ${memoryFile} default export is not a valid defineMemory descriptor`)
  }
  return d as unknown as LoadedRouteMemory
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(cli): loadRouteMemory loader`

### Task 3.3: `memory` capability — `remember`/`recall` tools

**Files:** Create `packages/core/src/capabilities/built-in/memory.ts`; Test `packages/core/test/capabilities/memory.test.ts`. This is the L3 capability. It needs the `MemoryStore` + the route's `DefinedMemory` (schema, scope, identity) + a resolved namespace; these come via `CapabilityMarkerContext`. **Extend `CapabilityMarkerContext`** (in `packages/core/src/capabilities/types.ts`) with an optional `memory?: { store: MemoryStore; defined?: DefinedMemoryLike; namespace: string; writes: "off"|"candidate"|"auto" }` field (use a LOCAL structural type `DefinedMemoryLike` to avoid importing sdk's zod-typed `DefinedMemory`; the marker validates `data` against `defined.schema` via a passed-in `validate` fn or `schema.safeParse`).

Design note: to keep `@dawn-ai/core` from depending on `@dawn-ai/memory`/zod-runtime coupling, the context provides an already-constructed `store`, the resolved `namespace`, the `writes` mode, and a `validate(data) => {ok,errors?}` closure (the CLI builds it from the route's zod schema). The capability is pure orchestration.

- [ ] **Step 1: Failing test** (inject a fake in-memory store + a passthrough validate; assert `recall` returns scoped rows and `remember` in `candidate` mode writes status candidate)

```ts
// packages/core/test/capabilities/memory.test.ts
import { describe, expect, it } from "vitest"
import { createMemoryMarker } from "../../src/capabilities/built-in/memory.js"

function fakeStore() {
  const rows: any[] = []
  return {
    rows,
    async put(r: any) { rows.push(r) },
    async get(id: string) { return rows.find((r) => r.id === id) ?? null },
    async search(q: any) { return rows.filter((r) => r.namespace === q.namespace && (r.status ?? "active") === (q.status ?? "active")) },
    async update() {}, async supersede() {}, async delete() {},
    async listCandidates() { return [] },
  }
}

const baseCtx = (store: any) => ({
  routeManifest: {} as never, descriptor: undefined, appRoot: "/x",
  memory: {
    store, namespace: "ws=a|route=/r", writes: "candidate" as const,
    defined: { kind: "semantic", scope: ["route"], identity: ["subject", "predicate"] },
    validate: (data: unknown) => ({ ok: true as const, value: data }),
  },
})

describe("memory capability", () => {
  it("does not activate without context.memory", async () => {
    expect(await createMemoryMarker().detect("/r", { routeManifest: {} as never, descriptor: undefined, appRoot: "/x" })).toBe(false)
  })

  it("contributes recall + remember tools and a memory-index fragment", async () => {
    const store = fakeStore()
    const marker = createMemoryMarker()
    expect(await marker.detect("/r", baseCtx(store))).toBe(true)
    const c = await marker.load("/r", baseCtx(store))
    expect(c.tools?.map((t) => t.name).sort()).toEqual(["recall", "remember"])
    expect(c.promptFragment).toBeDefined()
  })

  it("remember writes a candidate row in candidate mode", async () => {
    const store = fakeStore()
    const c = await createMemoryMarker().load("/r", baseCtx(store))
    const remember = c.tools!.find((t) => t.name === "remember")!
    await remember.run({ data: { subject: "billing", predicate: "escalate", value: "500" }, content: "esc" }, { signal: new AbortController().signal })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].status).toBe("candidate")
    expect(store.rows[0].namespace).toBe("ws=a|route=/r")
  })

  it("recall returns namespace-scoped active rows", async () => {
    const store = fakeStore()
    store.rows.push({ id: "m1", namespace: "ws=a|route=/r", status: "active", content: "x", data: {}, kind: "semantic", tags: [] })
    const c = await createMemoryMarker().load("/r", baseCtx(store))
    const recall = c.tools!.find((t) => t.name === "recall")!
    const out = (await recall.run({ query: "x" }, { signal: new AbortController().signal })) as any
    expect(out).toContain("m1")
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement.** Add the `memory?` field + a `MemoryStoreLike`/`DefinedMemoryLike`/`validate` structural types to `capabilities/types.ts`. Then `createMemoryMarker()`:
  - `detect`: `context.memory !== undefined`.
  - `load`: build `recall` (calls `store.search({namespace, query, kind, tags, limit})`, returns a compact string of `id` + `content`) and `remember` (validates `input.data` via `context.memory.validate`; constructs a `MemoryRecord` with the resolved `namespace`, `status = writes === "auto" ? "active" : "candidate"`, `id` from a content hash of `namespace+identity` — deterministic, NO `Date.now()`; `createdAt/updatedAt` from an injected clock in context or a fixed value the CLI passes). Provide a `promptFragment` rendering a bounded memory-index (subjects/tags of the in-scope active memories — fetched once at load via `store.search({namespace, limit: indexMax})`, then rendered).
  - **Determinism:** the marker must not call `Date.now()`/`new Date()`. The CLI passes `context.memory.now: string` (an ISO timestamp captured per request) used for `createdAt`/`updatedAt`. The id is `memory_<sha1(namespace + JSON.stringify(identityValues))>` via `node:crypto` (deterministic given inputs). Include the full implementation in this file.

  (Full code: ~120 lines. The implementer writes it against the test above + the structural context types. Key shapes: tool `run(input, ctx)` returns a string; `recall` output format `"<id>: <content>"` joined by newlines; `remember` returns a short confirmation string. Mirror `skills.ts` tool/promptFragment structure.)

- [ ] **Step 4: Run → PASS** (4 tests). `pnpm --filter @dawn-ai/core run lint` clean.

- [ ] **Step 5: Commit** `feat(core): memory capability — remember/recall tools + index fragment`

### Task 3.4: Typegen `MEMORY_EXTRA_TOOLS` + detection

**Files:** Modify `packages/cli/src/lib/typegen/run-typegen.ts`; Test extend `packages/cli/test/*typegen*` (find with `ls packages/cli/test | grep -i typegen`).

- [ ] **Step 1: Failing test** — assert that a route dir containing `memory.ts` yields generated `remember` and `recall` tool types whose input reflects the route's zod schema. Mirror the existing typegen test's route-fixture setup.

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement.** Add a `hasMemory(routeDir)` (`existsSync(join(routeDir, "memory.ts"))`) and, when present, load the route's schema (via a lightweight read — typegen can render the input type from the route's zod schema using the existing zod→TS rendering used for tools, OR, simplest for v1: render `remember` input as `{ data: <SchemaTS>; content: string; tags?: string[]; confidence?: number }` and `recall` output as `string`, where `<SchemaTS>` is produced by reusing the tool zod-rendering path). For v1 keep it pragmatic:

```ts
const MEMORY_EXTRA_TOOLS: readonly ExtractedToolType[] = [
  {
    name: "remember",
    description: "Store a typed long-term memory for later recall.",
    inputType: `{ data: Record<string, unknown>; content: string; tags?: string[]; confidence?: number }`,
    outputType: `string`,
  },
  {
    name: "recall",
    description: "Recall typed long-term memories by keyword/kind/tags.",
    inputType: `{ query?: string; kind?: string; tags?: string[]; limit?: number }`,
    outputType: `string`,
  },
]
```

Add detection alongside the others:

```ts
if (hasMemory(route.routeDir)) {
  extraTools.push(...MEMORY_EXTRA_TOOLS)
}
```

(Typing `data` precisely to the route's zod schema — instead of `Record<string, unknown>` — is a deferred refinement; note it in a code comment. The runtime `remember` still validates against the real schema, so this is type-surface-only.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(cli): typegen MEMORY_EXTRA_TOOLS`

### Task 3.5: Wire the `memory` capability in `execute-route.ts`

**Files:** Modify `packages/cli/src/lib/runtime/execute-route.ts`. Build `context.memory` per request: resolve the store (Task 4.1's resolver, stubbed as default sqlite here), load the route's `memory.ts` (`loadRouteMemory`), compute the namespace from scope + resolved dimensions (workspace=appRoot basename or config; route=routePath), construct `validate` from the route's zod schema (`schema.safeParse`), pass `writes` from config (default `candidate`), and `now` (ISO string captured at request start). Register `createMemoryMarker()` in the registry array.

- [ ] **Step 1:** Add `createMemoryMarker` to the registry array (after `createMemoryMdMarker()`).
- [ ] **Step 2:** In the capability-context construction, when the route has `memory.ts`, build the `memory` context field. Place the timestamp capture (`const now = new Date(...)` — allowed in the CLI runtime, which is not determinism-constrained library code; the request handler may use wall-clock) and pass `now: now.toISOString()`.
- [ ] **Step 3:** Verify with an in-process harness test (Phase 6 covers the full e2e; here just confirm `pnpm --filter @dawn-ai/cli exec tsc -b tsconfig.build.json` is clean and existing runtime tests pass).
- [ ] **Step 4: Commit** `feat(cli): wire memory capability into execute-route`

---

## PHASE 4 — Write governance + `DawnConfig.memory` + resolver

### Task 4.1: `DawnConfig.memory` + `resolveMemoryStore`

**Files:** Modify `packages/core/src/types.ts` (`DawnConfig`); Create `packages/cli/src/lib/runtime/resolve-memory.ts` (mirror `resolveThreadsStore` in `execute-route.ts`); Test `packages/cli/test/resolve-memory.test.ts`.

- [ ] **Step 1:** Add to `DawnConfig`:

```ts
readonly memory?: {
  readonly enabled?: boolean
  readonly store?: import("@dawn-ai/memory").MemoryStore
  readonly writes?: "off" | "candidate" | "auto"
  readonly indexMaxEntries?: number
  readonly resolveScope?: (ctx: { readonly routePath: string; readonly appRoot: string }) => Record<string, string>
}
```

(Confirm `@dawn-ai/core` may type-reference `@dawn-ai/memory` — add it as a `devDependency`/`peerDependency` + tsconfig reference if needed; if it creates a cycle, inline a structural `MemoryStore` type in core instead, mirroring how `threadsStore`/`checkpointer` are typed.)

- [ ] **Step 2:** Failing test for `resolveMemoryStore(appRoot)`: returns the config's `store` when set, else a default `sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })`. Mirror `resolveThreadsStore`'s test.

- [ ] **Step 3:** Implement `resolveMemoryStore` + a `resolveMemoryWrites(appRoot)` (config `writes` ?? `"candidate"`).

- [ ] **Step 4: Run → PASS.** Wire the resolver into `execute-route.ts`'s memory-context construction (replace the Task 3.5 stub).

- [ ] **Step 5: Commit** `feat(core,cli): DawnConfig.memory + resolveMemoryStore`

### Task 4.2: Reconciliation + permissions-gated `auto` writes

**Files:** Modify `packages/core/src/capabilities/built-in/memory.ts`; Test extend `memory.test.ts`.

- [ ] **Step 1:** Failing tests: (a) `remember` of a contradicting value supersedes the prior active row (uses `classifyWrite` semantics — the capability calls `store.search` for candidates then `store.supersede`); (b) in `writes:"auto"` mode with a `permissions` gate in context, the first write triggers an interrupt (assert the capability calls the permissions gate). For (b), inject a fake `permissions` with a `gate` spy.

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3:** Implement: `remember` fetches top-N namespace matches (`store.search({namespace, query: content, status: "active", limit: 10})`), runs `classifyWrite(incoming, matches, identityKeys)`, and applies ADD (`put`), UPDATE (`update` with new `updatedAt = now`), or SUPERSEDE (`put` new active + `supersede(oldId, newId)`). In `auto` mode, route the write through `context.permissions` HITL (mirror how the workspace capability gates `runBash`/path writes — read `packages/core/src/capabilities/built-in/` workspace gating or `@dawn-ai/permissions` usage). In `candidate` mode, always write `status:"candidate"` (no reconciliation/supersede until approval).

- [ ] **Step 4: Run → PASS.** Lint clean.

- [ ] **Step 5: Commit** `feat(core): memory write reconciliation + permissions-gated auto writes`

---

## PHASE 5 — `dawn memory` CLI

### Task 5.1: `dawn memory` command

**Files:** Create `packages/cli/src/commands/memory.ts`; register in the CLI program (find the registration site with `grep -rn "registerEvalCommand\|\.command(" packages/cli/src/index.ts`); Test `packages/cli/test/memory-command.test.ts`. Mirror `packages/cli/src/commands/eval.ts` structure (commander subcommand + `CommandIo`).

- [ ] **Step 1:** Failing test: build a temp app with a seeded `.dawn/memory.sqlite` (use `sqliteMemoryStore` directly to insert a candidate), then `runMemoryCommand(["list"], {cwd}, io)` prints the candidate; `runMemoryCommand(["approve", id], ...)` flips status to `active`. Mirror `eval-command.test.ts`'s temp-app + `CommandIo` capture.

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3:** Implement subcommands `list` (all active+candidate in the app's store), `search <query>`, `inspect <id>`, `approve <id>` (candidate→active, with reconciliation/supersede applied at approval time), `reject <id>` (delete the candidate), `forget <id>` (hard delete). Resolve the store via `resolveMemoryStore(appRoot)`. Use `findDawnApp` to locate appRoot (mirror `load-evals`).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(cli): dawn memory command (list/search/inspect/approve/reject/forget)`

---

## PHASE 6 — Testing helpers, evals, dogfood

### Task 6.1: `seedMemory` in `@dawn-ai/testing`

**Files:** Create `packages/testing/src/memory.ts`; export from barrel; Test `packages/testing/test/memory-seed.test.ts`.

- [ ] **Step 1:** Failing test: `seedMemory(store, [records])` inserts rows retrievable via `store.search`. Accept either a `MemoryStore` or a `{ path }` (constructs `sqliteMemoryStore`).

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3:** Implement `seedMemory(target, records)`: if `target` has a `.put`, use it; else `sqliteMemoryStore(target)`. Fill record defaults (status `active`, confidence 1, tags [], timestamps from a fixed ISO the caller may override). Re-export `sqliteMemoryStore`/types from `@dawn-ai/memory` for convenience.

- [ ] **Step 4: Run → PASS.** Add `@dawn-ai/memory` to `@dawn-ai/testing` deps.

- [ ] **Step 5: Commit** `feat(testing): seedMemory helper`

### Task 6.2: Memory eval scorers

**Files:** Create `packages/evals/src/scorers/memory.ts`; export from the scorers barrel; Test `packages/evals/test/memory-scorers.test.ts`.

- [ ] **Step 1:** Failing tests for three pure scorers operating on an `AgentRunResult` + expectation:
  - `memoryRecalled(expectedIds)` — score 1 if the run's `recall` tool output contained all expected ids.
  - `memoryFresh(subject, expectedValue)` — score 1 if the final message reflects the newer value.
  - `memoryIsolated(forbiddenSubstring)` — score 0 if the run leaked the forbidden (other-namespace) content.

  (These build on the existing scorer signature — read `packages/evals/src/scorers/` for the `(run, testCase) => Score` shape and a built-in like `contains` to mirror.)

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3:** Implement the three scorers mirroring `contains`/`toolCalled`.

- [ ] **Step 4: Run → PASS.** Export from the scorers barrel.

- [ ] **Step 5: Commit** `feat(evals): memory recall/fresh/isolation scorers`

### Task 6.3: End-to-end aimock test (recall + remember)

**Files:** Create `packages/testing/test/memory-e2e.test.ts` using the probe-app pattern. Add a `memory.ts` + a route to the probe app (`packages/testing/test/fixtures/probe-app/src/app/chat/memory.ts` exporting `defineMemory`). Seed a memory, script the agent to call `recall`, assert the answer reflects it; then script a `remember` and assert a candidate row exists.

- [ ] **Step 1:** Write the e2e test with `script()` fixtures (agent calls `recall({query:"escalate"})` → tool returns the seeded memory → agent replies using it). Seed via `seedMemory({path: <appRoot>/.dawn/memory.sqlite}, [...])` before `h.run`.
- [ ] **Step 2: Run → FAIL** (capability not yet wired into the harness route — ensure the probe route has `memory.ts`).
- [ ] **Step 3:** Make it pass (the wiring from Phases 3–4 should already support it; fix any gaps).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `test(testing): memory recall/remember e2e (aimock)`

### Task 6.4: Dogfood in the research template + docs + changeset

**Files:** Add `packages/devkit/templates/app-research/src/app/research/memory.ts` (a `defineMemory` semantic schema) + a route-local `memory.md` + a memory eval under `evals/`. Add a docs page `apps/web/content/docs/memory.mdx` (register: nav entry in `apps/web/app/components/docs/nav.ts` + `app/docs/memory/page.tsx` + the `.mdx`). Add `.changeset/long-term-memory.md` (`@dawn-ai/memory` minor/new + `@dawn-ai/core`/`@dawn-ai/cli`/`@dawn-ai/sdk`/`@dawn-ai/testing`/`@dawn-ai/evals` patch — but per GOTCHA 6, declare all as **patch** to keep the fixed group on a patch).

- [ ] **Step 1:** Add the template files (a small semantic `memory.ts`, a `memory.md`, a `memory.eval.ts` using the new scorers). Confirm the generated-app harness still builds with `--template research`.
- [ ] **Step 2:** Write `memory.mdx` documenting the three layers, `defineMemory`, `remember`/`recall`, write modes, scoping, and the `dawn memory` CLI. Run `node scripts/check-docs.mjs` until it passes (register the page in all 3 places; document any new CLI command in `cli.mdx` too — check-docs drives from the compiled CLI options).
- [ ] **Step 3:** Add the changeset (all packages **patch**).
- [ ] **Step 4:** Commit `docs+test(memory): research-template dogfood, docs page, changeset`

### Task 6.5: Full validate + PR

- [ ] **Step 1:** `cd /Users/blove/repos/dawn && pnpm ci:validate` → green (build, typecheck, lint, tests, docs check). Fix failures. Per the release-harness memory: if the generated-app harness 404s on `@dawn-ai/memory`, add it to `SCAFFOLD_PACKAGES` in `test/harness/scaffold-packaging.ts` and list it as a direct dep where required (see `project_release_harness_workspace_dep`).
- [ ] **Step 2:** Push + open PR:

```bash
cd /Users/blove/repos/dawn
git push -u origin feat/long-term-memory
gh pr create --base main --head feat/long-term-memory \
  --title "feat: long-term memory (typed collection + route memory.md)" \
  --body "Implements the long-term memory design (docs/superpowers/specs/2026-06-18-long-term-memory-design.md): route-local memory.md, a typed @dawn-ai/memory collection store on node:sqlite with deterministic tokenized keyword+recency recall, generated remember/recall tools via defineMemory + typegen, candidate-default write governance, namespace scoping, a dawn memory CLI, seedMemory + memory eval scorers, and a research-template dogfood. Ships the semantic kind; episodic/procedural/reflection, vectors, graph, and the dev inspector UI are deferred.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3:** Update phase memory (`project_phase_status.md`): long-term memory shipped — layers + @dawn-ai/memory + defineMemory/typegen + candidate governance + dawn memory CLI.

---

## Self-Review

**Spec coverage:** L1 (existing, untouched) ✓; L2 route memory.md → Task 1.1–1.2 ✓; L3 collection → Phases 2–4 ✓; `MemoryRecord`/store → 2.2/2.6 ✓; tokenized recall (no FTS5) → 2.3/2.6 ✓; `defineMemory` + typegen → 3.1/3.4 ✓; remember/recall tools → 3.3 ✓; memory-index fragment → 3.3 ✓; write governance (candidate default, auto+permissions, reconciliation) → 3.3/4.2 ✓; namespace scoping + isolation → 2.4/2.6/3.5 ✓; `DawnConfig.memory` + resolver → 4.1 ✓; `dawn memory` CLI → 5.1 ✓; seedMemory + evals → 6.1/6.2 ✓; e2e + dogfood → 6.3/6.4 ✓; deferrals respected (semantic kind only; no vectors/graph/inspector) ✓.

**Placeholder scan:** Tasks 3.3 and 3.4 reference "render the route's zod schema" pragmatically (v1 uses `Record<string, unknown>` for the `data` type surface, runtime validates against the real schema) — this is an explicit, documented v1 simplification, not a gap. Tasks 6.1–6.4 reference mirroring concrete existing files (`eval.ts`, `load-evals.ts`, scorers, typegen test, research template) with exact patterns shown elsewhere in the plan — acceptable for integration tasks whose boilerplate depends on current files the implementer must read first. All novel/pure logic (Phases 1–2, 3.1–3.2, 4.x core) carries complete code.

**Type consistency:** `MemoryRecord`/`MemoryQuery`/`MemoryStore` (2.2) are used consistently in 2.6/3.3/4.x/6.x. `serializeNamespace`/`MemoryScopeTuple` (2.4) reused in 3.5. `classifyWrite`/`WriteOp` (2.5) reused in 4.2. `sqliteMemoryStore` (2.6) reused in 4.1/5.1/6.1. `defineMemory`/`DefinedMemory` (3.1) ↔ `loadRouteMemory`/`LoadedRouteMemory` structural mirror (3.2) ↔ `context.memory` structural field (3.3). `MEMORY_EXTRA_TOOLS` names (`remember`/`recall`) match the capability tool names (3.3). Consistent.
