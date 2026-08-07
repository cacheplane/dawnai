# Edge targets (Hono-first) — design

**Date:** 2026-08-05
**Status:** approved (brainstorm)
**Epic:** Deploy-anywhere. This is **sub-project B3** of three: B1 (#373) gave the runtime a
`(Request) => Promise<Response>` core; B2 (#379 + #382) moved module wiring to build time
(`.dawn/build/modules.mjs`); **B3 (this doc)** makes the runtime deployable on edge/serverless
platforms via a Hono-first build target, with per-target capability gating and durable Postgres
storage.

## Decisions (user-approved)

- **Hono-first as universal adapter.** One `hono` build target covers Cloudflare Workers, Vercel,
  Node, Bun, and Deno hosts. Platform-specific targets (a dedicated `workers`/`vercel` emit) can
  follow later on the same mechanism; they are not in this sub-project beyond what the workerd
  proof requires.
- **Storage: Postgres + explicit config, else fail loudly.** Edge deploys must configure store
  implementations; a missing store on the edge target is a clear build/boot error, never a silent
  in-memory or sqlite fallback.
- **`@dawn-ai/postgres-storage` is in scope** — a NEW package (nothing existing covers it: sqlite
  packages are node:sqlite; `@dawn-ai/memory-pgvector` covers memory only). Checkpointer +
  ThreadsStore + PermissionsStore over pure-JS `pg`.
- **Gated workerd CI lane** — the artifact must boot under real workerd and serve a real turn;
  bundle-checks alone are not proof.
- **Approach 1: emit analyzable source, do not bundle.** wrangler/Vercel/Vite run their own
  esbuild and resolve TypeScript natively; Dawn emits entry files + the edge module manifest and
  stays out of the bundler business. The node-free entry is a new `@dawn-ai/cli` **`"./fetch"`
  export**, not a new adapter package.

## Grounding (edge-readiness survey, 2026-08-05)

Surveyed on `main` at `48dbddfb` (post-B2). The fetch core (`runtime-fetch-handler.ts`) has zero
`node:` imports; every blocker is in what it constructs or what `prepareRouteExecution` touches:

1. **Injection gap.** `BootResolvedInstances` (execute-route.ts) already accepts checkpointer /
   threadsStore / permissionsStore / memoryStore / routeManifest, but `StartRuntimeServerOptions`
   exposes none of them, and `buildSubagentResolver` re-enters execution passing only
   routeManifest + sandbox — subagent turns reconstruct sqlite stores from `appRoot` even when the
   parent injected everything.
2. **Config.** `loadDawnConfig` always does `fs.access` + tsx register + dynamic import of
   `<appRoot>/dawn.config.ts`; there is no way to hand a `DawnConfig` object in. All callers
   fail soft to defaults — which are the sqlite stores.
3. **B2 hole.** `buildDescriptorRouteMap` dynamic-imports every route entry file from disk on the
   first agent request even when `modules` is supplied (`pathToFileURL(route.entryFile)`), though
   each `StaticRouteModule.module.entry` already *is* the descriptor.
4. **Capabilities hit `node:fs` directly.** `agents-md` (detect: always true), `memory-md`,
   `planning`, `skills` stat/read the filesystem per request and per model turn; `workspace`
   binds `localFilesystem()`/`localExec()`; `subagents.loadDescription` dynamic-imports entry
   files per request. The injectable `CapabilityMarkerContext.backends` seam exists but the
   markers bypass it. `createWorkspaceFs(... ?? localFilesystem())` runs unconditionally for
   every route kind; `buildOffload` does an `existsSync` per request.
5. **Middleware** is loaded by a four-way dynamic-import probe over `${appRoot}/src/middleware.*`
   and is not part of `DawnStaticModules`.
6. **Packaging.** The `.` export is the CLI bin (commander + run side effect); `./runtime` drags
   `node:http`, sqlite value-imports, and the TS compiler. `modules.mjs` as emitted imports
   `node:path`/`node:url` and `.ts` sources loaded via the tsx loader. `commander` and `tsx` are
   runtime dependencies. No wrangler/workerd/miniflare/hono anywhere in the repo's own deps.
7. **Edge-clean already:** `@dawn-ai/ag-ui` (zero node imports), `@dawn-ai/langchain` (only
   polyfillable `createHash`/`join` in offload; provider packages are fetch-based; API keys read
   via `@langchain/core`'s guarded env access), LangGraph's `async_hooks` (supported under
   Workers `nodejs_compat` and Vercel), the sandbox manager (lazy, provider-injected,
   `@dawn-ai/sandbox` is a devDependency). `createChatModel`'s variable-specifier dynamic import
   already has an injectable `importer` option — the seam for a generated static provider map.
8. **pg on Workers:** raw `pg` is TCP; on Cloudflare Workers it requires Hyperdrive (or an HTTP
   driver); it works directly on Vercel functions and Node/Bun Hono hosts. Documented caveat, not
   a design change; the workerd lane exercises the Workers story.

## Non-goals

- **No platform-specific store adapters** (D1/KV/Durable Objects) — Postgres is the durable
  story; platform adapters are a future sub-project.
- **No Dawn-owned bundling.** No esbuild invocation in `dawn build` for this target; emitted
  source must be analyzable by platform bundlers (proven by the workerd lane).
- **No dedicated `workers`/`vercel` emit targets** beyond the `hono` target + wrangler scaffold
  needed for the workerd proof.
- **No sandbox/workspace/skills/subagent-exec support on edge.** Honest subset: model calls,
  HTTP-only tools, AP + AG-UI streaming, durable threads/checkpoints/permissions (pg), memory
  (pgvector). Everything else fails loudly at build time (and defensively at runtime).
- **No dev-server-on-edge.** `dawn dev` stays Node/dynamic; only built output targets edge.
- **No edits to the dynamic path's behavior.** All PR1 seams are additive; absent injection,
  byte-for-byte current behavior (guarded by the existing cli suite untouched).

## Architecture

Three PRs, one spec. Each independently green and shippable.

### PR1 — runtime edge-readiness (seams + `./fetch` entry)

1. **Injection surface.** `CreateRuntimeFetchHandlerOptions` / `StartRuntimeServerOptions` /
   `ServeRuntimeOptions` gain optional `checkpointer`, `threadsStore`, `permissionsStore`,
   `memoryStore` (thunk), `config` (a `DawnConfig` object), `middleware`. Threaded into the route
   table exactly as `BootResolvedInstances` expects — **and through `buildSubagentResolver`**, so
   subagent turns reuse the parent's instances (fixes a latent Node inefficiency too).
2. **Config seam.** A supplied `config` primes the existing per-appRoot memo
   (`seedDawnConfig(appRoot, config)`), symmetric with `seedPreparedRouteModules`. On edge,
   `appRoot` is an opaque namespace string (it also feeds `basename(appRoot)` into the memory
   `workspace` scope — the emitted entry passes a stable literal).
3. **Descriptor-map closure.** When static modules are present, the descriptor route map is built
   from `StaticRouteModule.module.entry` values — no disk imports. Dynamic path unchanged.
4. **Capabilities through backends.** `agents-md`, `memory-md`, `planning`, `skills`, and
   `workspace` markers route `detect`/`load`/`render` file access through
   `CapabilityMarkerContext.backends.filesystem`; the default backend on Node remains
   `localFilesystem()` so behavior is identical. With no filesystem backend (edge), markers
   detect-false / render-empty cleanly. `subagents.loadDescription` reads descriptions from the
   static manifest's descriptors when present instead of dynamic-importing. `createWorkspaceFs`'s
   `localFilesystem()` default and `buildOffload`'s `existsSync` become lazy (constructed only
   when a consuming capability/tool is active).
5. **Middleware in the manifest.** `DawnStaticModules.middleware?` + `modules.mjs` emits a static
   import of `src/middleware.ts` when present; runtime prefers manifest middleware, falls back to
   the existing dynamic probe.
6. **`@dawn-ai/cli` `"./fetch"` export.** Module graph: fetch handler → edge-split execute path →
   pure normalization cores → static-modules types. Never imports sqlite, `node:fs`, tsx,
   commander, or `node:http`. Remaining `node:crypto`/`node:path` uses on this graph move to Web
   Crypto (`crypto.randomUUID`) and a small pure path-join helper (or `node:path` retained where
   Workers `nodejs_compat` covers it — decided at plan time by what the workerd lane accepts;
   default to zero `node:` imports). `sqliteMemoryStore`'s value import in `resolve-memory.ts`
   becomes lazy so the graph stays clean.

### PR2 — `@dawn-ai/postgres-storage`

- New package, pure-JS `pg` (same dependency posture as `@dawn-ai/memory-pgvector`; no native
  deps). Exports `postgresCheckpointer`, `createPostgresThreadsStore`,
  `createPostgresPermissionsStore` (final names at plan time, mirroring sqlite-storage naming).
- **Checkpointer:** first evaluate wrapping `@langchain/langgraph-checkpoint-postgres`; adopt it
  if its dependency graph is edge-clean and its schema/setup story fits (`setup()` migration on
  first use). Otherwise implement `BaseCheckpointSaver` directly over `pg`. This is a plan-time
  spike task with both outcomes specified.
- **ThreadsStore** (6 methods) and **PermissionsStore** (`load`/`match`/`addAllow`, honoring
  `mode`) implement the existing interfaces with pg schemas + versioned migrations, behavior-
  matched to sqlite via a **storage conformance kit** in `@dawn-ai/testing` (the
  `runMemoryStoreConformance` pattern): kit runs against sqlite always, against pg gated
  (`DAWN_TEST_PGSTORAGE=1`, Testcontainers `postgres:16`).
- Wiring: `dawn.config.ts` already supports `threadsStore`/`checkpointer` instances; permissions
  gains the equivalent config seam if absent (plan-time check). The docs show one config block
  using `DATABASE_URL`.
- Workers caveat documented: raw TCP `pg` needs Hyperdrive on Cloudflare; direct on
  Vercel/Node/Bun.
- Release: new-package OIDC bootstrap BEFORE the Version PR merges (0.8.6/0.8.14 playbook).

### PR3 — the `hono` build target + gating + workerd proof

- **`targets/hono.ts`** in the `BuildTarget` registry. Emits into `.dawn/build/`:
  - **`modules.edge.mjs`** — same generator core as `modules.mjs` (shared emitter, one
    parameterization; all B2 hardening — JSON.stringify'd specifiers, JSON.parse literals,
    state-default round-trip guard — applies), differing only in: no `node:path`/`node:url`
    imports, `appRoot` emitted as a build-time literal namespace id, paths kept as manifest
    literals. Static `.ts` imports retained (wrangler/Vite/esbuild resolve TS).
  - **`app.mjs`** — the Hono entry: `import { Hono } from "hono"`;
    `import { createRuntimeFetchHandler } from "@dawn-ai/cli/fetch"`; imports
    `modules.edge.mjs`, an inlined `DawnConfig` object (from build-time config load, minus
    non-serializable fields — store instances come from a generated `stores.mjs` import of the
    user's configured factories), a generated **static provider-importer map** (from the
    providers the app's routes actually use, wired via `createChatModel`'s `importer` option),
    and manifest middleware. Mounts `app.all("*", (c) => handler.fetch(c.req.raw))` and default-
    exports the Hono app (the shape Workers/Vercel/Bun all accept). Users wanting to compose can
    import the same pieces into their own Hono app.
  - **`wrangler.toml`** scaffold (nodejs_compat flag, entry point) — written only if absent
    (the Dockerfile precedent).
  - `hono` is NOT in the default target set; users opt in via `build.targets: ["hono"]`.
- **Capability gating (honest subset).** At emit time the target validates the app + config and
  **fails the build** naming feature and config key when it finds: sandbox configured, workspace
  dir tooling required (workspace/exec/offload), skills dirs present, or any other node-only
  feature per the survey. `dawn check` mirrors the validation when the `hono` target is
  configured. Runtime guards throw the same named errors if reached (defense in depth). Missing
  edge store config (no checkpointer/threads/permissions for the target) is a build error per
  the fail-loudly decision.
- **Proof stack:**
  - emitter goldens + hostile-input tests (shared with B2's suite shape);
  - Hono-on-Node round-trip: build the fixture app with the `hono` target, boot `app.mjs` under
    Node's Hono adapter + Testcontainers pg, run AP turn + AG-UI stream (ungated, every CI run);
  - **gated workerd lane** (`edge-workerd` job, `DAWN_TEST_WORKERD=1`): the fixture booted under
    `wrangler dev` (real workerd) with aimock, driving a real turn and asserting SSE shape.

    **DECIDED 2026-08-07 — the lane proves DURABLE storage too, not just the runtime.** The
    original text said "Postgres reachable from the worker", which does not survive contact with
    workerd: raw `pg` opens TCP, which workerd does not provide, so on Workers it needs Hyperdrive
    (a real Cloudflare account — not CI-friendly) or an HTTP/WebSocket driver. User chose the
    strongest option: **add an HTTP-driver path so `@dawn-ai/postgres-storage` works on workerd**,
    and have the lane assert thread state actually persisted in Postgres from inside the worker.

    **SPIKE RESULT 2026-08-07 — WORKS, with two mandatory changes.** The spike ran the real built
    `packages/postgres-storage/dist` (not a reimplementation) against `postgres:16-alpine` +
    `ghcr.io/neondatabase/wsproxy` under **real workerd** (wrangler 4.120.0 / workerd
    1.20260801.1): 8/8 in-worker assertions, with durability confirmed **out-of-band via `psql`**
    — the worker's own migrations created all 7 tables and its thread/checkpoint/write rows were
    really there. Node-side driver-parity run: 10 assertions incl. a `pg` control for the one
    mismatch, which turned out to be the spike's own wrong expectation, not driver divergence.

    - **No driver abstraction needed.** Typing `pool` structurally is honest against both drivers:
      `tsc --strict` accepts `pg.Pool`, `pg.PoolClient`, `NeonPool` and `NeonPoolClient` against
      `SqlPool { query, connect, end }` / `SqlClient { query, release }`. Better, the structural
      type **is itself the guard**: `neon()`'s transaction-incapable HTTP function is rejected at
      compile time (`TS2739: missing … connect, end`). Keep that property.
    - **But the type change is not sufficient.** `checkpointer.ts`, `threads.ts` and
      `permissions.ts` each **value**-import `Pool` from `pg` for the `options.pool ?? new Pool(…)`
      default, which drags TCP `pg` into the graph: bundling today's `dist` on `platform: browser`
      fails to link with 17 errors (`net`, `tls`, `dns`, `stream`, `util`). PR2a's clean-link
      result does **not** carry over to this package. Make `pg` type-only and relocate the
      `connectionString` convenience to a Node-only entry; on the edge `options.pool` is required.
      With that change the same graph links clean on `platform: browser` with zero `node:` imports,
      at 1.18 MB minified / 294 KiB gzipped — comfortable against the 3 MB compressed Workers limit.
    - **Transactions are fully supported on the WebSocket path**, tested inside workerd rather than
      inferred: `BEGIN`/`COMMIT`/`ROLLBACK` are real session transactions
      (`pg_current_xact_id_if_assigned()` non-null after a write; temp table gone after rollback),
      and `pg_advisory_xact_lock` genuinely blocks a second session. **8 concurrent cold-start
      migrations inside workerd → 0 failures**, reproducing PR2b's negative control. No weakening
      of `internal/tx.ts` or `runMigrations` is needed or warranted.
    - **⚠️ NO MODULE-SCOPE POOL — this changes `app.mjs`/`stores.mjs`.** A pool created at module
      scope and reused across requests — *the shape a naive generated entry would emit* — fails on
      workerd, and fails silently: it **hangs ~30s until the runtime cancels the request**, in a
      perfectly alternating pattern (call 1 OK, call 2 hang, call 3 OK…). The pool returns a client
      to idle at end of request 1; request 2 picks up that idle WebSocket, which belongs to a dead
      I/O context, and waits forever; the hang kills the client, so request 3 opens a fresh one.
      **50% of requests hang.** The `hono` target must therefore construct the pool and stores
      **per request** (`ctx.waitUntil(pool.end())`), or hand the handler a per-request store
      *factory* rather than instances — so the spec's "`stores.mjs` imports the user's configured
      factories [at module scope]" and `DawnConfig` carrying store *instances* must become a
      per-request seam on this target. Interaction to handle: the stores memoize `initP`, so a
      per-request instance re-runs `runMigrations` every request (one advisory-lock transaction per
      request). Add a module-scope "migrations already done" boolean — safe, because it guards only
      a no-op re-check, never the lock itself.
    - **CI lane: three containers, no Cloudflare account.** `postgres:16-alpine` +
      `ghcr.io/neondatabase/wsproxy` (`ALLOW_ADDR_REGEX=.*`, **omit `APPEND_PORT`** — it
      concatenates onto the client-supplied address, yielding `host:5432host:5432` →
      "too many colons in address") + `wrangler dev --local` (no auth; set
      `WRANGLER_SEND_METRICS=false`). Driver config: `useSecureWebSocket=false`,
      `pipelineTLS=false`, `pipelineConnect=false`,
      `wsProxy=(host,port)=>` `localhost:5480/v1?address=${host}:${port}` (path is `/v1`; `/v2`
      404s on this image). workerd supplies `WebSocket` globally; only Node needs
      `webSocketConstructor = ws`. Wrangler ready in ~18s; budget ~60s startup and keep PR2b's
      raised container timeouts. Caveat: `wrangler` pulls `workerd`+`esbuild` via postinstall, so a
      blocked-scripts policy breaks the lane at startup.
    - **`nodejs_compat` is NOT required** — correcting the `wrangler.toml` scaffold above. A bare
      `name` / `main` / `compatibility_date` boots the fetch handler.

    Residual doubts to document rather than paper over: **local workerd is not the edge** —
    miniflare does not enforce Cloudflare's ~6-simultaneous-outbound-connection or
    1000-subrequest limits (20 simultaneous WS connections opened locally with no ceiling), and in
    production each pooled connection is a subrequest; only a real-Cloudflare smoke test settles
    it, and the CI lane will not. A local wsproxy also hides per-query round-trip latency, which
    matters because `putWrites` issues one `INSERT` per write in a loop inside the transaction.
    Hyperdrive remains untested (needs an account). Pin the structural-type assertion test so a
    driver bump (`pg` 8.22.0 / neon 1.1.0 as tested) cannot silently break it.
  - static-vs-static-edge equivalence on Node: the B2 equivalence harness compares the node
    `modules.mjs` path against the edge `modules.edge.mjs` + injected-store path for the same
    conversation (volatile ids normalized) — proving the edge wiring doesn't drift.
- Docs: deployment.mdx gains the Hono/edge path (supported subset table, store config, Workers
  Hyperdrive caveat, wrangler quickstart); cli.mdx documents the target and its gating errors;
  Ecosystem.tsx's deploy-targets claim becomes true.

## Error handling

Fail loud, at the earliest possible stage, naming the exact feature/config key:

- build time: unsupported capability, missing store config, unknown provider in the importer map;
- boot time (edge): store construction failure surfaces the pg error verbatim;
- request time: runtime guards for gated features throw named errors (never silent no-ops);
- inherited from B2: stale/malformed manifest errors advise `dawn build`.

## Testing invariants

- PR1 ships with the zero-existing-test-edit invariant (sanctioned exceptions enumerated in the
  plan, if any); new seam tests prove injected instances are used end to end, including by
  subagent turns (spy: zero sqlite opens with full injection).
- PR2's conformance kit is the behavior contract; sqlite is the reference implementation.
- PR3's workerd lane is the merge gate for the edge claim; Hono-on-Node covers every CI run.

## Sequencing

**Revised 2026-08-06, after PR1 shipped.** PR1 → **PR2a (upstream purge)** → PR2b (Postgres) →
PR3 (Hono target), same branch family (`feat/edge-*`), each its own review + merge-on-green.

PR1 ([#389](https://github.com/cacheplane/dawnai/pull/389), merged `d845720a`) delivered the
injection seams and the node-free `@dawn-ai/cli/fetch` entry, and its purity gate proved that
**Dawn's own CLI code contributes zero `node:` edges**. But the bundle still *links* 33 `node:`
specifiers owned by `@dawn-ai/core` (23), `@dawn-ai/permissions` (4), `@dawn-ai/workspace` (4),
and `@dawn-ai/langchain` (2) — among them 11 `node:fs` and one `node:child_process`.

That is a **link-time** dependency: an ESM `import "node:fs"` resolves when the module graph is
instantiated, before any Dawn code runs, so the (correct) argument that those resolvers are never
called on the injected path never gets to apply. The bundle is therefore Cloudflare-Workers-with-
`nodejs_compat` ready, not runnable on a shim-less runtime — and PR1's functional proof runs on
Node, so it structurally cannot detect this class of failure.

**PR2a is therefore inserted before the Postgres work**: give those four packages the same
pure/node split PR1 gave the CLI, driving `KNOWN_UPSTREAM_NODE_EDGES` to zero. This unblocks
PR3's workerd lane and surfaces the two known-risky spots (the workspace path-jail's
`sep`/`relative`/`resolve` containment semantics, and `@dawn-ai/langchain`'s `createHash`-derived
persisted ids) while they are cheap to get wrong, rather than mid-PR3. The established patterns
to follow all shipped in PR1: `@dawn-ai/core`'s `./node` subpath, `@dawn-ai/memory`'s
`./namespace`, the `MarkerFs` injection facade, and the `pure-path`/`pure-hash` ports.
