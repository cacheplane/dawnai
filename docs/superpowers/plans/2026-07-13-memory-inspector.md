# Memory Inspector (`@dawn-ai/inspector`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@dawn-ai/inspector` — a Next.js panel-based runtime-inspection app (Memory panel first) launched by `dawn inspect` — plus the required `MemoryStore.browse`/`stats` methods, `approveWithReconcile`, and scaffold/docs wiring.

**Architecture:** A new Next.js (app-router, React 19, `output: "standalone"`) package resolves the app's **live** `MemoryStore` in-process via `loadDawnConfig` (tsx loader; `serverExternalPackages` keeps user TS out of the bundle). Next route handlers are the JSON API; `@pretable/react` renders the grid, shadcn-style components the chrome. Store reads use two new REQUIRED `MemoryStore` methods (`browse`, `stats`); approve uses a new pure `approveWithReconcile` in `@dawn-ai/memory` (the capability is untouched).

**Tech Stack:** Next.js 16 / React 19 / Tailwind v4, `@pretable/react@0.0.2` + `@pretable/ui`, radix + cva (shadcn-style), `@dawn-ai/memory` (node:sqlite), vitest (+ RTL/jsdom for components).

**Spec:** `docs/superpowers/specs/2026-07-13-memory-inspector-design.md` — read it first.

**Working rules (from repo memory):**
- Branch-pin before every commit: `git rev-parse --abbrev-ref HEAD` must print `feat/memory-inspector`.
- Never bare `biome check --write`; lint via each package's `pnpm --filter <pkg> lint`.
- Changesets in the fixed 0.x group are always **patch** (a `minor` inflates the group to 1.0.0).
- All commands run from the worktree root `/Users/blove/repos/dawn/.claude/worktrees/memory-inspector` unless stated.

---

## File map (what gets created/modified where)

| Area | Files |
|---|---|
| Store API | `packages/memory/src/types.ts` (BrowseQuery/BrowsePage/MemoryStats + methods), `packages/memory/src/sqlite-store.ts`, `packages/memory/src/namespace.ts` (parseNamespace + routeNamespaceKey), `packages/memory/src/reconcile.ts` (approveWithReconcile), `packages/memory/src/index.ts` |
| pgvector | `packages/memory-pgvector/src/pgvector-store.ts`, `packages/memory-pgvector/src/queries.ts` |
| Conformance | `packages/testing/src/memory-conformance.ts` |
| Core types | `packages/core/src/capabilities/types.ts` (MemoryStoreLike unified) |
| CLI | `packages/cli/src/commands/inspect.ts` (new), `packages/cli/src/commands/memory.ts` (approve rewire, cast removal), `packages/cli/src/lib/runtime/resolve-memory.ts` (routeNamespaceKey re-import), `packages/cli/src/index.ts` |
| Inspector | `packages/inspector/**` (new package: Next app + API + UI + e2e) |
| Scaffold | `SCAFFOLD_PACKAGES` (locate via grep in `test/generated/`), `packages/devkit/templates/*/package.json.template`, `packages/create-dawn-app/src/index.ts`, `packages/devkit/src/testing/generated-app.ts`, `test/generated/*.expected.json` |
| Docs | `apps/web/content/docs/inspector.mdx` (+ `app/docs/inspector/page.tsx`, nav), `apps/web/content/docs/upgrading.mdx`, `apps/web/content/docs/memory.mdx` |
| Example | `examples/memory/server/package.json` |
| CI | `.github/workflows/ci.yml` (inspector e2e lane) |

---

### Task 1: Spike — prove live-store resolution through `next build` (top integration risk)

**Files:**
- Create: `packages/inspector/package.json`, `packages/inspector/next.config.ts`, `packages/inspector/tsconfig.json`, `packages/inspector/postcss.config.mjs`, `packages/inspector/app/layout.tsx`, `packages/inspector/app/globals.css`, `packages/inspector/app/healthz/route.ts`, `packages/inspector/app/api/memory/list/route.ts` (spike version), `packages/inspector/src/store/resolve.ts`, `packages/inspector/scripts/post-build.mjs`, `packages/inspector/test/fixtures/app/dawn.config.ts`, `packages/inspector/test/fixtures/app/src/app/notes/index.ts`, `packages/inspector/test/fixtures/app/src/app/notes/memory.ts`, `packages/inspector/test/spike.e2e.test.ts`, `packages/inspector/vitest.config.ts`
- Modify: `pnpm-workspace.yaml` only if `packages/*` isn't already the glob (it is — verify, don't edit).

The spike ships REAL package skeleton files that later tasks build on — nothing throwaway.

- [ ] **Step 1: Package skeleton**

