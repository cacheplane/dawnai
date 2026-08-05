# Static wiring PR 1 — per-request parity plumbing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Follow TDD.

**Goal:** Load everything once per process — kill per-request re-transpilation, per-request `readdir`, per-request SQLite opens, and the eager boot-time memory store — with zero observable behavior change (except the approved dev trade: tool/state/reducer edits restart the dev child).

**Architecture:** Four independent hoists (config memo; boot-instance passthrough; lazy shared memory store; lazy-per-route cached module loading) plus the `classify-change` flip that makes the caching safe in dev.

**Spec:** `docs/superpowers/specs/2026-07-26-static-wiring-design.md` (PR 1 section)

**Conventions (MUST follow):** `src/`→`.js` imports, `test/`→`.ts`. `exactOptionalPropertyTypes: true` → conditional-spread optionals. Never bare `biome check --write`; use `pnpm --filter <pkg> lint`. Changeset **patch** (fixed-group 0.x). If deps/dist stale: `pnpm install` + `pnpm -r build` (setup only).

**The safety invariant (same discipline as B1):** every existing test passes **unchanged**, except tests that explicitly assert the old dev `typegen`-without-restart behavior for tool/state/reducer edits (those change deliberately with the classify flip — call each such edit out in the report). Responses on the wire are unchanged. `verify:harness:runtime` + `verify:harness:smoke` are required gates.

---

## Task 1: Config memoization

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config-memo.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { loadDawnConfig, __clearDawnConfigCacheForTests } from "../src/config.js"

describe("loadDawnConfig memoization", () => {
  test("returns the identical result object for repeated calls on one appRoot", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    await writeFile(join(appRoot, "dawn.config.ts"), "export default { }\n", "utf8")
    const a = await loadDawnConfig(appRoot)
    const b = await loadDawnConfig(appRoot)
    expect(b).toBe(a) // same promise result — no re-import, no re-access()
  })

  test("distinct appRoots are cached independently", async () => {
    const r1 = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    const r2 = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    await writeFile(join(r1, "dawn.config.ts"), "export default { }\n", "utf8")
    await writeFile(join(r2, "dawn.config.ts"), "export default { }\n", "utf8")
    expect(await loadDawnConfig(r1)).not.toBe(await loadDawnConfig(r2))
  })

  test("test-only cache clear forces a fresh load", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    await writeFile(join(appRoot, "dawn.config.ts"), "export default { }\n", "utf8")
    const a = await loadDawnConfig(appRoot)
    __clearDawnConfigCacheForTests()
    const b = await loadDawnConfig(appRoot)
    expect(b).not.toBe(a)
  })
})
```

READ `packages/core/src/config.ts` first: match `loadDawnConfig`'s real name/signature/return type (the grounding cites `config.ts:22-27` — `access()` + tsx loader + `import(pathToFileURL)`). If the exported name differs, adjust the test to reality.

- [ ] **Step 2: Run → fail** (`pnpm --filter @dawn-ai/core test config-memo` — no memo, objects differ / no `__clear…` export).

- [ ] **Step 3: Implement**

```ts
const configCache = new Map<string, Promise<LoadedDawnConfig>>()

export function loadDawnConfig(appRoot: string): Promise<LoadedDawnConfig> {
  const cached = configCache.get(appRoot)
  if (cached) return cached
  const loading = loadDawnConfigUncached(appRoot) // rename the existing body
  configCache.set(appRoot, loading)
  // A failed load must not be cached forever (e.g. transient syntax error would
  // otherwise poison the process) — evict on rejection.
  loading.catch(() => configCache.delete(appRoot))
  return loading
}

