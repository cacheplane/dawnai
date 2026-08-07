# Edge targets PR3 — the `hono` build target + workerd proof

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `hono` build target that emits a ready-to-deploy edge entry point, and prove it
by running a real Dawn turn — with durable Postgres state — inside real Cloudflare workerd.

**Architecture:** `dawn build` gains a third target. It emits `modules.edge.mjs` (the static
manifest with no `node:path`/`node:url`), `stores.mjs` (a **per-request** store factory),
`app.mjs` (a Hono app wrapping `createRuntimeFetchHandler` from `@dawn-ai/cli/fetch`), and a
`wrangler.toml` scaffold. Two enabling changes land first: `@dawn-ai/postgres-storage` stops
value-importing `pg` so it can bundle for the edge, and the runtime gains a per-request store
seam so a Neon pool can be built and torn down per request.

**Tech Stack:** TypeScript, esbuild, Hono, `@neondatabase/serverless` (WebSocket path), wrangler
/ workerd, Testcontainers (`postgres:16-alpine` + `ghcr.io/neondatabase/wsproxy`), vitest.

---

## Why this shape — read before starting

The 2026-08-07 spike (`docs/superpowers/specs/2026-08-05-edge-targets-design.md`, PR3 section)
ran the real built `packages/postgres-storage/dist` under real workerd. Three of its findings are
load-bearing here, and two of them contradict what the spec originally said:

1. **A module-scope pool hangs 50% of requests on workerd.** Not an error — a ~30s hang until the
   runtime cancels, alternating request-by-request, because an idle WebSocket returned to the pool
   belongs to a dead I/O context. This is why T2 exists and why `stores.mjs` is a **factory**, not
   a module-scope instance. Do not "simplify" it back.
2. **`@dawn-ai/postgres-storage` does not bundle for the edge today.** `checkpointer.ts`,
   `threads.ts`, and `permissions.ts` each *value*-import `Pool` from `pg`; bundling the current
   `dist` on `platform: browser` fails with 17 unresolved-builtin errors. T1 fixes this.
3. **`nodejs_compat` is not required.** A bare `name`/`main`/`compatibility_date` boots the
   handler. Do not add the flag "just in case" — it would mask a regression in the purity work
   PR2a shipped.

Transactions and `pg_advisory_xact_lock` are confirmed intact on the WebSocket path. **Do not
weaken `internal/tx.ts` or `runMigrations`** — a negative control in PR2b proved 8 concurrent
cold-start migrations produce 7 crashes without the advisory lock.

**Environment:** Node ≥24 is required. Prefix every shell invocation with:

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
```

**Known flakes, not your bug:** process-spawning CLI suites (`dev-command`, `run-command`,
`typegen-command`) fail under machine load. Check `uptime`; if load is high, re-run the specific
suite before investigating.

---

## File structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/postgres-storage/src/sql.ts` | Structural `SqlPool`/`SqlClient`/`SqlResult` types |
| `packages/postgres-storage/src/node.ts` | Node-only entry: `connectionString` convenience over `pg` |
| `packages/postgres-storage/test/edge-bundle.test.ts` | Proves the main entry links on `platform: browser` |
| `packages/postgres-storage/test/driver-structural.test.ts` | Pins both drivers against the structural type |
| `packages/cli/src/lib/build/targets/hono.ts` | The `hono` build target |
| `packages/cli/src/lib/build/targets/edge-modules-emitter.ts` | `emitEdgeModulesFile` |
| `packages/cli/src/lib/build/targets/edge-capabilities.ts` | Build-time capability gating |
| `packages/cli/test/edge-modules-emitter.test.ts` | Emitter goldens + hostile inputs |
| `packages/cli/test/hono-target.test.ts` | Target wiring + gating errors |
| `packages/cli/test/hono-node-roundtrip.test.ts` | Hono-on-Node turn (ungated) |
| `packages/cli/test/static-edge-equivalence.test.ts` | node-static vs edge-static equivalence |
| `packages/postgres-storage/test/workerd-lane.test.ts` | Gated real-workerd lane |

**Modified:** `packages/postgres-storage/src/{options,checkpointer,threads,permissions,schema,index}.ts`
and `internal/tx.ts`; `packages/postgres-storage/package.json`;
`packages/cli/src/lib/dev/runtime-fetch-core.ts` and `runtime-server.ts`;
`packages/cli/src/lib/build/targets/index.ts`; `packages/cli/src/commands/{build,check}.ts`;
`packages/core/src/types.ts`; `.github/workflows/ci.yml`; `apps/web/content/docs/{deployment,cli}.mdx`.

---

### Task 1: `postgres-storage` — structural pool type, `pg` type-only, `/node` entry

**Files:**
- Create: `packages/postgres-storage/src/sql.ts`, `packages/postgres-storage/src/node.ts`
- Modify: `packages/postgres-storage/src/options.ts`, `checkpointer.ts:10,149`, `threads.ts:1,108`,
  `permissions.ts:3,74`, `schema.ts:1`, `internal/tx.ts:1`, `index.ts`, `package.json`
- Test: `packages/postgres-storage/test/driver-structural.test.ts`,
  `packages/postgres-storage/test/edge-bundle.test.ts`