`packages/inspector/package.json`:
```json
{
  "name": "@dawn-ai/inspector",
  "version": "0.8.11",
  "private": false,
  "type": "module",
  "license": "MIT",
  "description": "Dawn runtime inspector — browser UI for inspecting a Dawn app (memory panel).",
  "dawnInspector": { "server": ".next/standalone/packages/inspector/server.js" },
  "files": [".next/standalone", "README.md"],
  "scripts": {
    "build": "next build && node scripts/post-build.mjs",
    "dev": "next dev",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src app test",
    "test": "vitest --run --config vitest.config.ts --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dawn-ai/core": "workspace:*",
    "@dawn-ai/memory": "workspace:*",
    "next": "^16.1.1",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@types/node": "^25.6.0",
    "@types/react": "^19.2.0",
    "tailwindcss": "^4.1.0",
    "@tailwindcss/postcss": "^4.1.0",
    "typescript": "5.8.3",
    "vitest": "^4.1.9",
    "zod": "^4.4.3"
  }
}
```
(Match the exact `next`/`react` versions used by `examples/chat/web/package.json` — read it and mirror. `zod` is needed by the fixture's `defineMemory` route.)

`packages/inspector/next.config.ts`:
```ts
import { join } from "node:path"
import type { NextConfig } from "next"

const config: NextConfig = {
  output: "standalone",
  // Trace from the monorepo root so pnpm-linked workspace deps are copied into
  // the standalone bundle (server.js lands at .next/standalone/packages/inspector/).
  outputFileTracingRoot: join(import.meta.dirname, "../.."),
  // The app's dawn.config.ts (arbitrary user TS) is loaded at RUNTIME through
  // these packages — they must stay require()-able from node_modules, never bundled.
  serverExternalPackages: ["@dawn-ai/core", "@dawn-ai/memory", "tsx", "typescript"],
}
export default config
```

`packages/inspector/tsconfig.json`:
```json
{
  "extends": "@dawn-ai/config-typescript/base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "module": "esnext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "types": ["node", "react"]
  },
  "include": ["app", "src", "test", "next.config.ts", "vitest.config.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "test/fixtures"]
}
```
(If `@dawn-ai/config-typescript/base.json` sets options incompatible with Next — e.g. `module: nodenext` is overridden above — that's fine; mirror how `examples/chat/web/tsconfig.json` does it and copy its shape if simpler.)

`packages/inspector/postcss.config.mjs`:
```js
export default { plugins: { "@tailwindcss/postcss": {} } }
```

`packages/inspector/app/globals.css`:
```css
@import "tailwindcss";
```

`packages/inspector/app/layout.tsx`:
```tsx
import "./globals.css"
import type { ReactNode } from "react"

export const metadata = { title: "Dawn Inspector" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-zinc-800 antialiased">{children}</body>
    </html>
  )
}
```

`packages/inspector/app/healthz/route.ts`:
```ts
export const dynamic = "force-dynamic"

export function GET(): Response {
  return Response.json({ status: "ready" })
}
```

- [ ] **Step 2: The resolver (the thing the spike proves)**

`packages/inspector/src/store/resolve.ts`:
```ts
import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadDawnConfig } from "@dawn-ai/core"
import { type MemoryStore, sqliteMemoryStore } from "@dawn-ai/memory"

export interface ResolvedStore {
  readonly store: MemoryStore
  /** Present when config.memory.vector.embedder is configured; used for hybrid search. */
  readonly embedder?: { id: string; dims: number; embed(texts: readonly string[]): Promise<Float32Array[]> }
  readonly appRoot: string
}

let cached: Promise<ResolvedStore> | undefined

/** Resolve the app's LIVE MemoryStore once per server process. */
export function resolveStore(): Promise<ResolvedStore> {
  cached ??= doResolve()
  return cached
}

async function doResolve(): Promise<ResolvedStore> {
  const appRoot = process.env.DAWN_APP_ROOT
  if (!appRoot) throw new Error("DAWN_APP_ROOT env var is required to start the Dawn inspector")
  const configPath = join(appRoot, "dawn.config.ts")
  if (!existsSync(configPath)) {
    // Genuinely absent → default store, same as the CLI's resolveMemoryStore.
    return { store: defaultStore(appRoot), appRoot }
  }
  // Present but broken must THROW (actionable), not silently fall back.
  const loaded = await loadDawnConfig({ appRoot })
  const memory = loaded.config.memory
  const configured = memory?.store as MemoryStore | undefined
  const store =
    configured ??
    sqliteMemoryStore({
      path: join(appRoot, ".dawn", "memory.sqlite"),
      ...(memory?.recall ? { recall: memory.recall } : {}),
    })
  const embedder = memory?.vector?.embedder
  return { store, ...(embedder ? { embedder } : {}), appRoot }
}

function defaultStore(appRoot: string): MemoryStore {
  return sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") })
}
```
(`sqliteMemoryStore`'s option types: check `packages/memory/src/sqlite-store.ts` — pass `recall` only if the signature matches; if the `vector` tuning option exists, thread `memory.vector` fields the way `packages/cli/src/lib/runtime/resolve-memory.ts:46-78` does. Copy that exact tuning-threading block.)

Spike API route `packages/inspector/app/api/memory/list/route.ts` (Task 6 replaces this with the full version — for the spike, minimal):
```ts
import { resolveStore } from "../../../../src/store/resolve"

export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  const { store } = await resolveStore()
  const candidates = await store.listCandidates("")
  return Response.json({ records: candidates })
}
```
(Uses `listCandidates` because `browse` doesn't exist until Task 2 — the spike must not depend on later tasks.)

`packages/inspector/scripts/post-build.mjs`:
```js
// Standalone output does not include static assets — copy them in, per Next docs.
import { cpSync, existsSync } from "node:fs"
import { join } from "node:path"

const pkg = new URL("..", import.meta.url).pathname
const appDirInStandalone = join(pkg, ".next/standalone/packages/inspector")
if (!existsSync(appDirInStandalone)) {
  throw new Error(`post-build: ${appDirInStandalone} missing — did outputFileTracingRoot change?`)
}
cpSync(join(pkg, ".next/static"), join(appDirInStandalone, ".next/static"), { recursive: true })
if (existsSync(join(pkg, "public"))) {
  cpSync(join(pkg, "public"), join(appDirInStandalone, "public"), { recursive: true })
}
console.log("[post-build] static assets copied into standalone bundle")
```

- [ ] **Step 3: Fixture app (custom-config case)**

`packages/inspector/test/fixtures/app/dawn.config.ts`:
```ts
// Fixture proves the inspector loads USER TS config at runtime. The store is the
// default sqlite one but configured EXPLICITLY so the config file must be executed.
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { join } from "node:path"

export default {
  appDir: "src/app",
  memory: {
    writes: "candidate",
    store: sqliteMemoryStore({ path: join(import.meta.dirname, ".dawn", "memory.sqlite") }),
  },
}
```

`packages/inspector/test/fixtures/app/src/app/notes/memory.ts`:
```ts
import { z } from "zod"

export default {
  kind: "semantic",
  scope: ["route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
}
```
(Plain object, not `defineMemory(...)` — avoids a `@dawn-ai/sdk` dependency in the fixture; `loadRouteMemory` only checks the structural shape.)

`packages/inspector/test/fixtures/app/src/app/notes/index.ts`:
```ts
// Minimal route file so the fixture looks like a Dawn app; never executed by the spike.
export default {}
```

- [ ] **Step 4: Write the spike e2e test (fails until built)**

`packages/inspector/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
})
```

`packages/inspector/test/spike.e2e.test.ts`:
```ts
// Gated e2e: boots the BUILT standalone server against the fixture app and
// proves the live config-defined store is served through the API.
// Run with DAWN_TEST_INSPECTOR=1 after `pnpm --filter @dawn-ai/inspector build`.
import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterAll, beforeAll, expect, it } from "vitest"

const gated = process.env.DAWN_TEST_INSPECTOR === "1"
const pkgRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtureApp = join(pkgRoot, "test/fixtures/app")
const serverJs = join(pkgRoot, ".next/standalone/packages/inspector/server.js")

let child: ChildProcess | undefined
let base = ""

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (address && typeof address === "object") srv.close(() => resolve(address.port))
      else reject(new Error("no port"))
    })
  })
}

async function waitReady(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server never became ready at ${url}`)
}

beforeAll(async () => {
  if (!gated) return
  rmSync(join(fixtureApp, ".dawn"), { recursive: true, force: true })
  mkdirSync(join(fixtureApp, ".dawn"), { recursive: true })
  const store = sqliteMemoryStore({ path: join(fixtureApp, ".dawn", "memory.sqlite") })
  await store.put({
    id: "memory_spike_1",
    kind: "semantic",
    namespace: "route=/notes",
    content: "spike memory row",
    data: { subject: "spike", predicate: "works", value: "yes" },
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "candidate",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  })
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn("node", [serverJs], {
    env: { ...process.env, DAWN_APP_ROOT: fixtureApp, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  })
  await waitReady(`${base}/healthz`)
})

afterAll(() => {
  child?.kill("SIGTERM")
  rmSync(join(fixtureApp, ".dawn"), { recursive: true, force: true })
})

it.skipIf(!gated)("serves the live config-defined store through the API", async () => {
  const res = await fetch(`${base}/api/memory/list`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { records: { id: string; content: string }[] }
  expect(body.records.map((r) => r.id)).toContain("memory_spike_1")
})
```

- [ ] **Step 5: Install + build + run the spike**

```bash
pnpm install
pnpm --filter @dawn-ai/inspector build
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
```
Expected: build succeeds (note any `serverExternalPackages`/tracing warnings — resolve them, don't ignore); test PASSES. If the standalone path differs from `packages/inspector/server.js`, fix `dawnInspector.server` + `post-build.mjs` + the test to the REAL path and record it in the task notes.

- [ ] **Step 6: Measure (spec requires it)**

```bash
time pnpm --filter @dawn-ai/inspector build
du -sh packages/inspector/.next/standalone
cd packages/inspector && npm pack --dry-run 2>&1 | tail -5 && cd ../..
```
Record build seconds + standalone dir size + tarball size in the commit message body.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/memory-inspector
git add packages/inspector pnpm-lock.yaml
git commit -m "feat(inspector): package skeleton + spike proving live-store resolution through next build"
```

---

### Task 2: `browse` + `stats` — types + sqlite implementation

**Files:**
- Modify: `packages/memory/src/types.ts`, `packages/memory/src/sqlite-store.ts`, `packages/memory/src/index.ts`
- Test: `packages/memory/test/browse-stats.test.ts` (create)

- [ ] **Step 1: Add the types**

Append to `packages/memory/src/types.ts`:
```ts
export interface BrowseQuery {
  readonly namespacePrefix?: string
  readonly status?: MemoryStatus
  readonly kind?: MemoryKind
  readonly sourceType?: MemorySource["type"]
  readonly limit?: number
  readonly offset?: number
}
export interface BrowsePage {
  readonly records: readonly MemoryRecord[]
  readonly total: number
}
export interface MemoryStats {
  readonly total: number
  readonly byStatus: Readonly<Record<string, number>>
  readonly byKind: Readonly<Record<string, number>>
  readonly byNamespace: Readonly<Record<string, number>>
  readonly bySourceType: Readonly<Record<string, number>>
}
```
And add to the `MemoryStore` interface (REQUIRED members):
```ts
  /** Cross-namespace/status listing for inspection UIs. Ordered updated_at DESC, id ASC. */
  browse(q?: BrowseQuery): Promise<BrowsePage>
  /** Aggregate counts for facet UIs. */
  stats(opts?: { readonly namespacePrefix?: string }): Promise<MemoryStats>
```
Export the three new types from `packages/memory/src/index.ts` (alongside the existing type exports).

- [ ] **Step 2: Write failing tests**

`packages/memory/test/browse-stats.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MemoryRecord, sqliteMemoryStore } from "../src/index.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-mem-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "namespace">): MemoryRecord {
  return {
    kind: "semantic",
    content: over.id,
    data: {},
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }
}

describe("browse", () => {
  it("lists across namespaces and statuses, newest first, with total", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x", updatedAt: "2026-07-03T00:00:00.000Z" }))
    await s.put(rec({ id: "b", namespace: "route=/y", status: "candidate", updatedAt: "2026-07-02T00:00:00.000Z" }))
    await s.put(rec({ id: "c", namespace: "route=/x", status: "superseded", updatedAt: "2026-07-01T00:00:00.000Z" }))
    const page = await s.browse()
    expect(page.total).toBe(3)
    expect(page.records.map((r) => r.id)).toEqual(["a", "b", "c"])
  })
  it("filters by namespacePrefix, status, kind, sourceType", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x" }))
    await s.put(rec({ id: "b", namespace: "route=/y", status: "candidate" }))
    await s.put(rec({ id: "h", namespace: "route=/x", source: { type: "human", id: "u" } }))
    expect((await s.browse({ namespacePrefix: "route=/x" })).records.map((r) => r.id).sort()).toEqual(["a", "h"])
    expect((await s.browse({ status: "candidate" })).records.map((r) => r.id)).toEqual(["b"])
    expect((await s.browse({ sourceType: "human" })).records.map((r) => r.id)).toEqual(["h"])
  })
  it("pages with limit/offset while total stays full", async () => {
    const s = makeStore()
    for (let i = 0; i < 5; i++)
      await s.put(rec({ id: `r${i}`, namespace: "ns", updatedAt: `2026-07-0${i + 1}T00:00:00.000Z` }))
    const page = await s.browse({ limit: 2, offset: 2 })
    expect(page.total).toBe(5)
    expect(page.records.map((r) => r.id)).toEqual(["r2", "r1"])
  })
})

describe("stats", () => {
  it("returns count maps by status/kind/namespace/sourceType", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x" }))
    await s.put(rec({ id: "b", namespace: "route=/y", status: "candidate" }))
    await s.put(rec({ id: "h", namespace: "route=/x", source: { type: "human", id: "u" } }))
    const st = await s.stats()
    expect(st.total).toBe(3)
    expect(st.byStatus).toEqual({ active: 2, candidate: 1 })
    expect(st.byNamespace).toEqual({ "route=/x": 2, "route=/y": 1 })
    expect(st.bySourceType).toEqual({ tool: 2, human: 1 })
  })
  it("honors namespacePrefix", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", namespace: "route=/x" }))
    await s.put(rec({ id: "b", namespace: "route=/y" }))
    expect((await s.stats({ namespacePrefix: "route=/x" })).total).toBe(1)
  })
})
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @dawn-ai/memory test browse-stats
```
Expected: FAIL — `s.browse is not a function` (plus a TS error until Step 4 lands).

- [ ] **Step 4: Implement in sqlite-store**

Inside the returned store object in `packages/memory/src/sqlite-store.ts` (next to `listCandidates`), add — reusing the file's existing `rowToRecord`. First check the actual `source` column name/format near the schema DDL at the top of the file (it is stored as a JSON text column; adjust `json_extract(source, '$.type')` if the column is named differently):
```ts
    async browse(q = {}) {
      const where: string[] = []
      const params: unknown[] = []
      if (q.namespacePrefix) {
        where.push("namespace LIKE ?")
        params.push(`${q.namespacePrefix}%`)
      }
      if (q.status) {
        where.push("status = ?")
        params.push(q.status)
      }
      if (q.kind) {
        where.push("kind = ?")
        params.push(q.kind)
      }
      if (q.sourceType) {
        where.push("json_extract(source, '$.type') = ?")
        params.push(q.sourceType)
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      const limit = q.limit ?? 50
      const offset = q.offset ?? 0
      const rows = db
        .prepare(`SELECT * FROM memories ${clause} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Record<string, unknown>[]
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM memories ${clause}`).get(...params) as { n: number }
      ).n
      return { records: rows.map(rowToRecord), total }
    },
    async stats(opts = {}) {
      const clause = opts.namespacePrefix ? "WHERE namespace LIKE ?" : ""
      const params = opts.namespacePrefix ? [`${opts.namespacePrefix}%`] : []
      const group = (expr: string): Record<string, number> =>
        Object.fromEntries(
          (
            db
              .prepare(`SELECT ${expr} AS k, COUNT(*) AS n FROM memories ${clause} GROUP BY k`)
              .all(...params) as { k: string; n: number }[]
          ).map((r) => [r.k, r.n]),
        )
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM memories ${clause}`).get(...params) as { n: number }
      ).n
      return {
        total,
        byStatus: group("status"),
        byKind: group("kind"),
        byNamespace: group("namespace"),
        bySourceType: group("json_extract(source, '$.type')"),
      }
    },
```

- [ ] **Step 5: Run tests — pass, and full package green**

```bash
pnpm --filter @dawn-ai/memory test
pnpm --filter @dawn-ai/memory typecheck && pnpm --filter @dawn-ai/memory lint
```
Expected: all pass (the 66+ existing memory tests must stay green).

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/memory
git commit -m "feat(memory): required MemoryStore.browse + stats (sqlite)"
```

---

### Task 3: `browse` + `stats` — pgvector + conformance kit

**Files:**
- Modify: `packages/memory-pgvector/src/pgvector-store.ts` (add both methods), `packages/testing/src/memory-conformance.ts` (contract tests)
- Test: gated via existing pgvector lane (`DAWN_TEST_PGVECTOR=1`) + the sqlite conformance run in `packages/memory/test/` (find the file invoking `runMemoryStoreConformance` — it runs on every validate)

- [ ] **Step 1: Add contract tests to the conformance kit**

In `packages/testing/src/memory-conformance.ts`, inside the `describe` block, append:
```ts
    test("browse lists across namespaces/statuses with paging + total", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns1", content: "x", updatedAt: "2026-07-03T00:00:00.000Z" }))
        await s.put(rec({ id: "b", namespace: "ns2", content: "y", status: "candidate", updatedAt: "2026-07-02T00:00:00.000Z" }))
        await s.put(rec({ id: "c", namespace: "ns1", content: "z", status: "superseded", updatedAt: "2026-07-01T00:00:00.000Z" }))
        const all = await s.browse()
        expect(all.total).toBe(3)
        expect(all.records.map((r) => r.id)).toEqual(["a", "b", "c"])
        const page = await s.browse({ limit: 1, offset: 1 })
        expect(page.total).toBe(3)
        expect(page.records.map((r) => r.id)).toEqual(["b"])
        expect((await s.browse({ namespacePrefix: "ns1", status: "active" })).records.map((r) => r.id)).toEqual(["a"])
      } finally {
        await close?.(s)
      }
    })
    test("stats returns aggregate count maps", async () => {
      const s = await makeStore()
      try {
        await s.put(rec({ id: "a", namespace: "ns1", content: "x" }))
        await s.put(rec({ id: "b", namespace: "ns2", content: "y", status: "candidate" }))
        const st = await s.stats()
        expect(st.total).toBe(2)
        expect(st.byStatus).toEqual({ active: 1, candidate: 1 })
        expect(st.byNamespace).toEqual({ ns1: 1, ns2: 1 })
      } finally {
        await close?.(s)
      }
    })
```

- [ ] **Step 2: Run sqlite conformance — passes already (Task 2 shipped sqlite)**

```bash
pnpm --filter @dawn-ai/memory test
pnpm --filter @dawn-ai/testing typecheck
```
Expected: sqlite conformance green including the two new tests.

- [ ] **Step 3: Implement pgvector `browse` + `stats`**

In `packages/memory-pgvector/src/pgvector-store.ts`, add to the store object (reusing `recordColumns`/`rowToRecord` from `./queries.js`; `T` below is the memories table name variable already used by neighboring methods — match its actual identifier):
```ts
    async browse(q = {}) {
      await ready()
      const where: string[] = []
      const params: unknown[] = []
      const p = () => `$${params.length}`
      if (q.namespacePrefix) {
        params.push(`${escapeLike(q.namespacePrefix)}%`)
        where.push(`namespace LIKE ${p()}`)
      }
      if (q.status) {
        params.push(q.status)
        where.push(`status = ${p()}`)
      }
      if (q.kind) {
        params.push(q.kind)
        where.push(`kind = ${p()}`)
      }
      if (q.sourceType) {
        params.push(q.sourceType)
        where.push(`source->>'type' = ${p()}`)
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      params.push(q.limit ?? 50)
      const limitP = p()
      params.push(q.offset ?? 0)
      const offsetP = p()
      const rows = await client.query(
        `SELECT ${RECORD_COLUMNS} FROM ${memoriesTable} ${clause}
         ORDER BY updated_at DESC, id ASC LIMIT ${limitP} OFFSET ${offsetP}`,
        params,
      )
      const totalRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${memoriesTable} ${clause}`,
        params.slice(0, params.length - 2),
      )
      return { records: rows.rows.map(rowToRecord), total: totalRes.rows[0].n }
    },
    async stats(opts = {}) {
      await ready()
      const clause = opts.namespacePrefix ? "WHERE namespace LIKE $1" : ""
      const params = opts.namespacePrefix ? [`${escapeLike(opts.namespacePrefix)}%`] : []
      const group = async (expr: string): Promise<Record<string, number>> => {
        const res = await client.query(
          `SELECT ${expr} AS k, COUNT(*)::int AS n FROM ${memoriesTable} ${clause} GROUP BY k`,
          params,
        )
        return Object.fromEntries(res.rows.map((r: { k: string; n: number }) => [r.k, r.n]))
      }
      const totalRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${memoriesTable} ${clause}`,
        params,
      )
      return {
        total: totalRes.rows[0].n,
        byStatus: await group("status"),
        byKind: await group("kind"),
        byNamespace: await group("namespace"),
        bySourceType: await group("source->>'type'"),
      }
    },
```
IMPORTANT adaptations while implementing (the surrounding file is the source of truth):
- Match how neighboring methods acquire a client/pool (`pool.query` vs a helper) and the actual table-name variable.
- If an `escapeLike` helper doesn't exist, add one escaping `%`, `_`, `\` (and use `LIKE ... ESCAPE '\'`) in BOTH stores — then add a conformance test seeding a namespace containing `%` to lock the behavior in. Keep sqlite and pgvector identical.

- [ ] **Step 4: Run the gated pgvector suite (Docker required)**

```bash
DAWN_TEST_PGVECTOR=1 pnpm --filter @dawn-ai/memory-pgvector test
```
Expected: all pass including the two new conformance tests (21+ total).

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/memory-pgvector packages/testing packages/memory
git commit -m "feat(memory-pgvector): browse + stats; conformance kit enforces both"
```

---

### Task 4: Unify the config-facing store type (kill the CLI cast)

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (`MemoryStoreLike` + `MemoryRecordLike`), `packages/cli/src/commands/memory.ts:37` (remove cast), `packages/cli/src/lib/runtime/resolve-memory.ts` (return type)
- Test: `packages/core/test/` — existing suites must stay green; the compile IS the test here.

- [ ] **Step 1: Tighten + extend `MemoryStoreLike` in `packages/core/src/capabilities/types.ts`**

In `MemoryRecordLike` (find it near `MemoryStoreLike`): change `kind`/`status`/`source.type` from `string` to the literal unions, duplicated locally (core deliberately does NOT import `@dawn-ai/memory`):
```ts
export type MemoryKindLike = "semantic" | "episodic" | "procedural" | "reflection"
export type MemoryStatusLike = "candidate" | "active" | "superseded"
export type MemorySourceTypeLike = "run" | "user" | "tool" | "eval" | "human"
```
Then add the missing members to `MemoryStoreLike` (matching Task 2's shapes structurally):
```ts
  delete(id: string): Promise<void>
  listCandidates(namespacePrefix: string): Promise<readonly MemoryRecordLike[]>
  browse(q?: {
    readonly namespacePrefix?: string
    readonly status?: MemoryStatusLike
    readonly kind?: MemoryKindLike
    readonly sourceType?: MemorySourceTypeLike
    readonly limit?: number
    readonly offset?: number
  }): Promise<{ readonly records: readonly MemoryRecordLike[]; readonly total: number }>
  stats(opts?: { readonly namespacePrefix?: string }): Promise<{
    readonly total: number
    readonly byStatus: Readonly<Record<string, number>>
    readonly byKind: Readonly<Record<string, number>>
    readonly byNamespace: Readonly<Record<string, number>>
    readonly bySourceType: Readonly<Record<string, number>>
  }>
```

- [ ] **Step 2: Remove the CLI cast**

`packages/cli/src/commands/memory.ts:37`: `const store = (await resolveMemoryStore(appRoot)) as unknown as MemoryStore` → `const store = await resolveMemoryStore(appRoot)`. Update the `runX` helper signatures from `MemoryStore` to `MemoryStoreLike` (import the type from `@dawn-ai/core`) — or keep `MemoryStore` if TS accepts the structural assignment after Step 1 (it should; verify with typecheck). Prefer whichever compiles WITHOUT any cast.

- [ ] **Step 3: Build + typecheck the whole workspace (this change is cross-package)**

```bash
pnpm turbo run typecheck --filter=@dawn-ai/core --filter=@dawn-ai/cli --filter=@dawn-ai/memory --filter=@dawn-ai/memory-pgvector --filter=@dawn-ai/inspector
pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/cli test
```
Expected: green. Any custom-store type error in examples means the example needs `browse`/`stats` — that's the intended break; fix the example by using the built-in store or implementing the methods.

- [ ] **Step 4: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/core packages/cli
git commit -m "feat(core)!: config store type unified with full MemoryStore contract (browse/stats/delete/listCandidates required)"
```

---

### Task 5: `parseNamespace`, shared `routeNamespaceKey`, `approveWithReconcile`, CLI approve rewire

**Files:**
- Modify: `packages/memory/src/namespace.ts`, `packages/memory/src/reconcile.ts`, `packages/memory/src/index.ts`, `packages/cli/src/lib/runtime/resolve-memory.ts` (delete local `routeNamespaceKey`, re-import), `packages/cli/src/commands/memory.ts` (approve)
- Test: `packages/memory/test/reconcile-approve.test.ts` (create), `packages/cli/test/memory-command.test.ts` (extend)

- [ ] **Step 1: `parseNamespace` + move `routeNamespaceKey` into `packages/memory/src/namespace.ts`**

Append to `namespace.ts`:
```ts
function decodeValue(value: string): string {
  return value.replaceAll("%3D", "=").replaceAll("%7C", "|").replaceAll("%25", "%")
}

/** Inverse of serializeNamespace. Unknown keys are ignored. */
export function parseNamespace(namespace: string): MemoryScopeTuple {
  const out: Record<string, string> = {}
  for (const part of namespace.split("|")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    if ((ORDER as readonly string[]).includes(key)) out[key] = decodeValue(part.slice(eq + 1))
  }
  return out as MemoryScopeTuple
}
```
Then MOVE the `routeNamespaceKey` function from `packages/cli/src/lib/runtime/resolve-memory.ts:17-37` here verbatim (same doc comment), export it, and in `resolve-memory.ts` replace the local definition with `import { routeNamespaceKey } from "@dawn-ai/memory"` — re-export it from `resolve-memory.ts` if other CLI modules/tests import it from there (grep first: `grep -rn "routeNamespaceKey" packages/cli`). Export both new functions from `packages/memory/src/index.ts`.

- [ ] **Step 2: Failing tests for `approveWithReconcile`**

`packages/memory/test/reconcile-approve.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { approveWithReconcile, type MemoryRecord, sqliteMemoryStore } from "../src/index.js"

const dirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "dawn-rec-"))
  dirs.push(dir)
  return sqliteMemoryStore({ path: join(dir, "m.sqlite") })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rec(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "status">): MemoryRecord {
  return {
    kind: "semantic",
    namespace: "route=/notes",
    content: over.id,
    data: { subject: "acme", predicate: "threshold", value: "500" },
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }
}
const KEYS = ["subject", "predicate"] as const
const NOW = "2026-07-13T00:00:00.000Z"

describe("approveWithReconcile", () => {
  it("plain activate when no identity match", async () => {
    const s = makeStore()
    await s.put(rec({ id: "cand", status: "candidate" }))
    const res = await approveWithReconcile(s, "cand", { identityKeys: KEYS, now: NOW })
    expect(res.action).toBe("activated")
    expect((await s.get("cand"))?.status).toBe("active")
  })
  it("supersedes a contradicting active row (the two-actives bug)", async () => {
    const s = makeStore()
    await s.put(rec({ id: "old", status: "active" }))
    await s.put(rec({ id: "cand", status: "candidate", data: { subject: "acme", predicate: "threshold", value: "750" } }))
    const res = await approveWithReconcile(s, "cand", { identityKeys: KEYS, now: NOW })
    expect(res.action).toBe("superseded")
    expect(res.superseded.map((r) => r.id)).toEqual(["old"])
    expect((await s.get("old"))?.status).toBe("superseded")
    const approved = await s.get("cand")
    expect(approved?.status).toBe("active")
    expect(approved?.supersedes).toContain("old")
  })
  it("dedupes an identical-data candidate instead of double-activating", async () => {
    const s = makeStore()
    await s.put(rec({ id: "old", status: "active" }))
    await s.put(rec({ id: "cand", status: "candidate" }))
    const res = await approveWithReconcile(s, "cand", { identityKeys: KEYS, now: NOW })
    expect(res.action).toBe("deduped")
    expect(res.approved.id).toBe("old")
    expect(await s.get("cand")).toBeNull()
  })
  it("rejects a non-candidate", async () => {
    const s = makeStore()
    await s.put(rec({ id: "a", status: "active" }))
    await expect(approveWithReconcile(s, "a", { identityKeys: KEYS, now: NOW })).rejects.toThrow(/candidate/)
  })
})
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @dawn-ai/memory test reconcile-approve
```
Expected: FAIL — `approveWithReconcile` not exported.

- [ ] **Step 4: Implement in `packages/memory/src/reconcile.ts`**

```ts
import type { MemoryRecord, MemoryStore } from "./types.js"

export interface ApproveResult {
  readonly approved: MemoryRecord
  readonly action: "activated" | "superseded" | "deduped"
  readonly superseded: readonly MemoryRecord[]
  readonly identityKeys: readonly string[]
}

/**
 * Approve a candidate WITH supersede reconciliation (fixes the two-actives bug):
 * same identity + different data → the old active row is superseded; same
 * identity + identical data → the candidate is dropped (dedupe); no identity
 * match → plain activation. Used by `dawn memory approve` and the inspector —
 * the capability's auto-write path keeps its own inline logic by design.
 */
export async function approveWithReconcile(
  store: MemoryStore,
  id: string,
  opts: { readonly identityKeys: readonly string[]; readonly now: string },
): Promise<ApproveResult> {
  const candidate = await store.get(id)
  if (!candidate) throw new Error(`memory ${id} not found`)
  if (candidate.status !== "candidate")
    throw new Error(`memory ${id} is '${candidate.status}', not a candidate`)
  const actives = await store.search({
    namespace: candidate.namespace,
    status: "active",
    kind: candidate.kind,
    limit: 10_000,
  })
  const op = classifyWrite(candidate, actives, opts.identityKeys)
  if (op.op === "update") {
    // Identical data already active — dedupe the candidate.
    const existing = actives.find((r) => r.id === op.targetId)
    if (!existing) throw new Error(`reconcile target ${op.targetId} vanished`)
    await store.delete(id)
    return { approved: existing, action: "deduped", superseded: [], identityKeys: opts.identityKeys }
  }
  if (op.op === "supersede") {
    const target = actives.find((r) => r.id === op.targetId)
    if (!target) throw new Error(`reconcile target ${op.targetId} vanished`)
    await store.update(id, {
      status: "active",
      updatedAt: opts.now,
      supersedes: [...(candidate.supersedes ?? []), target.id],
    })
    await store.supersede(target.id, id)
    const approved = await store.get(id)
    if (!approved) throw new Error(`approved memory ${id} vanished`)
    return { approved, action: "superseded", superseded: [target], identityKeys: opts.identityKeys }
  }
  await store.update(id, { status: "active", updatedAt: opts.now })
  const approved = await store.get(id)
  if (!approved) throw new Error(`approved memory ${id} vanished`)
  return { approved, action: "activated", superseded: [], identityKeys: opts.identityKeys }
}
```
Export `approveWithReconcile` + `ApproveResult` from `packages/memory/src/index.ts`.

- [ ] **Step 5: Tests pass**

```bash
pnpm --filter @dawn-ai/memory test
```
Expected: all green.

- [ ] **Step 6: Rewire `dawn memory approve` (identity via route discovery)**

In `packages/cli/src/commands/memory.ts`, replace `runApprove` (currently `store.update(id, { status: "active", ... })`) with:
```ts
async function runApprove(store: MemoryStore, appRoot: string, id: string, io: CommandIo): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new CliError(`memory ${id} not found`)
  if (rec.status !== "candidate") throw new CliError(`memory ${id} is '${rec.status}', not a candidate`)
  const identityKeys = await resolveIdentityKeys(appRoot, rec.namespace)
  const res = await approveWithReconcile(store, id, {
    identityKeys: identityKeys.keys,
    now: new Date().toISOString(),
  })
  writeLine(io, `approved ${res.approved.id} (${res.action})`)
  for (const old of res.superseded) writeLine(io, `superseded ${old.id}`)
  if (identityKeys.fallback)
    writeLine(io, `note: route memory.ts not found for namespace; used default identity [subject, predicate]`)
}
```
Add the identity resolver in the same file (imports: `discoverRoutes` from `@dawn-ai/core`, `parseNamespace`, `routeNamespaceKey`, `approveWithReconcile` from `@dawn-ai/memory`, `loadRouteMemory` from `../lib/runtime/load-memory.js`, `existsSync` from `node:fs`, `join` from `node:path`):
```ts
async function resolveIdentityKeys(
  appRoot: string,
  namespace: string,
): Promise<{ keys: readonly string[]; fallback: boolean }> {
  const DEFAULT = ["subject", "predicate"] as const
  const routeKey = parseNamespace(namespace).route
  if (!routeKey) return { keys: DEFAULT, fallback: true }
  try {
    const manifest = await discoverRoutes({ appRoot })
    for (const route of manifest.routes) {
      if (routeNamespaceKey(route.pathname) !== routeKey) continue
      const memoryFile = join(route.routeDir, "memory.ts")
      if (!existsSync(memoryFile)) break
      const def = await loadRouteMemory(memoryFile)
      return { keys: def.identity ?? DEFAULT, fallback: false }
    }
  } catch {
    // fall through to default
  }
  return { keys: DEFAULT, fallback: true }
}
```
(Check `discoverRoutes` is exported from `@dawn-ai/core`'s barrel — `packages/core/src/discovery/discover-routes.ts`; if not, export it. Check the field names `pathname`/`routeDir` against `DiscoveredRoute`. Thread `appRoot` into `runApprove` from `runMemoryCommand` — it already computes `appRoot` for `resolveMemoryStore`.)

- [ ] **Step 7: Extend the CLI test**

In `packages/cli/test/memory-command.test.ts`, find the existing approve test and add a contradicting-candidate case (mirror the existing test's store/app fixture setup — same temp-dir pattern the file already uses):
```ts
  test("approve supersedes a contradicting active row", async () => {
    // Arrange: an active record and a candidate with the same subject/predicate
    // but different value, in the SAME namespace; no route memory.ts → default identity.
    // (Reuse this file's existing store-seeding helper/fixture pattern.)
    // Act: runMemoryCommand(["approve", candidateId], { cwd: appRoot }, io)
    // Assert: candidate is now active AND the old record's status is "superseded",
    // and stdout mentions "superseded".
  })
```
Write it fully against the file's real helpers (they exist — the file already seeds stores for list/approve tests; copy that arrangement). The assertion block above is the required behavior.

- [ ] **Step 8: Run + commit**

```bash
pnpm --filter @dawn-ai/memory test && pnpm --filter @dawn-ai/cli test memory-command
pnpm turbo run typecheck --filter=@dawn-ai/cli --filter=@dawn-ai/memory
git rev-parse --abbrev-ref HEAD
git add packages/memory packages/cli
git commit -m "feat(memory): approveWithReconcile + parseNamespace/routeNamespaceKey; dawn memory approve reconciles (fixes two-actives bug)"
```

---

### Task 6: Inspector JSON API + security guard (replaces the spike route)

**Files:**
- Create: `packages/inspector/src/store/guard.ts`, `packages/inspector/src/store/identity.ts`, `packages/inspector/app/api/memory/stats/route.ts`, `packages/inspector/app/api/memory/search/route.ts`, `packages/inspector/app/api/memory/[id]/route.ts`, `packages/inspector/app/api/memory/[id]/approve/route.ts`, `packages/inspector/app/api/memory/[id]/reject/route.ts`, `packages/inspector/app/api/memory/[id]/forget/route.ts`
- Modify: `packages/inspector/app/api/memory/list/route.ts` (full version)
- Test: `packages/inspector/test/api.e2e.test.ts` (create; gated like the spike)

- [ ] **Step 1: Security guard**

`packages/inspector/src/store/guard.ts`:
```ts
/**
 * Localhost-only protection: the inspector binds 127.0.0.1, but any website the
 * developer has open can still fire cross-origin requests at it (CSRF/DNS
 * rebinding). Verify Host, and reject state-changing requests whose Origin is
 * present and foreign.
 */
export function assertLocalRequest(req: Request): Response | undefined {
  const host = req.headers.get("host") ?? ""
  const hostname = host.split(":")[0]
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    return Response.json({ error: `forbidden host ${host}` }, { status: 403 })
  }
  if (req.method !== "GET") {
    const origin = req.headers.get("origin")
    if (origin) {
      let originHost = ""
      try {
        originHost = new URL(origin).hostname
      } catch {}
      if (originHost !== "127.0.0.1" && originHost !== "localhost") {
        return Response.json({ error: `forbidden origin ${origin}` }, { status: 403 })
      }
    }
  }
  return undefined
}
```

- [ ] **Step 2: Identity resolution (inspector-side twin of the CLI's)**

`packages/inspector/src/store/identity.ts`:
```ts
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { discoverRoutes } from "@dawn-ai/core"
import { parseNamespace, routeNamespaceKey } from "@dawn-ai/memory"

const DEFAULT = ["subject", "predicate"] as const

/** Route-level identity keys for a record's namespace; defaults to the semantic
 *  identity when the route/memory.ts can't be resolved. tsx is already
 *  registered by the earlier loadDawnConfig call in resolveStore(). */
export async function resolveIdentityKeys(
  appRoot: string,
  namespace: string,
): Promise<{ keys: readonly string[]; fallback: boolean }> {
  const routeKey = parseNamespace(namespace).route
  if (!routeKey) return { keys: DEFAULT, fallback: true }
  try {
    const manifest = await discoverRoutes({ appRoot })
    for (const route of manifest.routes) {
      if (routeNamespaceKey(route.pathname) !== routeKey) continue
      const memoryFile = join(route.routeDir, "memory.ts")
      if (!existsSync(memoryFile)) break
      const mod = (await import(pathToFileURL(memoryFile).href)) as {
        default?: { identity?: readonly string[] }
      }
      return { keys: mod.default?.identity ?? DEFAULT, fallback: false }
    }
  } catch {}
  return { keys: DEFAULT, fallback: true }
}
```

- [ ] **Step 3: The routes**

`packages/inspector/app/api/memory/list/route.ts` (replace spike body):
```ts
import { resolveStore } from "../../../../src/store/resolve"
import { assertLocalRequest } from "../../../../src/store/guard"

export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { store } = await resolveStore()
  const url = new URL(req.url)
  const g = (k: string) => url.searchParams.get(k) ?? undefined
  const page = await store.browse({
    ...(g("namespacePrefix") ? { namespacePrefix: g("namespacePrefix") } : {}),
    ...(g("status") ? { status: g("status") as never } : {}),
    ...(g("kind") ? { kind: g("kind") as never } : {}),
    ...(g("sourceType") ? { sourceType: g("sourceType") as never } : {}),
    limit: Number(g("limit") ?? 50),
    offset: Number(g("offset") ?? 0),
  })
  return Response.json(page)
}
```

`packages/inspector/app/api/memory/stats/route.ts`:
```ts
import { resolveStore } from "../../../../src/store/resolve"
import { assertLocalRequest } from "../../../../src/store/guard"

export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { store } = await resolveStore()
  const prefix = new URL(req.url).searchParams.get("namespacePrefix") ?? undefined
  return Response.json(await store.stats(prefix ? { namespacePrefix: prefix } : {}))
}
```

`packages/inspector/app/api/memory/search/route.ts`:
```ts
import { resolveStore } from "../../../../src/store/resolve"
import { assertLocalRequest } from "../../../../src/store/guard"

export const dynamic = "force-dynamic"

export async function GET(req: Request): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { store, embedder } = await resolveStore()
  const url = new URL(req.url)
  const q = url.searchParams.get("q") ?? ""
  const namespace = url.searchParams.get("namespace") ?? undefined
  if (!q) return Response.json({ groups: [] })

  // Best-effort embedding — degrade to keyword-only on failure (capability parity).
  let queryEmbedding: Float32Array | undefined
  let embedderId: string | undefined
  if (embedder) {
    try {
      queryEmbedding = (await embedder.embed([q]))[0]
      embedderId = embedder.id
    } catch {}
  }
  const namespaces = namespace
    ? [namespace]
    : Object.keys((await store.stats()).byNamespace)
  const groups = []
  for (const ns of namespaces) {
    const records = await store.search({
      namespace: ns,
      query: q,
      status: "active",
      limit: 8,
      now: new Date().toISOString(),
      ...(queryEmbedding ? { queryEmbedding, embedderId } : {}),
    })
    if (records.length > 0) groups.push({ namespace: ns, records })
  }
  return Response.json({ groups, hybrid: Boolean(queryEmbedding) })
}
```

`packages/inspector/app/api/memory/[id]/route.ts`:
```ts
import { resolveStore } from "../../../../src/store/resolve"
import { assertLocalRequest } from "../../../../src/store/guard"

export const dynamic = "force-dynamic"

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { store } = await resolveStore()
  const { id } = await ctx.params
  const rec = await store.get(id)
  if (!rec) return Response.json({ error: "not found" }, { status: 404 })
  return Response.json(rec)
}
```
(Next 15+/16 app router: `params` is a Promise — this shape is correct for the pinned Next version; verify against the installed version's docs if types complain.)

`packages/inspector/app/api/memory/[id]/approve/route.ts`:
```ts
import { approveWithReconcile } from "@dawn-ai/memory"
import { resolveStore } from "../../../../../src/store/resolve"
import { assertLocalRequest } from "../../../../../src/store/guard"
import { resolveIdentityKeys } from "../../../../../src/store/identity"

export const dynamic = "force-dynamic"

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { store, appRoot } = await resolveStore()
  const { id } = await ctx.params
  const rec = await store.get(id)
  if (!rec) return Response.json({ error: "not found" }, { status: 404 })
  const identity = await resolveIdentityKeys(appRoot, rec.namespace)
  try {
    const res = await approveWithReconcile(store, id, {
      identityKeys: identity.keys,
      now: new Date().toISOString(),
    })
    return Response.json({ ...res, identityFallback: identity.fallback })
  } catch (err) {
    return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 409 })
  }
}
```

`packages/inspector/app/api/memory/[id]/reject/route.ts` (and `forget/route.ts` — identical body, different candidate-guard):
```ts
import { resolveStore } from "../../../../../src/store/resolve"
import { assertLocalRequest } from "../../../../../src/store/guard"

export const dynamic = "force-dynamic"

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = assertLocalRequest(req)
  if (denied) return denied
  const { store } = await resolveStore()
  const { id } = await ctx.params
  const rec = await store.get(id)
  if (!rec) return Response.json({ error: "not found" }, { status: 404 })
  // reject/route.ts ONLY: candidates only
  if (rec.status !== "candidate")
    return Response.json({ error: `not a candidate (status: ${rec.status})` }, { status: 409 })
  await store.delete(id)
  return Response.json({ deleted: id })
}
```
`forget/route.ts` omits the candidate-status guard (forget works on any record) — otherwise identical.

- [ ] **Step 4: e2e test for the API (extends the spike harness)**

`packages/inspector/test/api.e2e.test.ts` — same gating/boot pattern as `spike.e2e.test.ts` (extract the shared boot/teardown into `packages/inspector/test/harness.ts` and refactor the spike test to use it). Seed: one active (`{subject:"acme",predicate:"threshold",value:"500"}`) + one contradicting candidate (`value:"750"`) + one unrelated candidate, all in `route=/notes` matching the fixture. Assert:
```ts
it.skipIf(!gated)("browse lists all three with total", async () => {
  const body = await (await fetch(`${base}/api/memory/list`)).json()
  expect(body.total).toBe(3)
})
it.skipIf(!gated)("stats counts statuses", async () => {
  const st = await (await fetch(`${base}/api/memory/stats`)).json()
  expect(st.byStatus).toEqual({ active: 1, candidate: 2 })
})
it.skipIf(!gated)("approve reconciles the contradiction", async () => {
  const res = await fetch(`${base}/api/memory/${candidateId}/approve`, { method: "POST" })
  const body = await res.json()
  expect(body.action).toBe("superseded")
  expect(body.superseded[0].id).toBe(activeId)
})
it.skipIf(!gated)("cross-origin POST is rejected", async () => {
  const res = await fetch(`${base}/api/memory/${otherId}/forget`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  })
  expect(res.status).toBe(403)
})
it.skipIf(!gated)("search finds by keyword", async () => {
  const body = await (await fetch(`${base}/api/memory/search?q=threshold`)).json()
  expect(body.groups.length).toBeGreaterThanOrEqual(1)
})
```
(Fill in the seeding with the exact record shapes from the spike test; ids `activeId`/`candidateId`/`otherId` are the seeded ids.)

- [ ] **Step 5: Build, run, commit**

```bash
pnpm --filter @dawn-ai/inspector build
DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
git rev-parse --abbrev-ref HEAD
git add packages/inspector
git commit -m "feat(inspector): memory JSON API (browse/stats/search/get/approve/reject/forget) + localhost guard"
```

---

### Task 7: UI foundation — Tailwind/shadcn-style components + pretable grid + list view

**Files:**
- Create: `packages/inspector/src/components/ui/button.tsx`, `src/components/ui/badge.tsx`, `src/components/ui/input.tsx`, `src/components/panels.ts`, `src/components/use-polling.ts`, `src/components/memory/memory-grid.tsx`, `src/components/memory/facet-rail.tsx`, `src/components/memory/list-page.tsx`, `packages/inspector/app/page.tsx` (redirect → /memory), `packages/inspector/app/memory/page.tsx`
- Modify: `packages/inspector/package.json` (add deps), `packages/inspector/app/globals.css` (pretable theme imports)
- Test: `packages/inspector/test/components/list.test.tsx` (create; jsdom)

- [ ] **Step 1: Add UI deps**

```bash
pnpm --filter @dawn-ai/inspector add @pretable/react@0.0.2 @pretable/ui@0.0.2 class-variance-authority clsx tailwind-merge lucide-react
pnpm --filter @dawn-ai/inspector add -D @testing-library/react @testing-library/dom jsdom @vitejs/plugin-react
```
Pin `@pretable/react`/`@pretable/ui` EXACT (`0.0.2`, no caret) — pre-1.0 dogfooding.

- [ ] **Step 2: Globals + theme**

`app/globals.css` becomes:
```css
@import "tailwindcss";
@import "@pretable/ui/themes/excel.css";
@import "@pretable/ui/grid.css";
```

- [ ] **Step 3: Minimal shadcn-style primitives** (hand-written — exactly what `npx shadcn add` generates, trimmed)

`src/components/ui/button.tsx`:
```tsx
import { cva, type VariantProps } from "class-variance-authority"
import type { ButtonHTMLAttributes } from "react"
import { twMerge } from "tailwind-merge"

const button = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none h-9 px-4",
  {
    variants: {
      variant: {
        default: "bg-zinc-900 text-white hover:bg-zinc-700",
        outline: "border border-zinc-200 bg-white hover:bg-zinc-50",
        destructive: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export function Button({
  className,
  variant,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={twMerge(button({ variant }), className)} {...props} />
}
```

`src/components/ui/badge.tsx`:
```tsx
import { cva, type VariantProps } from "class-variance-authority"
import type { HTMLAttributes } from "react"
import { twMerge } from "tailwind-merge"

const badge = cva("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      active: "bg-green-100 text-green-800",
      candidate: "bg-amber-100 text-amber-800",
      superseded: "bg-zinc-100 text-zinc-500 line-through",
      neutral: "border border-zinc-200 bg-white text-zinc-600",
    },
  },
  defaultVariants: { variant: "neutral" },
})

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={twMerge(badge({ variant }), className)} {...props} />
}
```

`src/components/ui/input.tsx`:
```tsx
import type { InputHTMLAttributes } from "react"
import { twMerge } from "tailwind-merge"

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={twMerge(
        "h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300",
        className,
      )}
      {...props}
    />
  )
}
```

`src/components/panels.ts` (the growth seam):
```ts
export interface InspectorPanel {
  readonly id: string
  readonly label: string
  readonly href: string
}
/** Registry the shell renders; future panels (threads, runs, sandbox) append here. */
export const PANELS: readonly InspectorPanel[] = [{ id: "memory", label: "Memory", href: "/memory" }]
```

`src/components/use-polling.ts`:
```ts
"use client"
import { useEffect, useRef, useState } from "react"

/** Poll fn every intervalMs while enabled and the tab is visible. */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, enabled: boolean): T | undefined {
  const [value, setValue] = useState<T>()
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const v = await fnRef.current()
        if (alive) setValue(v)
      } catch {}
    }
    void tick()
    if (!enabled) return () => { alive = false }
    const id = setInterval(tick, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [intervalMs, enabled])
  return value
}
```

- [ ] **Step 4: The grid wrapper (pretable behind our own seam)**

`src/components/memory/memory-grid.tsx`:
```tsx
"use client"
import { Pretable, type PretableColumn } from "@pretable/react"
import type { MemoryRecord } from "@dawn-ai/memory"

const columns: PretableColumn[] = [
  { id: "status", header: "Status", value: (row) => String(row.status) },
  { id: "content", header: "Content", value: (row) => String(row.content) },
  { id: "namespace", header: "Namespace", value: (row) => String(row.namespace) },
  { id: "kind", header: "Kind", value: (row) => String(row.kind) },
  { id: "confidence", header: "Conf", value: (row) => String(row.confidence) },
  { id: "updatedAt", header: "Updated", value: (row) => String(row.updatedAt) },
]

export function MemoryGrid({
  records,
  onSelect,
}: {
  records: readonly MemoryRecord[]
  onSelect: (id: string) => void
}) {
  const rows = records.map((r) => ({ ...r, id: r.id }))
  return (
    <div className="h-full min-h-0" data-testid="memory-grid">
      <Pretable rows={rows} columns={columns} />
    </div>
  )
}
```
**pretable row-click:** read `node_modules/@pretable/react/dist/index.d.ts` for the selection/row-event API (`usePretableModel` or an `onRowClick`-style prop) and wire `onSelect(row.id)` with the documented mechanism. **If 0.0.2 exposes no row-interaction API**, keep `MemoryGrid`'s props unchanged and render a plain semantic `<table>` (same columns, `onClick` per `<tr>`, tailwind styling) as the interim body, and record the missing API as pretable dogfooding feedback in the PR description. The wrapper seam makes the swap invisible to the rest of the UI.

- [ ] **Step 5: Facet rail + list page**

`src/components/memory/facet-rail.tsx`:
```tsx
"use client"
import type { MemoryStats } from "@dawn-ai/memory"

export function FacetRail({
  stats,
  selected,
  onSelect,
}: {
  stats: MemoryStats | undefined
  selected: string | undefined
  onSelect: (ns: string | undefined) => void
}) {
  const namespaces = Object.entries(stats?.byNamespace ?? {})
  return (
    <nav className="w-48 shrink-0 border-r border-zinc-200 bg-zinc-50 p-3 text-sm">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Namespace</div>
      <button
        type="button"
        onClick={() => onSelect(undefined)}
        className={`flex w-full justify-between rounded px-2 py-1 ${selected === undefined ? "bg-indigo-50 font-medium text-indigo-800" : "hover:bg-zinc-100"}`}
      >
        <span>all</span>
        <span className="text-zinc-400">{stats?.total ?? 0}</span>
      </button>
      {namespaces.map(([ns, n]) => (
        <button
          key={ns}
          type="button"
          onClick={() => onSelect(ns)}
          className={`flex w-full justify-between rounded px-2 py-1 font-mono text-xs ${selected === ns ? "bg-indigo-50 font-medium text-indigo-800" : "hover:bg-zinc-100"}`}
        >
          <span className="truncate">{ns}</span>
          <span className="text-zinc-400">{n}</span>
        </button>
      ))}
    </nav>
  )
}
```

`src/components/memory/list-page.tsx` (the client page body — layout B):
```tsx
"use client"
import { useCallback, useState } from "react"
import type { BrowsePage, MemoryRecord, MemoryStats } from "@dawn-ai/memory"
import { Badge } from "../ui/badge"
import { Input } from "../ui/input"
import { usePolling } from "../use-polling"
import { FacetRail } from "./facet-rail"
import { MemoryGrid } from "./memory-grid"
import { DetailSheet } from "./detail-sheet"

interface SearchGroups {
  groups: { namespace: string; records: MemoryRecord[] }[]
  hybrid: boolean
}

export function ListPage() {
  const [namespace, setNamespace] = useState<string | undefined>()
  const [status, setStatus] = useState("")
  const [kind, setKind] = useState("")
  const [query, setQuery] = useState("")
  const [live, setLive] = useState(true)
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [refreshTick, setRefreshTick] = useState(0)

  const fetchStats = useCallback(
    () => fetch("/api/memory/stats").then((r) => r.json() as Promise<MemoryStats>),
    [],
  )
  const fetchPage = useCallback(() => {
    const p = new URLSearchParams()
    if (namespace) p.set("namespacePrefix", namespace)
    if (status) p.set("status", status)
    if (kind) p.set("kind", kind)
    p.set("limit", "200")
    // biome-ignore lint/correctness/noUnusedExpressions: refreshTick forces refetch after mutations
    refreshTick
    return fetch(`/api/memory/list?${p}`).then((r) => r.json() as Promise<BrowsePage>)
  }, [namespace, status, kind, refreshTick])
  const fetchSearch = useCallback(() => {
    if (!query) return Promise.resolve(undefined)
    const p = new URLSearchParams({ q: query })
    if (namespace) p.set("namespace", namespace)
    return fetch(`/api/memory/search?${p}`).then((r) => r.json() as Promise<SearchGroups>)
  }, [query, namespace])

  const stats = usePolling(fetchStats, 2000, live)
  const page = usePolling(fetchPage, 2000, live && !query)
  const search = usePolling(fetchSearch, 2000, false)

  const records = query
    ? (search?.groups.flatMap((g) => g.records) ?? [])
    : (page?.records ?? [])

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2">
        <h1 className="text-sm font-semibold">Memory Inspector</h1>
        <Badge variant="active">{stats?.byStatus.active ?? 0} active</Badge>
        <Badge variant="candidate">{stats?.byStatus.candidate ?? 0} candidates</Badge>
        <Badge variant="superseded">{stats?.byStatus.superseded ?? 0} superseded</Badge>
        <Input
          placeholder="Search memories (recall-equivalent)…"
          className="max-w-md flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm">
          <option value="">Status: all</option>
          <option value="active">active</option>
          <option value="candidate">candidate</option>
          <option value="superseded">superseded</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm">
          <option value="">Kind: all</option>
          <option value="semantic">semantic</option>
          <option value="episodic">episodic</option>
          <option value="procedural">procedural</option>
          <option value="reflection">reflection</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> live
        </label>
      </header>
      <div className="flex min-h-0 flex-1">
        <FacetRail stats={stats} selected={namespace} onSelect={setNamespace} />
        <main className="min-w-0 flex-1 overflow-auto">
          {records.length === 0 ? (
            <p className="p-8 text-sm text-zinc-400">
              {query ? "No matches." : "No memories yet — run your agent and watch them appear."}
            </p>
          ) : (
            <MemoryGrid records={records} onSelect={setSelectedId} />
          )}
        </main>
        {selectedId ? (
          <DetailSheet
            id={selectedId}
            onClose={() => setSelectedId(undefined)}
            onMutated={() => {
              setSelectedId(undefined)
              setRefreshTick((t) => t + 1)
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
```
(`DetailSheet` arrives in Task 8 — create a stub `src/components/memory/detail-sheet.tsx` now so this compiles:)
```tsx
"use client"
export function DetailSheet(_props: { id: string; onClose: () => void; onMutated: () => void }) {
  return null
}
```

`app/memory/page.tsx`:
```tsx
import { ListPage } from "../../src/components/memory/list-page"

export default function MemoryPanelPage() {
  return <ListPage />
}
```
`app/page.tsx`:
```tsx
import { redirect } from "next/navigation"

export default function Home() {
  redirect("/memory")
}
```

- [ ] **Step 6: Component test (jsdom)**

Update `vitest.config.ts` to two projects (node e2e + jsdom components):
```ts
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      { extends: true, test: { name: "e2e", include: ["test/**/*.e2e.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 } },
      { extends: true, test: { name: "components", include: ["test/components/**/*.test.tsx"], environment: "jsdom" } },
    ],
  },
})
```

`packages/inspector/test/components/list.test.tsx`:
```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ListPage } from "../../src/components/memory/list-page"

const record = {
  id: "m1", kind: "semantic", namespace: "route=/notes", content: "acme threshold is 500",
  data: {}, source: { type: "tool", id: "remember" }, confidence: 1, tags: [],
  status: "candidate", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z",
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("renders stats badges and the seeded row", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/api/memory/stats"))
      return Response.json({ total: 1, byStatus: { candidate: 1 }, byKind: { semantic: 1 }, byNamespace: { "route=/notes": 1 }, bySourceType: { tool: 1 } })
    if (url.includes("/api/memory/list")) return Response.json({ records: [record], total: 1 })
    return Response.json({})
  }))
  render(<ListPage />)
  await waitFor(() => {
    expect(screen.getByText("1 candidates")).toBeDefined()
    expect(screen.getByText("acme threshold is 500")).toBeDefined()
  })
})
```

- [ ] **Step 7: Run + commit**

```bash
pnpm --filter @dawn-ai/inspector test
pnpm --filter @dawn-ai/inspector build && pnpm --filter @dawn-ai/inspector typecheck
git rev-parse --abbrev-ref HEAD
git add packages/inspector pnpm-lock.yaml
git commit -m "feat(inspector): list view — pretable grid, facet rail, filters, live polling"
```

---

### Task 8: Detail sheet + approve/supersede flow

**Files:**
- Modify: `packages/inspector/src/components/memory/detail-sheet.tsx` (replace stub)
- Test: `packages/inspector/test/components/detail-sheet.test.tsx` (create)

- [ ] **Step 1: Implement the sheet** (no radix needed — a fixed-position panel; matches the approved layout-B mock)

`src/components/memory/detail-sheet.tsx`:
```tsx
"use client"
import { useCallback, useEffect, useState } from "react"
import type { MemoryRecord } from "@dawn-ai/memory"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"

interface ApproveResponse {
  action: "activated" | "superseded" | "deduped"
  superseded: MemoryRecord[]
  identityFallback: boolean
  error?: string
}

export function DetailSheet({
  id,
  onClose,
  onMutated,
}: {
  id: string
  onClose: () => void
  onMutated: () => void
}) {
  const [rec, setRec] = useState<MemoryRecord | undefined>()
  const [conflict, setConflict] = useState<MemoryRecord | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = (await (await fetch(`/api/memory/${encodeURIComponent(id)}`)).json()) as MemoryRecord
      if (!alive) return
      setRec(r)
      // Candidate? Probe for an identity conflict via recall on the same namespace.
      if (r.status === "candidate") {
        const res = (await (
          await fetch(`/api/memory/list?namespacePrefix=${encodeURIComponent(r.namespace)}&status=active&limit=1000`)
        ).json()) as { records: MemoryRecord[] }
        if (!alive) return
        const twin = res.records.find(
          (a) =>
            a.namespace === r.namespace &&
            JSON.stringify([a.data.subject, a.data.predicate]) === JSON.stringify([r.data.subject, r.data.predicate]) &&
            JSON.stringify(a.data) !== JSON.stringify(r.data),
        )
        setConflict(twin)
      }
    })()
    return () => {
      alive = false
    }
  }, [id])

  const act = useCallback(
    async (verb: "approve" | "reject" | "forget") => {
      setBusy(true)
      setError(undefined)
      const res = await fetch(`/api/memory/${encodeURIComponent(id)}/${verb}`, { method: "POST" })
      const body = (await res.json()) as ApproveResponse
      setBusy(false)
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }
      onMutated()
    },
    [id, onMutated],
  )

  if (!rec) return null
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-200 bg-white shadow-xl" data-testid="detail-sheet">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 p-4">
        <Badge variant={rec.status as "active" | "candidate" | "superseded"}>{rec.status}</Badge>
        <Badge>{rec.kind}</Badge>
        <Badge className="font-mono">{rec.namespace}</Badge>
        <span className="w-full font-mono text-[10px] text-zinc-400">{rec.id}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        <Field label="content">{rec.content}</Field>
        <Field label="data">
          <pre className="rounded-md border border-zinc-100 bg-zinc-50 p-2 font-mono text-xs">{JSON.stringify(rec.data, null, 2)}</pre>
        </Field>
        <Field label="tags">{rec.tags.length > 0 ? rec.tags.join(", ") : "—"}</Field>
        <Field label="source">{`${rec.source.type} · ${rec.source.id}`}</Field>
        <Field label="confidence">{String(rec.confidence)}</Field>
        <Field label="timestamps">{`created ${rec.createdAt} · updated ${rec.updatedAt}`}</Field>
        {rec.supersedes?.length ? <Field label="supersedes">{rec.supersedes.join(", ")}</Field> : null}
        {conflict ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3" data-testid="supersede-callout">
            <p className="text-xs font-semibold text-amber-800">⚠ Approving will supersede an active memory</p>
            <pre className="mt-1 font-mono text-xs">
              <span className="text-red-700">– active: {JSON.stringify(conflict.data)}  ({conflict.id})</span>
              {"\n"}
              <span className="text-green-700">+ this:   {JSON.stringify(rec.data)}</span>
            </pre>
          </div>
        ) : null}
        {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 p-4">
        {rec.status === "candidate" ? (
          <>
            <Button disabled={busy} onClick={() => act("approve")}>
              {conflict ? "Approve & supersede" : "Approve"}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Reject (delete) this candidate?")) void act("reject")
              }}
            >
              Reject
            </Button>
          </>
        ) : null}
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Permanently forget this memory?")) void act("forget")
          }}
        >
          Forget
        </Button>
        <span className="flex-1" />
        <Button variant="outline" onClick={() => navigator.clipboard.writeText(JSON.stringify(rec, null, 2))}>
          Copy JSON
        </Button>
        <Button variant="outline" onClick={onClose}>
          ✕
        </Button>
      </div>
    </aside>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="text-zinc-800">{children}</div>
    </div>
  )
}
```
NOTE (documented limitation, fine for v1): the callout's conflict probe uses the default `subject`/`predicate` identity client-side for DISPLAY only — the actual approve action resolves the route's real identity server-side. When they disagree, the server response is authoritative.

- [ ] **Step 2: Component test**

`packages/inspector/test/components/detail-sheet.test.tsx`:
```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { DetailSheet } from "../../src/components/memory/detail-sheet"

const candidate = {
  id: "cand", kind: "semantic", namespace: "route=/notes", content: "threshold is 750",
  data: { subject: "acme", predicate: "threshold", value: "750" },
  source: { type: "tool", id: "remember" }, confidence: 1, tags: [], status: "candidate",
  createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z",
}
const active = { ...candidate, id: "old", status: "active", data: { subject: "acme", predicate: "threshold", value: "500" } }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("shows the supersede callout when a contradicting active exists", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("/api/memory/cand")) return Response.json(candidate)
    if (url.includes("/api/memory/list")) return Response.json({ records: [active], total: 1 })
    return Response.json({})
  }))
  render(<DetailSheet id="cand" onClose={() => {}} onMutated={() => {}} />)
  await waitFor(() => {
    expect(screen.getByTestId("supersede-callout")).toBeDefined()
    expect(screen.getByText("Approve & supersede")).toBeDefined()
  })
})

it("shows plain Approve when no conflict", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("/api/memory/cand")) return Response.json(candidate)
    if (url.includes("/api/memory/list")) return Response.json({ records: [], total: 0 })
    return Response.json({})
  }))
  render(<DetailSheet id="cand" onClose={() => {}} onMutated={() => {}} />)
  await waitFor(() => {
    expect(screen.getByText("Approve")).toBeDefined()
    expect(screen.queryByTestId("supersede-callout")).toBeNull()
  })
})
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dawn-ai/inspector test
pnpm --filter @dawn-ai/inspector build && pnpm --filter @dawn-ai/inspector typecheck && pnpm --filter @dawn-ai/inspector lint
git rev-parse --abbrev-ref HEAD
git add packages/inspector
git commit -m "feat(inspector): detail sheet with approve/supersede flow, reject, forget, copy JSON"
```

---

### Task 9: `dawn inspect` command

**Files:**
- Create: `packages/cli/src/commands/inspect.ts`
- Modify: `packages/cli/src/index.ts` (register)
- Test: `packages/cli/test/inspect-command.test.ts` (create)

- [ ] **Step 1: Failing test**

`packages/cli/test/inspect-command.test.ts`:
```ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveInspectorServer } from "../src/commands/inspect.js"

describe("resolveInspectorServer", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("returns the hint when @dawn-ai/inspector is not installed", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "dawn-inspect-"))
    dirs.push(appRoot)
    const res = resolveInspectorServer(appRoot)
    expect(res).toBeNull()
  })

  it("resolves the standalone server path from the package's dawnInspector field", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "dawn-inspect-"))
    dirs.push(appRoot)
    const pkgDir = join(appRoot, "node_modules", "@dawn-ai", "inspector")
    mkdirSync(join(pkgDir, ".next"), { recursive: true })
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@dawn-ai/inspector", dawnInspector: { server: ".next/standalone/packages/inspector/server.js" } }),
    )
    writeFileSync(join(pkgDir, ".next", "server-placeholder"), "")
    const res = resolveInspectorServer(appRoot)
    expect(res).toBe(join(pkgDir, ".next/standalone/packages/inspector/server.js"))
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @dawn-ai/cli test inspect-command
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/cli/src/commands/inspect.ts`**

```ts
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import type { Command } from "commander"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { loadEnvFiles } from "../lib/dev/load-env.js"

interface InspectOptions {
  readonly cwd?: string
  readonly port?: string
  readonly envFile?: string
}

const INSTALL_HINT =
  "The Dawn Inspector is not installed in this app.\n  npm i -D @dawn-ai/inspector\nthen re-run `dawn inspect`."

/** Resolve the inspector's standalone server.js from the APP's node_modules, or null. */
export function resolveInspectorServer(appRoot: string): string | null {
  const require = createRequire(join(appRoot, "package.json"))
  let pkgJsonPath: string
  try {
    pkgJsonPath = require.resolve("@dawn-ai/inspector/package.json")
  } catch {
    return null
  }
  const pkg = require(pkgJsonPath) as { dawnInspector?: { server?: string } }
  const rel = pkg.dawnInspector?.server
  if (!rel) return null
  return join(dirname(pkgJsonPath), rel)
}

export function registerInspectCommand(program: Command, io: CommandIo): void {
  program
    .command("inspect")
    .description("Open the Dawn Inspector (memory panel) for this app")
    .option("--cwd <path>", "Path to the Dawn app root")
    .option("--port <number>", "Port to serve the inspector on")
    .option("--env-file <path>", "Env file to load (e.g. for the embedder's API key)")
    .action(async (options: InspectOptions) => {
      await runInspectCommand(options, io)
    })
}

export async function runInspectCommand(options: InspectOptions, io: CommandIo): Promise<void> {
  const appRoot = resolve(options.cwd ?? process.cwd())
  const serverJs = resolveInspectorServer(appRoot)
  if (!serverJs) {
    writeLine(io, INSTALL_HINT)
    return
  }
  if (options.envFile) loadEnvFiles([resolve(appRoot, options.envFile)])
  const port = options.port ? Number(options.port) : await allocateFreePort()
  if (Number.isNaN(port)) throw new CliError(`invalid --port ${options.port}`)
  const url = `http://127.0.0.1:${port}`
  const child = spawn("node", [serverJs], {
    env: { ...process.env, DAWN_APP_ROOT: appRoot, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "inherit", "inherit"],
  })
  const shutdown = () => {
    child.kill("SIGTERM")
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  await waitForReady(`${url}/healthz`)
  writeLine(io, `Dawn Inspector ready at ${url}`)
  openBrowser(url)
  await new Promise<void>((resolveExit) => child.on("exit", () => resolveExit()))
}

async function waitForReady(healthUrl: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(healthUrl)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new CliError(`inspector did not become ready at ${healthUrl}`)
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref()
  } catch {
    // best-effort — the URL is printed either way
  }
}

async function allocateFreePort(): Promise<number> {
  const { createServer } = await import("node:net")
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") srv.close(() => resolvePort(addr.port))
      else reject(new Error("port allocation failed"))
    })
  })
}
```
Adaptations: check `loadEnvFiles`'s real signature in `packages/cli/src/lib/dev/load-env.js` (it may take `{flag}`-style options — mirror how `dev-session.ts:40-43` calls it). Register in `packages/cli/src/index.ts` next to `registerMemoryCommand`: `registerInspectCommand(program, io)` + the import.

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @dawn-ai/cli test inspect-command
pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint
git rev-parse --abbrev-ref HEAD
git add packages/cli
git commit -m "feat(cli): dawn inspect — spawn the inspector standalone server, localhost-bound"
```