/** Test-only: clear the memo so fixtures can reload a mutated config. */
export function __clearDawnConfigCacheForTests(): void {
  configCache.clear()
}
```

CRITICAL: grep the monorepo for tests that write a `dawn.config.ts`, call something that loads it, then **rewrite it and load again within one process** (harness/e2e fixtures do this). Every such site now needs `__clearDawnConfigCacheForTests()` between mutations — but the invariant says don't edit existing tests. Resolution: wire the clear into the existing test-reset seams instead — grep `packages/testing/src` for the harness `reset()`/`close()` and `__resetMaterializedAgentsForTests`-style hooks and call the config-cache clear there (a src change, not a test edit). If a failing existing test still remains that mutates config mid-process outside the harness, STOP and report it rather than silently editing it.

- [ ] **Step 4: Run → pass**; then the FULL `@dawn-ai/core`, `@dawn-ai/cli`, and `@dawn-ai/testing` suites (config is loaded everywhere — this memo is the highest-collateral change in PR 1).
- [ ] **Step 5: Commit** `perf(core): memoize loadDawnConfig per appRoot (process lifetime)`.

---

## Task 2: Boot-resolved instances flow into prepareRouteExecution

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`, `packages/cli/src/lib/dev/runtime-fetch-handler.ts`
- Test: `packages/cli/test/boot-instance-passthrough.test.ts` (new)

- [ ] **Step 1: READ the real code**: `execute-route.ts:527-555` (per-request checkpointer/threadsStore fallbacks + `createPermissionsStore(...).load()`), `runtime-fetch-handler.ts:65-83` (boot builds `threadsStore`, `checkpointer` and passes them into `buildRouteTable`), and how `buildRouteTable`'s handlers call into `invokeResolvedRoute`/`streamResolvedRoute` (what options bag they already forward — the grounding says they forward verbatim).

- [ ] **Step 2: Failing test** — instrument at the seam: a fixture app served via `createRuntimeFetchHandler`; monkey-patch/spy `openDb` is not importable cheaply, so instead assert **object identity**: extend `prepareRouteExecution`'s options (Step 3) and unit-test that when `checkpointer`/`threadsStore`/`permissionsStore` are supplied, the returned execution context uses those exact instances (`toBe`), and no new `.dawn/checkpoints.sqlite` handle is created for a second request (probe: count `DatabaseSync` constructions by temporarily wrapping `node:sqlite` via a vitest `vi.mock` of the sqlite-storage `openDb` module — mock counts calls, passes through). Follow the existing test-style in `packages/cli/test` for mocking.

- [ ] **Step 3: Implement**
  - `prepareRouteExecution` options gain: `readonly checkpointer?: BaseCheckpointSaver`, `readonly threadsStore?: ThreadsStore`, `readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)`. When present, skip the fallback constructions at `:527-533` and the per-request `createPermissionsStore().load()` at `:544-555`.
  - Permissions dev-freshness (spec decision): the fetch handler passes a **factory** in dev (`() => load fresh`) and a boot-loaded instance in prod. How to know "dev": `createRuntimeFetchHandler` has no dev flag today — add `readonly permissionsMode?: "per-request" | "boot"` to its internal wiring, defaulted by callsite: `dev-child.ts`/`startRuntimeServer`-from-dev → per-request; `serveRuntime` → boot. VERIFY the call chain (`dev-child` → `startRuntimeServer` → `createRuntimeRequestListener` → `createRuntimeFetchHandler`) and thread a single optional field through `StartRuntimeServerOptions` (additive).
  - `runtime-fetch-handler.ts`: pass its boot `checkpointer`/`threadsStore` (already built at `:67-68`) + the permissions store/factory through `buildRouteTable` into the route handlers' calls.
  - `invokeResolvedRoute`/`streamResolvedRoute`/`executeResolvedRoute` (`:161`, `:233`, `:252`): additive optional passthrough of the same fields.
- [ ] **Step 4: Run** the new test + full `@dawn-ai/cli` + `@dawn-ai/testing` suites (the harness drives `streamResolvedRoute` directly with NO stores — the optional fields keep that path identical).
- [ ] **Step 5: Commit** `perf(cli): pass boot-resolved stores into route execution (no per-request sqlite opens / permissions reads)`.