**⚠️ This is a breaking change to a package published one day ago (0.8.18).** The main entry's
options lose `connectionString`; it moves to `@dawn-ai/postgres-storage/node`. That is deliberate
— a value import of `pg` cannot coexist with an edge-linkable main entry. Precedent for shipping a
breaking removal as a patch in the fixed 0.x group exists (#392). Say so explicitly in the
changeset (Task 9); do not soften it.

- [ ] **Step 1: Write the failing structural-type test**

Add `@neondatabase/serverless@^1.1.0` to `packages/postgres-storage` devDependencies first
(`pnpm add -D --filter @dawn-ai/postgres-storage @neondatabase/serverless@^1.1.0`).

```ts
// packages/postgres-storage/test/driver-structural.test.ts
import { neon, Pool as NeonPool, type PoolClient as NeonPoolClient } from "@neondatabase/serverless"
import { Pool as PgPool, type PoolClient as PgPoolClient } from "pg"
import { describe, expect, it } from "vitest"
import type { SqlClient, SqlPool } from "../src/sql.js"

describe("structural SqlPool", () => {
  it("accepts both the node pg pool and the neon WebSocket pool", () => {
    // Compile-time assertions; the runtime body only has to not throw.
    const assignable = (_pool: SqlPool): void => {}
    const assignableClient = (_client: SqlClient): void => {}
    expect(assignable).toBeTypeOf("function")
    expect(assignableClient).toBeTypeOf("function")
    // Type-level: these lines fail `tsc` if the structural type drifts.
    type _A = PgPool extends SqlPool ? true : never
    type _B = NeonPool extends SqlPool ? true : never
    type _C = PgPoolClient extends SqlClient ? true : never
    type _D = NeonPoolClient extends SqlClient ? true : never
    const _checks: [_A, _B, _C, _D] = [true, true, true, true]
    expect(_checks).toEqual([true, true, true, true])
  })

  it("REJECTS neon's transaction-incapable HTTP function", () => {
    // The structural type is itself the guard: neon() has no connect()/end(),
    // so it cannot serve the checkpointer's BEGIN/COMMIT. This must stay a
    // type error — @ts-expect-error fails the build if it ever becomes valid.
    // @ts-expect-error - neon() returns a query function, not a pool
    const _bad: SqlPool = neon("postgres://user:pass@localhost/db")
    expect(typeof neon).toBe("function")
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @dawn-ai/postgres-storage test -- driver-structural
```

Expected: FAIL — `Cannot find module '../src/sql.js'`.

- [ ] **Step 3: Write `src/sql.ts`**

```ts
/**
 * The minimal Postgres driver surface these stores actually use.
 *
 * Typed structurally rather than as `pg.Pool` so an edge deploy can pass
 * `@neondatabase/serverless`'s WebSocket pool with no driver abstraction and no
 * extra dependency here. The narrowness is deliberate and load-bearing:
 * `neon()`'s HTTP function exposes no `connect()`, so it fails to satisfy
 * `SqlPool` at compile time — which is exactly right, because it has no
 * sessions and therefore cannot serve the checkpointer's BEGIN/COMMIT.
 *
 * Verified 2026-08-07 against pg 8.22.0 and @neondatabase/serverless 1.1.0;
 * `test/driver-structural.test.ts` pins it so a driver bump cannot drift it.
 */
export interface SqlResult<R> {
  readonly rows: R[]
}

/** A checked-out connection: what `withTransaction` holds for BEGIN/COMMIT. */
export interface SqlClient {
  query<R = any>(sql: string, values?: readonly unknown[]): Promise<SqlResult<R>>
  release(): void
}

/** A connection pool. */
export interface SqlPool {
  query<R = any>(sql: string, values?: readonly unknown[]): Promise<SqlResult<R>>
  connect(): Promise<SqlClient>
  end(): Promise<void>
}
```

- [ ] **Step 4: Swap the stores onto the structural type**

In `options.ts`, replace `import type { Pool } from "pg"` with
`import type { SqlPool } from "./sql.js"`, change `readonly pool?: Pool` to
`readonly pool?: SqlPool`, and **delete the `connectionString` field** (moving its doc comment to
`node.ts`). Make the option required in spirit by documenting it:

```ts
  /**
   * The pool every store call goes through. Required on this entry — build one
   * with `pg` yourself, or import from `@dawn-ai/postgres-storage/node` for the
   * `connectionString` convenience. On an edge runtime pass a per-request pool
   * (see the edge deployment docs): a module-scope pool hangs on workerd.
   */
  readonly pool?: SqlPool
```

In `internal/tx.ts` and `schema.ts`, replace the `pg` type imports with
`import type { SqlClient, SqlPool } from "../sql.js"` (resp. `"./sql.js"`) and substitute
`SqlPool` for `Pool`, `SqlClient` for `PoolClient`.

In `checkpointer.ts:10`, `threads.ts:1`, and `permissions.ts:3`, **delete the `pg` import
entirely**. At each `new Pool(...)` site (`checkpointer.ts:149`, `threads.ts:108`,
`permissions.ts:74`), replace the fallback with a loud failure:

```ts
  const pool = options.pool ?? throwNoPool()
```

and add to `src/sql.ts`:

```ts
/** No pool, no store — say which entry point supplies one. */
export function throwNoPool(): never {
  throw new Error(
    "postgres-storage: `pool` is required. Pass a pg.Pool (or any driver with " +
      "{ query, connect, end }), or import from `@dawn-ai/postgres-storage/node` " +
      "to build one from a connection string.",
  )
}
```

- [ ] **Step 5: Write `src/node.ts`**

```ts
/**
 * Node-only entry: the `connectionString` convenience.
 *
 * Kept out of the main entry because a *value* import of `pg` pulls net/tls/dns
 * into the module graph, which makes the package unlinkable on an edge runtime
 * (verified: 17 unresolved-builtin errors bundling on platform: browser).
 */
import { Pool } from "pg"
import { postgresCheckpointer as basePostgresCheckpointer } from "./checkpointer.js"
import type { PostgresStoreOptions } from "./options.js"
import { createPostgresPermissionsStore as baseCreatePermissionsStore } from "./permissions.js"
import { createPostgresThreadsStore as baseCreateThreadsStore } from "./threads.js"

/** Main-entry options plus the connection string this entry can act on. */
export interface NodePostgresStoreOptions extends PostgresStoreOptions {
  /** Postgres connection string; used to build an owned pool when `pool` is absent. */
  readonly connectionString?: string
}

function withPool<T extends NodePostgresStoreOptions>(options: T): T & { pool: Pool } {
  return {
    ...options,
    pool:
      options.pool ??
      new Pool(options.connectionString ? { connectionString: options.connectionString } : {}),
  } as T & { pool: Pool }
}

export function postgresCheckpointer(options: NodePostgresStoreOptions = {}) {
  return basePostgresCheckpointer(withPool(options))
}

export function createPostgresThreadsStore(options: NodePostgresStoreOptions = {}) {
  return baseCreateThreadsStore(withPool(options))
}

export function createPostgresPermissionsStore(options: NodePostgresStoreOptions = {}) {
  return baseCreatePermissionsStore(withPool(options))
}
```

Note the shape mismatch to resolve while implementing: `withPool` returns a `pg.Pool`, which
satisfies `SqlPool` structurally — no cast to the base option type should be needed. If `tsc`
disagrees, fix the types rather than reaching for `as unknown as`.

- [ ] **Step 6: Export and register**

Add to `src/index.ts`: `export type { SqlClient, SqlPool, SqlResult } from "./sql.js"`.
In `package.json`, add the subpath beside `.`:

```json
    "./node": {
      "types": "./dist/node.d.ts",
      "default": "./dist/node.js"
    }
```

- [ ] **Step 7: Write the edge-bundle test**

Mirror `packages/cli/test/fetch-entry-purity.test.ts:93` (`bundleForBrowser`). Add
`esbuild` to `packages/postgres-storage` devDependencies.

```ts
// packages/postgres-storage/test/edge-bundle.test.ts
import { build } from "esbuild"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const pkgRoot = fileURLToPath(new URL("..", import.meta.url))

/**
 * platform: "browser" with node builtins NOT externalized — any surviving
 * `node:`/`net`/`tls` import is an unresolvable specifier and the build throws.
 * This is what the spike's 17 link errors looked like before pg went type-only.
 */
async function linkForEdge(entry: string): Promise<void> {
  await build({
    absWorkingDir: pkgRoot,
    bundle: true,
    conditions: ["import"],
    entryPoints: [join(pkgRoot, "src", entry)],
    external: ["@langchain/*", "@dawn-ai/permissions"],
    format: "esm",
    mainFields: ["module", "main"],
    platform: "browser",
    write: false,
  })
}

describe("edge linkability", () => {
  it("links the main entry with no node builtins", async () => {
    await expect(linkForEdge("index.ts")).resolves.toBeUndefined()
  }, 120_000)

  it("negative control: the node entry does NOT link", async () => {
    await expect(linkForEdge("node.ts")).rejects.toThrow(/Could not resolve/)
  }, 120_000)
})
```

- [ ] **Step 8: Verify**

```bash
pnpm --filter @dawn-ai/postgres-storage build && pnpm --filter @dawn-ai/postgres-storage test
```

Expected: all green, **including the existing 72 conformance tests unchanged** — run the gated
lane too, since this task rewrites every store's constructor:

```bash
DAWN_TEST_PGSTORAGE=1 pnpm --filter @dawn-ai/postgres-storage test
```

Then update the three `examples/` and docs call sites that pass `connectionString` (grep for
`postgres-storage` across the repo) to import from `/node`.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "refactor(postgres-storage): structural pool type; pg becomes type-only

Three stores value-imported Pool from pg for the connectionString default,
which drags net/tls/dns into the graph and makes the package unlinkable on an
edge runtime. Typing the pool structurally accepts pg and neon alike, and
rejects neon's transaction-incapable HTTP function at compile time."
```

---

### Task 2: per-request store seam in the runtime

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts:87-99` (`RuntimeFetchHandler`),
  `:101` (factory), `:158-200` (store resolution), `:228-243` (`buildRouteTable` call),
  `:245` (`fetch`), `:401-420` (`buildRouteTable` ctx type); `runtime-server.ts:22-78`
  (`StartRuntimeServerOptions`)
- Test: `packages/cli/test/request-stores.test.ts`

**Why:** `checkpointer` and `threadsStore` accept instances only, and `memoryStore`'s thunk is
memoized process-wide (deliberately — see the `B2.1 T3` perf work; do not undo it). A workerd
deploy needs one pool **per request**, shared by all three stores, and torn down only after the
SSE body has finished. Route handlers close over the store bindings, so per-request resolution
needs a request-scoped lookup.

**Mechanism (mandated):** a `requestStores` option — a per-request factory — plus a `WeakMap`
keyed on the incoming `Request`. Handlers already receive `request`, so the closed-over bindings
become accessors that take it. **Do not use `AsyncLocalStorage`**: it needs `nodejs_compat`, which
the spike proved is otherwise unnecessary.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/request-stores.test.ts
import { describe, expect, it } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import {
  chatFixtureApp,
  fakeMemoryStore,
  fakePermissionsStore,
  memoryThreadsStore,
} from "./helpers/fetch-entry-fixture.js"
import { buildStaticModulesForFixture, runChatTurn, withAimock } from "./helpers/static-modules-fixture.js"

describe("per-request stores", () => {
  it("builds and disposes stores once per request, never reusing them", async () => {
    const app = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(app)
    const built: number[] = []
    const disposed: number[] = []
    let seq = 0

    const handler = await createRuntimeFetchHandler({
      appRoot: app.appRoot,
      modules,
      requestStores: async () => {
        const id = ++seq
        built.push(id)
        return {
          checkpointer: app.checkpointer,
          dispose: async () => {
            disposed.push(id)
          },
          memoryStore: fakeMemoryStore(),
          permissionsStore: fakePermissionsStore(),
          threadsStore: memoryThreadsStore(),
        }
      },
    })

    await handler.fetch(new Request("http://x/healthz"))
    await handler.fetch(new Request("http://x/healthz"))

    expect(built).toEqual([1, 2])
    expect(disposed).toEqual([1, 2])
    await handler.close()
  })

  it("disposes only AFTER an SSE body finishes, not when fetch resolves", async () => {
    const app = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(app)
    let disposedAt: "during-stream" | "after-stream" | undefined
    let streamDone = false

    await withAimock(async (aimock) => {
      const handler = await createRuntimeFetchHandler({
        appRoot: app.appRoot,
        modules,
        requestStores: async () => ({
          checkpointer: app.checkpointer,
          dispose: async () => {
            disposedAt = streamDone ? "after-stream" : "during-stream"
          },
          memoryStore: fakeMemoryStore(),
          permissionsStore: fakePermissionsStore(),
          threadsStore: memoryThreadsStore(),
        }),
      })
      await runChatTurn(handler, aimock)
      streamDone = true
      await handler.close()
    })

    // A pool ended mid-stream breaks the tail of every streaming turn — the
    // exact failure a naive `finally { pool.end() }` would produce on workerd.
    expect(disposedAt).toBe("after-stream")
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @dawn-ai/cli test -- request-stores
```

Expected: FAIL — `requestStores` is not a known option.

- [ ] **Step 3: Add the option type**

In `runtime-server.ts`, beside the existing store options:

```ts
  /**
   * Stores built fresh for each request, then disposed when that request's
   * response (including a streaming SSE body) has fully settled.
   *
   * Exists for edge runtimes whose connections are bound to a request's I/O
   * context: on workerd a module-scope Postgres pool hands request N+1 an idle
   * WebSocket belonging to request N's dead context, which hangs for ~30s until
   * the runtime cancels — alternating, so half of all requests fail. Supplying
   * this replaces the boot-resolved stores for the matching keys.
   */
  readonly requestStores?: (request: Request) => RequestStores | Promise<RequestStores>
```

and the shape:

```ts
/** Per-request store overrides, plus the teardown for whatever they hold open. */
export interface RequestStores {
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  readonly permissionsStore?: PermissionsStore
  readonly memoryStore?: MemoryStore
  /** Called once the response body has settled. Never called mid-stream. */
  readonly dispose?: () => Promise<void>
}
```

- [ ] **Step 4: Thread it through `runtime-fetch-core.ts`**

Add above `buildRouteTable`:

```ts
  // Request-scoped store overrides. Keyed on the Request object rather than
  // carried in AsyncLocalStorage, which would require nodejs_compat on workerd
  // — the whole point of PR2a was that the bundle needs no such flag.
  const perRequest = new WeakMap<Request, RequestStores>()
```

Convert the four closed-over bindings into request-aware accessors and pass those to
`buildRouteTable` (replacing `checkpointer`, `threadsStore`, `permissionsStore`, `getMemoryStore`):

```ts
  const getCheckpointer = (request: Request): BaseCheckpointSaver =>
    perRequest.get(request)?.checkpointer ?? checkpointer
  const getThreadsStore = (request: Request): ThreadsStore =>
    perRequest.get(request)?.threadsStore ?? threadsStore
  const getPermissionsStore = (
    request: Request,
  ): PermissionsStore | (() => Promise<PermissionsStore>) =>
    perRequest.get(request)?.permissionsStore ?? permissionsStore
  const getMemoryStoreFor = (request: Request): Promise<MemoryStore> => {
    const override = perRequest.get(request)?.memoryStore
    // Only the boot path memoizes: a per-request store must not outlive its
    // request, and re-memoizing it would reintroduce the dead-context hang.
    return override ? Promise.resolve(override) : getMemoryStore()
  }
```

Update `buildRouteTable`'s ctx type (`:401`) to take these accessors, and update every handler body
to call them with its own `request`. This is mechanical but wide — `tsc` will enumerate the sites.

In `fetch` (`:245`), populate and dispose:

```ts
    state.activeRequests++
    let transferredToStream = false
    const stores = options.requestStores ? await options.requestStores(request) : undefined
    if (stores) perRequest.set(request, stores)
    const disposeStores = async (): Promise<void> => {
      if (!stores?.dispose) return
      try {
        await stores.dispose()
      } catch {
        // Teardown must never turn a served response into a failure.
      }
    }
```

then in the SSE branch chain disposal onto the existing settle hook, and dispose in the non-stream
path and in `finally`:

```ts
        const tracked = new Response(
          trackStreamSettled(body, () => {
            state.activeRequests--
            void disposeStores()
          }),
          { headers: response.headers, status: response.status },
        )
```

```ts
    } finally {
      if (!transferredToStream) {
        state.activeRequests--
        void disposeStores()
      }
    }
```

- [ ] **Step 5: Run the test**

```bash
pnpm --filter @dawn-ai/cli test -- request-stores
```

Expected: PASS, both cases.

- [ ] **Step 6: Prove node behavior is untouched**

```bash
pnpm --filter @dawn-ai/cli test
```

Expected: the full CLI suite green with **zero test edits**. If a test needed changing, stop and
report — it means the default path changed.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(cli): per-request store seam for edge runtimes

Route handlers closed over boot-resolved store instances, so a connection
bound to one request's I/O context could not be scoped correctly. Adds an
optional requestStores factory keyed by Request, disposed only after the
response body settles so an SSE stream never loses its pool mid-flight."
```

---

### Task 3: `emitEdgeModulesFile`

**Files:**
- Create: `packages/cli/src/lib/build/targets/edge-modules-emitter.ts`
- Modify: `packages/cli/src/lib/build/targets/modules-emitter.ts` (extract shared pieces)
- Test: `packages/cli/test/edge-modules-emitter.test.ts`

The edge manifest differs from `modules.mjs` (`modules-emitter.ts:129`) in exactly three ways:
no `node:path`/`node:url` imports; `appRoot` emitted as a build-time string literal (an opaque
namespace id, not a resolved path); imports of `buildStaticRouteModule` / `normalizeMiddlewareModule`
come from `@dawn-ai/cli/fetch` rather than `@dawn-ai/cli/runtime`.

**Everything else must stay identical, and must stay shared code** — the `JSON.stringify`'d
specifiers, the `JSON.parse`'d state defaults and tool schemas, and the `findNonJsonPath`
round-trip guard (`modules-emitter.ts:301`). Extract the common body into one parameterized
function rather than copying it; a divergent copy is how the hostile-input hardening silently
stops applying to the edge path.

- [ ] **Step 1: Write the golden test**

Mirror `packages/cli/test/modules-emitter.test.ts` exactly — same `fixtureApp()` shape, same
`toMatchInlineSnapshot` approach (leave the snapshot empty and let vitest fill it), same hostile-
input cases (`:228-300`). Add three edge-specific assertions:

```ts
    expect(text).not.toContain("node:path")
    expect(text).not.toContain("node:url")
    expect(text).not.toContain(appRoot) // no build-machine paths
    expect(text).toContain('from "@dawn-ai/cli/fetch"')
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @dawn-ai/cli test -- edge-modules-emitter
```

Expected: FAIL — module not found.

- [ ] **Step 3: Extract the shared emitter core**

In `modules-emitter.ts`, extract the body of `emitModulesFile` into:

```ts
interface ModulesEmitFlavor {
  /** Where buildStaticRouteModule/normalizeMiddlewareModule come from. */
  readonly runtimeSpecifier: string
  /** Emits the `const appRoot = …` line. */
  readonly appRootExpression: (appRoot: string) => string
  /** Extra imports (node path helpers on node; none on edge). */
  readonly preludeImports: readonly string[]
}
```

`emitModulesFile` keeps its current signature and passes the node flavor; the new file passes the
edge flavor. Do not change `emitModulesFile`'s output by one byte — the existing inline snapshot
in `modules-emitter.test.ts` is the guard, and it must pass untouched.

- [ ] **Step 4: Write `edge-modules-emitter.ts`**

```ts
import { emitModulesFileWithFlavor, type RouteStaticDiscovery } from "./modules-emitter.js"

/**
 * The static manifest for an edge bundle.
 *
 * `appRoot` is a build-time literal rather than runtime path math: on an edge
 * runtime there is no `import.meta.url` to resolve against and no filesystem to
 * resolve onto, so the value is only ever an opaque namespace id (thread keys,
 * cache keys). Emitting the literal keeps it stable across machines.
 */
export function emitEdgeModulesFile(options: {
  readonly appRoot: string
  readonly buildDir: string
  readonly discoveries: readonly RouteStaticDiscovery[]
  readonly middlewareFile?: string
}): string {
  return emitModulesFileWithFlavor(options, {
    appRootExpression: (appRoot) => `const appRoot = ${JSON.stringify(appRoot)}\n`,
    preludeImports: [],
    runtimeSpecifier: "@dawn-ai/cli/fetch",
  })
}
```

The `appRoot` literal must be the **app's directory name**, not its absolute path — pass
`pureBasename(appRoot)` from the target in Task 4, and assert in the test that the emitted file
contains no absolute path.

- [ ] **Step 5: Run both emitter suites**

```bash
pnpm --filter @dawn-ai/cli test -- modules-emitter
```

Expected: PASS — the pre-existing node snapshot unchanged, plus the new edge goldens.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(cli): emitEdgeModulesFile sharing the node emitter's hardening"
```

---

### Task 4: the `hono` target — `stores.mjs`, `app.mjs`, `wrangler.toml`

**Files:**
- Create: `packages/cli/src/lib/build/targets/hono.ts`
- Modify: `packages/cli/src/lib/build/targets/index.ts:36-45`, `packages/core/src/types.ts:76-87`
  (doc comment), `packages/cli/src/commands/build.ts:23` (description string)
- Test: `packages/cli/test/hono-target.test.ts`

`hono` is **not** in `DEFAULT_BUILD_TARGETS` — opt in via `build.targets: ["node", "hono"]`.

- [ ] **Step 1: Write the failing target test**

Follow `packages/cli/test/build-targets.test.ts` (`createFixtureApp` `:16`, `runBuild` `:44`).

```ts
  it("emits the four edge artifacts", async () => {
    const app = await createFixtureApp({ targets: ["hono"] })
    const { artifacts } = await runBuild(app)
    expect(artifacts).toEqual(
      expect.arrayContaining(["modules.edge.mjs", "stores.mjs", "app.mjs", "wrangler.toml"]),
    )
  })

  it("preserves an existing wrangler.toml", async () => {
    const app = await createFixtureApp({ targets: ["hono"] })
    await writeFile(join(app.appRoot, "wrangler.toml"), "# mine\n", "utf8")
    await runBuild(app)
    expect(await readFile(join(app.appRoot, "wrangler.toml"), "utf8")).toBe("# mine\n")
  })

  it("builds stores per request, never at module scope", async () => {
    const app = await createFixtureApp({ targets: ["hono"] })
    await runBuild(app)
    const entry = await readFile(join(app.appRoot, ".dawn/build/app.mjs"), "utf8")
    // A module-scope pool hangs half of all requests on workerd (spike,
    // 2026-08-07). The generated entry must pass requestStores, not instances.
    expect(entry).toContain("requestStores")
    expect(entry).not.toMatch(/^const pool = /m)
  })
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @dawn-ai/cli test -- hono-target
```

Expected: FAIL — `Unknown build target "hono"`.

- [ ] **Step 3: Write the target**

`packages/cli/src/lib/build/targets/hono.ts` — `emit(ctx)` runs
`collectRouteStaticDiscovery` per route (as `node.ts:80` does), writes `modules.edge.mjs` via
`emitEdgeModulesFile`, runs the Task 5 capability gate, then writes:

**`stores.mjs`** — the per-request factory. Generated from the app's configured store choice; for
the Postgres path:

```js
// .dawn/build/stores.mjs (generated — do not edit)
import { neonConfig, Pool } from "@neondatabase/serverless"
import { postgresCheckpointer } from "@dawn-ai/postgres-storage"
import { createPostgresPermissionsStore } from "@dawn-ai/postgres-storage"
import { createPostgresThreadsStore } from "@dawn-ai/postgres-storage"

// Set once: these are driver-level switches, not connections.
if (process.env.DAWN_PG_WS_PROXY) {
  neonConfig.useSecureWebSocket = false
  neonConfig.pipelineTLS = false
  neonConfig.pipelineConnect = false
  neonConfig.wsProxy = (host, port) =>
    `${process.env.DAWN_PG_WS_PROXY}/v1?address=${host}:${port}`
}

/**
 * One pool per request, disposed when the response settles.
 *
 * NOT module scope: an idle WebSocket returned to a module-scope pool belongs
 * to the previous request's I/O context, and picking it up hangs for ~30s until
 * workerd cancels — alternating, so half of all requests fail (spike 2026-08-07).
 */
export function createRequestStores(env) {
  const pool = new Pool({ connectionString: env.DATABASE_URL })
  return {
    checkpointer: postgresCheckpointer({ pool }),
    dispose: () => pool.end(),
    permissionsStore: createPostgresPermissionsStore({ pool }),
    threadsStore: createPostgresThreadsStore({ pool }),
  }
}
```

**`app.mjs`** — the Hono entry:

```js
// .dawn/build/app.mjs (generated — do not edit)
import { createRuntimeFetchHandler } from "@dawn-ai/cli/fetch"
import { Hono } from "hono"
import modules from "./modules.edge.mjs"
import { createRequestStores } from "./stores.mjs"

const config = /* inlined DawnConfig literal, non-serializable fields stripped */
const app = new Hono()
let handlerPromise

app.all("*", async (c) => {
  // The handler itself is cheap and stateless to build (static manifest, no
  // filesystem), so it is created once; only the STORES are per request.
  handlerPromise ??= createRuntimeFetchHandler({
    appRoot: APP_ROOT,
    config,
    modules,
    requestStores: () => createRequestStores(c.env),
  })
  const handler = await handlerPromise
  return handler.fetch(c.req.raw)
})

export default app
```

**Implementer note, resolve before writing:** the sketch above closes `requestStores` over the
*first* request's `c.env`, which is wrong for later requests. Bind the environment per request
instead — either build the handler eagerly with a `requestStores` that reads a request-scoped env,
or pass `c.env` through a `WeakMap` keyed on `c.req.raw`. Whichever you choose, add a test that two
requests with **different** `env.DATABASE_URL` values reach different databases. Do not ship the
sketch as written.

Also emit the static provider-importer map (wired via `createChatModel`'s `importer` option) and
mount manifest middleware, per the spec.

**`wrangler.toml`** — written only if absent, following `node.ts`'s `DOCKERFILE_MARKER` precedent
(`:20`, `:128-143`). **No `nodejs_compat`** (spike-verified):

```toml
name = "<app-name>"
main = ".dawn/build/app.mjs"
compatibility_date = "2026-08-01"
```

- [ ] **Step 4: Register**

Add `[honoTarget.name]: honoTarget` to `buildTargets` (`index.ts:36`). Leave
`DEFAULT_BUILD_TARGETS` alone. Update the `types.ts:76-87` doc comment and `build.ts:23`.

Add `hono` to `packages/cli` dependencies (`pnpm add --filter @dawn-ai/cli hono@^4.12.28`) —
today it exists only as a transitive dep.

- [ ] **Step 5: Run the target tests**

```bash
pnpm --filter @dawn-ai/cli test -- hono-target
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(cli): hono build target emitting an edge entry point"
```

---

### Task 5: capability gating — fail the build, loudly and by name

**Files:**
- Create: `packages/cli/src/lib/build/targets/edge-capabilities.ts`
- Modify: `packages/cli/src/lib/build/targets/hono.ts`, `packages/cli/src/commands/check.ts:84-95`
- Test: `packages/cli/test/hono-target.test.ts` (extend)

Per the spec: at emit time, fail the build naming the feature **and** the config key when the app
uses something the edge cannot serve — sandbox configured, workspace/exec/offload tooling, skills
directories, or missing store config for the target. `dawn check` mirrors the same validation when
`hono` is configured. Runtime guards throw the same named errors (defense in depth).

- [ ] **Step 1: Write the failing tests** — one per gated capability, asserting both the feature
      name and the config key appear in the message:

```ts
  it("fails the build when a sandbox is configured", async () => {
    const app = await createFixtureApp({ config: { sandbox: { provider: "docker" } }, targets: ["hono"] })
    await expect(runBuild(app)).rejects.toThrow(
      /hono target.*sandbox.*`sandbox`.*not supported on edge/i,
    )
  })

  it("fails the build when no durable stores are configured", async () => {
    const app = await createFixtureApp({ targets: ["hono"] })  // no checkpointer/threads
    await expect(runBuild(app)).rejects.toThrow(/checkpointer.*threadsStore.*edge/i)
  })
```

- [ ] **Step 2: Run to confirm they fail.** `pnpm --filter @dawn-ai/cli test -- hono-target`

- [ ] **Step 3: Implement `assertEdgeCapabilities(config, manifest)`** returning `CliError` with a
      code in the existing registry (follow `check.ts:84-95`'s `DAWN_E1003` pattern; allocate a new
      code and document it).

- [ ] **Step 4: Mirror in `dawn check`** — when `build.targets` includes `hono`, run the same
      assertion and report each violation as a check failure.

- [ ] **Step 5: Run.** Expected PASS, including `dawn check` cases.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(cli): fail the hono build on capabilities the edge cannot serve"
```

---

### Task 6: Hono-on-Node round-trip (ungated, every CI run)

**Files:**
- Create: `packages/cli/test/hono-node-roundtrip.test.ts`

Builds the fixture app with the `hono` target, boots the emitted `app.mjs` under
`@hono/node-server`, and drives a real turn against Testcontainers Postgres — proving the emitted
entry is functional on every CI run, not only in the gated lane.

- [ ] **Step 1: Write the test** — reuse `packages/cli/test/helpers/static-modules-fixture.ts`
      (`withAimock` `:77`, `runChatTurn` `:96`) and the Testcontainers pattern from
      `packages/postgres-storage/test/`. Assert: AP turn completes; AG-UI SSE event sequence matches
      the node path; **and the thread row is really in Postgres afterward** (query it directly —
      an assertion on the HTTP response alone cannot distinguish durable from in-memory).

- [ ] **Step 2: Add `@hono/node-server` to `packages/cli` devDependencies.**

- [ ] **Step 3: Run.** `pnpm --filter @dawn-ai/cli test -- hono-node-roundtrip`

- [ ] **Step 4: Commit.**

---

### Task 7: static-vs-static-edge equivalence

**Files:**
- Create: `packages/cli/test/static-edge-equivalence.test.ts`

Clone `packages/cli/test/static-equivalence.test.ts` (493 lines) and change run 2 to use
`modules.edge.mjs` + injected per-request stores instead of `modules.mjs`. Reuse its
`normalizeTranscript` (`:332-404`), `ID_KEYS`/`TIMESTAMP_KEYS`/`PRESERVED_IDS`, and — critically —
its **anchor assertions before normalization** (`:434-441`), so two equally-broken runs cannot pass.

- [ ] **Step 1: Write it.** Compare `aguiEventTypes` first, then the full normalized transcript
      including every model request aimock observed.
- [ ] **Step 2: Run.** Expected PASS — the edge wiring produces the same conversation as the node
      wiring.
- [ ] **Step 3: Commit.**

---

### Task 8: the gated workerd lane

**Files:**
- Create: `packages/postgres-storage/test/workerd-lane.test.ts`
- Modify: `.github/workflows/ci.yml`

**Run this locally against real Docker + real wrangler before pushing.** PR2b's lane was written
this way and it is why it passed first time in CI.

- [ ] **Step 1: Write the lane test.** Gate on `DAWN_TEST_WORKERD=1`. Stand up
      `postgres:16-alpine` + `ghcr.io/neondatabase/wsproxy` (`ALLOW_ADDR_REGEX=.*`, **omit
      `APPEND_PORT`** — it concatenates onto the client-supplied address and yields
      "too many colons in address"). Boot the built fixture under `wrangler dev --local`
      (`WRANGLER_SEND_METRICS=false`, no auth). Budget ~60s startup.

      Assert, in this order:
      1. a real turn completes and the AG-UI SSE shape matches;
      2. **the thread, checkpoint, and write rows are in Postgres**, queried out-of-band with a
         direct client — not inferred from the HTTP response;
      3. **at least four sequential requests all succeed.** This is the regression test for the
         module-scope-pool hang: the failure alternates, so a two-request test passes while half
         of production hangs.

- [ ] **Step 2: Run locally.**

```bash
DAWN_TEST_WORKERD=1 pnpm --filter @dawn-ai/postgres-storage test -- workerd-lane
```

- [ ] **Step 3: Add the `edge-workerd` CI job**, copying the `postgres-storage-docker` shape
      (`.github/workflows/ci.yml:165`): SHA-pinned actions, Node `24.17.0`, **full `pnpm build`**
      (not a filtered build — see the `#320` lesson in the `inspector-e2e` comment),
      `timeout-minutes: 30`, and `DAWN_TEST_WORKERD=1`.

      ⚠️ `wrangler` pulls `workerd` and `esbuild` via postinstall scripts. If the repo's pnpm
      config blocks postinstall scripts, the workerd binary will not download and the lane fails at
      startup — check `pnpm-workspace.yaml` / `.npmrc` for `onlyBuiltDependencies` and add
      `workerd`/`esbuild` if needed.

- [ ] **Step 4: Commit.**

---

### Task 9: docs, changeset, full verification, PR

**Files:**
- Modify: `apps/web/content/docs/deployment.mdx:129-159` (the `## Edge runtimes (preview)`
  section, including the "lands in a following release" promise at `:157` and the "up to two
  targets" claim at `:3`), `apps/web/content/docs/cli.mdx:101-116`,
  `apps/web/content/docs/configuration.mdx:263-277`, `faq.mdx:31,41,51`
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Write the docs.** The edge section becomes real: supported-subset table, the
      per-request store requirement **with the reason** (a module-scope pool hangs on workerd), the
      `wrangler.toml` quickstart, `DATABASE_URL` + `@neondatabase/serverless` setup, and the gating
      errors.

      **State the unverified parts plainly**, per the spec: Hyperdrive is untested (needs an
      account); miniflare does not enforce Cloudflare's ~6-simultaneous-outbound-connection or
      1000-subrequest limits, so the CI lane cannot settle production connection behavior; and a
      local wsproxy hides per-query latency, which matters because `putWrites` issues one INSERT per
      write inside the transaction. Do not let the docs imply the lane proves more than it does.

- [ ] **Step 2: Changeset.** Patch bump. Call out the `@dawn-ai/postgres-storage` breaking change
      (`connectionString` moved to `/node`) explicitly.

      ⚠️ Run `node scripts/check-docs.mjs` on the changeset before pushing. Since #407 the guard
      scans `.changeset/*.md` precisely because changeset prose becomes CHANGELOG prose verbatim,
      and a banned phrase that slips through reds `check-docs` on **main** after the release bakes
      it in (#406). Note the guard scans `docs/` too, so the same applies to any plan or spec edit.

- [ ] **Step 3: Full verification.**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Then the gated lanes locally: `DAWN_TEST_PGSTORAGE=1` and `DAWN_TEST_WORKERD=1`.

- [ ] **Step 4: Open the PR** against `main` from `feat/hono-edge-target`, with a body covering:
      what the spike settled, the two mandatory design changes and why, what the workerd lane
      proves, and what remains unverified.

---

## Self-review notes

- **Spec coverage:** `targets/hono.ts` + four artifacts (T4), capability gating + `dawn check`
  mirror (T5), emitter goldens + hostile inputs (T3), Hono-on-Node round-trip (T6), gated workerd
  lane (T8), static-vs-static-edge equivalence (T7), docs (T9). The spike's two mandatory changes
  are T1 and T2. Every spec bullet maps to a task.
- **Deliberate deviations from the spec text**, both spike-driven and recorded in the amended spec:
  `wrangler.toml` carries **no** `nodejs_compat`; `stores.mjs` is a per-request **factory** rather
  than module-scope imports of store instances.
- **Two unknowns handed to implementers rather than guessed**: the `c.env`-per-request binding in
  T4 Step 3 (with a mandated test), and the exact threading of accessors through `buildRouteTable`
  in T2 Step 4 (`tsc` enumerates the sites). Both are called out inline.