---

### Task 10: CI lane + full-repo validate

**Files:**
- Modify: `.github/workflows/ci.yml`, `turbo.json` (only if inspector's build needs a task entry — inspect existing config first; `build` is likely already `"dependsOn": ["^build"]` generic)

- [ ] **Step 1: Add the gated e2e lane**

In `.github/workflows/ci.yml`, model a new `inspector-e2e` job on the existing `pgvector-docker` job (same checkout/pnpm/node setup steps — copy them), but no Docker needed:
```yaml
  inspector-e2e:
    name: inspector-e2e
    runs-on: ubuntu-latest
    steps:
      # ...same checkout + pnpm/node setup as pgvector-docker...
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run build --filter=@dawn-ai/inspector...
      - run: DAWN_TEST_INSPECTOR=1 pnpm --filter @dawn-ai/inspector test
```
(`--filter=@dawn-ai/inspector...` builds the inspector AND its workspace deps — the pgvector lane's #320 lesson: full topological build.)

- [ ] **Step 2: Full validate locally**

```bash
pnpm build && pnpm typecheck && pnpm test
```
Expected: green across the workspace (default lanes DON'T run inspector e2e — it's env-gated; component tests DO run). If `pnpm build` chokes on the inspector's `next build` in any lane that shouldn't build it, scope with turbo filters the way the repo's root scripts already do — inspect `package.json` root scripts first.

- [ ] **Step 3: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add .github/workflows/ci.yml turbo.json
git commit -m "ci: gated inspector-e2e lane (standalone server + API over seeded store)"
```

---

### Task 11: Scaffold wiring + examples/memory dogfood

**Files:**
- Modify: the `SCAFFOLD_PACKAGES` list (locate: `grep -rn "SCAFFOLD_PACKAGES" test/ packages/cli/test/` — per repo memory it's the consolidated list from PR #204), `packages/devkit/templates/app-research/package.json.template` (+ `app-basic` template if it also lists dev tools — check), `packages/create-dawn-app/src/index.ts` (specifier threading, mirror `dawnTesting`), `packages/devkit/src/testing/generated-app.ts` (mirror `dawnTesting`/`dawnEvals`), `test/generated/*.expected.json` fixtures + `createExpectedInternalFixture` remap in `test/generated/run-generated-app.test.ts`
- Modify: `examples/memory/server/package.json`

- [ ] **Step 1: Follow the GOTCHA-4 checklist exactly** (from repo memory `project_npm_release.md` GOTCHA 4 — it enumerates every touchpoint). Add `@dawn-ai/inspector`:
  1. `SCAFFOLD_PACKAGES` — one line.
  2. Template `package.json.template` devDependencies: `"@dawn-ai/inspector": "{{dawnInspectorSpecifier}}"`.
  3. `packages/create-dawn-app/src/index.ts`: thread `dawnInspectorSpecifier` (copy the `dawnTestingSpecifier` pattern end-to-end).
  4. `packages/devkit/src/testing/generated-app.ts`: mirror the `dawnTesting` wiring.
  5. Update `basic.expected.json` / `custom-app-dir.expected.json` + the `<repo:...>` remap in `createExpectedInternalFixture` (devDeps + overrides).

- [ ] **Step 2: examples/memory dogfood**

In `examples/memory/server/package.json` add:
```json
  "devDependencies": { "@dawn-ai/inspector": "workspace:*" },
  "scripts": { "inspect": "node node_modules/@dawn-ai/cli/dist/index.js inspect" }
```
(Merge into existing blocks — don't clobber.) Run `pnpm install`.

- [ ] **Step 3: Verify the three harness lanes** (repo memory: run all three before pushing scaffold-dep changes)

```bash
pnpm verify:harness:framework
pnpm verify:harness:runtime
pnpm verify:harness:smoke
```
Expected: green. macOS-only `/private/tmp` runtime-contract failures are known-false — don't chase (they pass on CI Linux). NOTE the harness now packs the inspector tarball — record the packing-time delta; if a lane times out, raise its timeout rather than dropping the package (and flag it in the PR).

- [ ] **Step 4: Manual dogfood smoke (the point of the feature)**

```bash
cd examples/memory/server && pnpm inspect
```
Expected: browser opens the inspector on the example's sqlite store. Ctrl-C exits cleanly. (If the store is empty, run the example's agent once first — see `examples/memory/README` — or `dawn memory list` to confirm state.)

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add -A
git commit -m "feat(scaffold): @dawn-ai/inspector ships as a scaffold devDep; examples/memory dogfood script"
```

---

### Task 12: Docs, changeset, final validate

**Files:**
- Create: `apps/web/content/docs/inspector.mdx`, `apps/web/app/docs/inspector/page.tsx`
- Modify: `apps/web/app/components/docs/nav.ts`, `apps/web/content/docs/memory.mdx` (cross-link + browse/stats upgrade note), `apps/web/content/docs/upgrading.mdx` (breaking note), `docs/dev/memory-system.md` (inspector shipped)
- Create: `.changeset/memory-inspector.md`

- [ ] **Step 1: Docs page** — `apps/web/content/docs/inspector.mdx` covering: what it is (browser inspector, Memory panel first), `dawn inspect` (+ `--port`, `--env-file`), that scaffolded apps ship it / `npm i -D @dawn-ai/inspector` otherwise, which store it inspects (the live `dawn.config.ts` store — any custom store works), the two caveats (own process → second store instance; config-constructible stores only), approve-with-reconcile semantics, search = recall-equivalent (hybrid when an embedder + key are configured), localhost-only + destructive-action note. Register per repo memory: `page.tsx` wrapper (copy `apps/web/app/docs/memory/page.tsx`'s shape) + `DOCS_NAV` entry in `apps/web/app/components/docs/nav.ts` under the Memory entry. Run `node apps/web/scripts/check-docs.mjs` if that's the checker path (`grep package.json for check-docs`).

- [ ] **Step 2: Upgrade note** in `upgrading.mdx`:
```md
## MemoryStore now requires `browse` and `stats`

Custom `MemoryStore` implementations must add two methods (the built-in sqlite and
pgvector stores already have them): `browse(q?)` — cross-namespace listing ordered
`updated_at DESC, id ASC` returning `{ records, total }` — and `stats(opts?)` —
aggregate count maps. `runMemoryStoreConformance` from `@dawn-ai/testing` covers
both; run it against your store.
```
And in `memory.mdx`: link the inspector page from the memory-CLI section; note `dawn memory approve` now reconciles supersession.

- [ ] **Step 3: Add `@dawn-ai/inspector` to the fixed version group**

In `.changeset/config.json`, add `"@dawn-ai/inspector"` to the `fixed[0]` array (alphabetical position, after `"@dawn-ai/evals"`). Verify: `git diff .changeset/config.json` shows exactly one added entry.

- [ ] **Step 4: Changeset** — `.changeset/memory-inspector.md`:
```md
---
"@dawn-ai/inspector": patch
"@dawn-ai/memory": patch
"@dawn-ai/memory-pgvector": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

New `@dawn-ai/inspector`: a browser-based runtime inspector (`dawn inspect`) with a
Memory panel — browse, search (recall-equivalent hybrid), inspect, and govern
memories with supersede-aware approval. Ships as a scaffold devDependency.

BREAKING: `MemoryStore` now requires `browse(q?)` and `stats(opts?)`; custom stores
must implement them (sqlite/pgvector built-ins already do, and
`runMemoryStoreConformance` enforces the contract). The config-facing store type is
now the full `MemoryStore` contract. `dawn memory approve` now supersedes a
contradicting active row instead of leaving two actives.
```

- [ ] **Step 5: Full validate + lint sweep**

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm turbo run lint 2>&1 | tail -5
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add apps/web docs .changeset
git commit -m "docs(inspector): inspector page + upgrade notes; changeset (patch, breaking browse/stats stated)"
```

---

## Post-plan notes for the controller

- **Task order is dependency order**: 1 (spike) → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Task 6+ depend on 2/5; Task 9 is independent of 6-8 and may interleave.
- **Release**: `@dawn-ai/inspector` is a NEW package → OIDC bootstrap before merging the next Version PR (GOTCHA 1/7), and it must be added to `.changeset/config.json`'s `fixed[0]` array (do this in Task 12 — verify with `git diff .changeset/config.json`). ← add to Task 12 if missed.
- **pretable feedback** collected along the way (missing row-click API, theming gaps) goes in the PR description — dogfooding is a deliverable.
- The final PR should list the spike's measured numbers (build time, standalone size, tarball size, harness delta).