---

## Task 3: Lazy shared memory store

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-fetch-handler.ts`, `packages/cli/src/lib/runtime/execute-route.ts` (+ `resolve-memory.ts` if a thunk helper fits there)
- Test: `packages/cli/test/lazy-memory-store.test.ts` (new)

- [ ] **Step 1: Failing test** — boot a fetch handler on a fixture app with NO memory routes and assert `<appRoot>/.dawn/memory.sqlite` does NOT exist after boot (today it does — eager open at `runtime-fetch-handler.ts:75`); then hit a `/memory/candidates` route (or a memory-enabled fixture) and assert the file appears and the endpoint works; assert two requests reuse one store (identity or `openDb` call-count via the Task-2 mock).
- [ ] **Step 2: Implement** — replace the eager `await resolveMemoryStore(appRoot)` with:

```ts
let memoryStorePromise: Promise<MemoryStore> | undefined
const getMemoryStore = (): Promise<MemoryStore> => {
  memoryStorePromise ??= resolveMemoryStore(options.appRoot) as unknown as Promise<MemoryStore>
  return memoryStorePromise
}
```

  Thread `getMemoryStore` into the three `/memory/candidates*` handlers (grounding: `runtime-fetch-handler.ts:392,402,412`) — they `await` it on demand. Pass the same thunk down through the Task-2 options into `execute-route.ts:593` so the capability path awaits the SHARED store instead of opening its own (`resolveMemoryStore` per request). Keep the `MemoryStore` cast comment.
- [ ] **Step 3: Run** new test + full cli suite + `@dawn-ai/testing` (memory e2e tests exist — they must pass unchanged).
- [ ] **Step 4: Commit** `perf(cli): lazy, shared memory store (no eager boot sqlite; no per-request duplicate)`.

---

## Task 4: Boot-cached module loading (routes, tools, state, memory.ts)

**Files:**
- Modify: `packages/cli/src/lib/runtime/tool-discovery.ts`, `packages/cli/src/lib/runtime/state-discovery.ts`, `packages/cli/src/lib/runtime/execute-route.ts`, `packages/cli/src/lib/dev/runtime-registry.ts`
- Test: `packages/cli/test/route-load-cache.test.ts` (new)

- [ ] **Step 1: READ first**: `tool-discovery.ts:144` and `state-discovery.ts:20,93` (`?t=${Date.now()}` busters), `execute-route.ts:413-460` (per-request `normalizeRouteModule`, `discoverToolDefinitions`, `tools.json` readFileSync, `discoverStateDefinition`), `:575-585` (per-request `discoverRoutes` + the false "one manifest per CLI invocation" comment), `:591-593` (memory.ts probe), and `runtime-registry.ts` (`RuntimeRegistryEntry` shape — the natural cache home).
- [ ] **Step 2: Failing test** — count loads: a fixture app with one tool; two sequential requests through `createRuntimeFetchHandler`; assert the tool module is evaluated ONCE (probe: the tool file writes a side-effect marker — e.g. appends to a temp file or increments a global via `globalThis` — at module scope; two requests → marker count 1. Today: 2 because of the `?t=` buster).
- [ ] **Step 3: Implement**
  - Remove the `?t=${Date.now()}` from `tool-discovery.ts:144` and `state-discovery.ts:20,93` (plain `importModule(pathToFileURL(file))` — ESM cache now dedupes).
  - Add a per-entry lazy cache: extend `RuntimeRegistryEntry` (or a parallel `Map<assistantId, PreparedRouteModules>` owned by the fetch handler) holding `{ module, tools, toolSchemas, stateFields, memory }` — populated on the route's FIRST request inside `prepareRouteExecution` (or a helper it calls), reused after. Design note from the spec: **lazy on first request, cached for process lifetime**.
  - Replace the per-request `discoverRoutes` at `execute-route.ts:575` with the boot manifest: `prepareRouteExecution` already receives what it needs to reach the registry manifest — thread the boot `RouteManifest` (or the registry) through the Task-2 options; the WeakMap at `:1093` then HITS (stable identity). Fix/remove the stale comment at `:583-585`.
  - The `tools.json` sync read (`:443-455`) and memory.ts probe (`:591-592`) move inside the same once-per-route population.
  - IMPORTANT dev nuance: the cache must be per-process (module-scope or handler-scope), NOT persisted — the dev child restart (Task 5) is the invalidation.
- [ ] **Step 4: Run** new test + FULL cli + testing suites + `pnpm verify:harness:runtime` (the harness lane drives a real dev-parity server — it will catch any staleness bug).
- [ ] **Step 5: Commit** `perf(cli): load route modules/tools/state once per process (drop ?t= busters, cache per route)`.

---

## Task 5: Dev-loop flip — tool/state/reducer edits restart the child

**Files:**
- Modify: `packages/cli/src/lib/dev/classify-change.ts`, `packages/cli/src/lib/dev/dev-session.ts` (restart-notice line)
- Test: `packages/cli/test/classify-change.test.ts` (modify ONLY the specific assertions for the three flipped rules — this is the one sanctioned existing-test edit; enumerate each changed assertion in the report) + a dev-session-level probe if one exists (grep how dev-session is tested)

- [ ] **Step 1: READ** `classify-change.ts` (grounding: `:35` tools, `:40` state.ts, `:44` reducers → `"typegen"`), its test file, and `dev-session.ts:213-245` (`scheduleTypegen` vs `requestRestart` + `startOrRestart` — typegen still runs pre-spawn via `buildRuntimeServerOptions`).
- [ ] **Step 2: Flip** the three rules to `"restart"`. In `dev-session.ts`'s restart path, include the change-kind in the existing log line (e.g. `restarting (tool change: src/tools/foo.ts)`) — reuse whatever logging io it already has; do not build new infrastructure.
- [ ] **Step 3: Update** the three classify-change assertions (typegen→restart) + add one asserting `plan.md`-style paths still classify as before (guard against over-flipping).
- [ ] **Step 4: Run** classify/dev suites + full cli suite. Manually sanity-check `dawn dev` on an example app: edit a tool file → observe one restart line and the edit applying (report the observation).
- [ ] **Step 5: Commit** `feat(cli): tool/state/reducer edits restart the dev child (one loading path for dev and prod)`.

---

## Task 6: Full verification, perf snapshot, changeset, PR

- [ ] **Step 1:** Required gates: `pnpm verify:harness:runtime && pnpm verify:harness:smoke`; then `pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-docs.mjs && pnpm pack:check`.
- [ ] **Step 2: Perf snapshot (informational):** on a fixture/example app with 2+ tools, time 10 sequential AP turns via the fetch handler before (git stash or main checkout) vs after; put the numbers in the PR body. No gate — just evidence.
- [ ] **Step 3: Changeset** — **patch**; confirm the package set via `git log --oneline origin/main..HEAD --name-only -- packages/ | grep '^packages/' | cut -d/ -f2 | sort -u` (expect `core`, `cli`; possibly `testing` if reset-seam wiring touched it).
- [ ] **Step 4:** Docs touch-up if `cli.mdx`/dev docs describe hot tool edits without restart (grep "tool" in the dev sections; correct to the new restart behavior). `node scripts/check-docs.mjs` → PASS.
- [ ] **Step 5:** Rebase on `origin/main`, push `feat/static-wiring`, open the PR (title: `perf(cli): load the app once per process — parity plumbing (deploy-anywhere B2, PR 1)`), watch `validate` + lanes + advisory review; fix findings.

**Notes for the executor:** branch `feat/static-wiring`; pin before dispatching subagents. The config memo (Task 1) is the highest-collateral change — run the widest suites early. Do NOT start PR 2 work on this branch.
