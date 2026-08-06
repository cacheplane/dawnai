# Build-time static wiring — design

**Date:** 2026-07-26
**Status:** approved (brainstorm)
**Epic:** Deploy-anywhere. This is **sub-project B2** of three: B1 (shipped, #373) gave the runtime a `(Request) => Promise<Response>` core; **B2 (this doc)** inverts module loading from runtime discovery to build-time static wiring; B3 emits the Cloudflare Workers / Vercel / Hono targets on top.

## Problem

The runtime rediscovers and reloads the app on every request. Measured against current `main` (all cited in the B2 grounding
survey), one agent turn on a default-config app pays:

- a full `readdir` route-tree walk (`execute-route.ts:575` calls `discoverRoutes` per request; the manifest's fresh object
  identity defeats the `WeakMap` route-map cache at `:1093`, so it always misses);
- **re-transpilation and re-evaluation of every tool file** (`tool-discovery.ts:144` imports with a `?t=${Date.now()}`
  cache-buster) and of `state.ts` + reducers (`state-discovery.ts:20,93`);
- a synchronous `readFileSync` of `.dawn/routes/<slug>/tools.json` on the event loop (`execute-route.ts:443-455`);
- a fresh read of `.dawn/permissions.json` (`execute-route.ts:544-555`);
- **three fresh SQLite opens** — checkpointer and threads store fall back to `openDb` per request when `dawn.config.ts`
  supplies none (`execute-route.ts:527-533` — the boot-resolved instances in `runtime-fetch-handler.ts:67-68` are never passed
  down), plus a second memory store with migrations (`execute-route.ts:593`);
- `loadDawnConfig` re-runs per request (`execute-route.ts:492`, `:593-594`) with no memoization layer.

Separately, boot is fs-heavy: `createRuntimeFetchHandler` walks and tsx-imports every route at startup and opens the memory
store SQLite **unconditionally** (`runtime-fetch-handler.ts:75`), even for apps with no memory routes.

All of this is also the hard blocker for edge targets: Workers/Vercel Edge have no `readdir`, no tsx loader hooks, and no
`pathToFileURL` dynamic imports. B3 cannot exist until the runtime can be handed its modules instead of discovering them.

### Why per-request reloading exists at all

The dev loop. `classify-change.ts` routes tool-file, `state.ts`, and `reducers/*.ts` edits to `typegen` (debounced, **no child
restart**), so the runtime must re-import them fresh per request to pick up edits. Every other edit class (route files, config,
middleware, plan.md, skills) already triggers a **full child restart** — a fresh process re-reads everything anyway. Within a
single process lifetime, nothing else ever needs re-discovery. In production (`serveRuntime`) there is no watcher, so 100% of
the per-request work is waste.

## Goal

Two deliverables, shipped as **two PRs** against one spec:

1. **PR 1 — per-request parity plumbing.** Load everything once per process, in dev and prod alike, with no codegen. Requires
   flipping tool/state/reducer edits from `typegen` to `restart` in the dev loop (approved trade: ~1-2s restart latency on
   those edits, in exchange for zero per-request re-compilation and one shared loading path).
2. **PR 2 — the static-modules mechanism, adopted by the node target.** A generated `.dawn/build/modules.mjs` that statically
   imports every route/tool/state/memory module; an additive `modules?` seam on the runtime; `server.mjs` boots from it. The
   dynamic path remains byte-for-byte intact when `modules` is absent.

## Non-goals

- **No edge target.** B3 consumes `modules.mjs`; this sub-project only produces it and proves it on Node.
- **No capability-probe caching.** The per-turn `AGENTS.md`/`memory.md` re-reads are deliberate product behavior (the agent's
  own writes must be visible next turn). Capability markers stay as they are.
- **No dev-on-static-modules.** `dawn dev` keeps dynamic discovery (restart-per-edit); only built output uses the manifest.
- **No staleness detection at serve time.** `dawn build` regenerates the artifact every run and production images are
  immutable; `dawn check` validates the manifest instead.
- **Do not reuse the langsmith emitter for the generator.** It is a partial materialization — it drops checkpointer,
  stateFields, promptFragments, summarization, offload, and subagent resolution (`langsmith.ts:65-77` vs
  `agent-adapter.ts:173-186`). The B2 generator feeds `prepareRouteExecution`'s full input set instead.

## Architecture

### PR 1 — parity plumbing

1. **Config memoization.** `loadDawnConfig` gains a per-appRoot, process-lifetime memo (`Map<appRoot, Promise<LoadedDawnConfig>>`
   in `packages/core/src/config.ts`). Invalidation is process restart, which the dev loop already performs on config edits.
2. **Boot-resolved instances flow down.** `createRuntimeFetchHandler` already builds the checkpointer, threads store, and (after
   this PR, lazily) the memory store; `prepareRouteExecution` gains optional fields for them in its existing options bag and
   skips its per-request fallbacks when present. The permissions store loads once at boot and is passed the same way; the
   store's `load()` re-read moves out of the request path — **except in dev**. The dev loop does not watch `.dawn/`, and
   permission "Always" grants are written to `permissions.json` mid-process by the HITL resume path; a boot-time snapshot
   would go stale. Decision: the boot object owns the store and re-`load()`s it per request in dev mode only. This is the one
   deliberate per-request read kept (one small JSON file); production loads it once.
3. **Boot-cached module loading.** Remove the `?t=` cache-busters in `tool-discovery.ts` and `state-discovery.ts`; hoist
   `discoverRoutes`/`discoverToolDefinitions`/`discoverStateDefinition`/route-`memory.ts` loading so each runs **once per
   route, lazily on that route's first request**, cached on the registry entry for the process lifetime (lazy keeps boot fast
   and dev restarts cheap; the first turn on a route pays the load exactly once). The per-request `discoverRoutes` call in
   `prepareRouteExecution` is replaced by the boot manifest (fixing the always-miss WeakMap).
4. **Dev-loop flip.** `classify-change.ts`: `**/tools/*.ts`, `**/state.ts`, `**/reducers/*.ts` become `restart` (typegen still
   runs pre-spawn via `buildRuntimeServerOptions`). The debounced-restart path prints a one-line reason, reusing the existing
   restart machinery.
5. **Lazy memory store.** `resolveMemoryStore` moves behind a `getMemoryStore()` thunk created at boot, first-call-opens,
   shared by the three `/memory/candidates*` handlers **and** passed down to the capability path (which today opens its own
   second store per request).

### PR 2 — static modules

1. **The seam.** `StartRuntimeServerOptions` gains `readonly modules?: DawnStaticModules`. `DawnStaticModules` is
   `{ routes: readonly StaticRouteModule[] }`, where `StaticRouteModule` carries what `prepareRouteExecution` needs, using the
   types that already exist: `{ assistantId, routeId, routePath, routeFile, kind, module: NormalizedRouteModule,
   tools: readonly DiscoveredToolDefinition[], toolSchemas?: Record<string, { description: string; parameters: unknown }>,
   stateFields?, memory? }` — `toolSchemas` being exactly the `tools.json` shape typegen already writes.
   `createRuntimeRegistry(appRoot, modules?)` short-circuits discovery when given entries; `prepareRouteExecution` accepts an
   optional `StaticRouteModule` and skips `normalizeRouteModule`, `discoverToolDefinitions`, the `tools.json` read,
   `discoverStateDefinition`, the per-request `discoverRoutes`, and the `memory.ts` probe. Absent `modules`, every path is
   unchanged.
2. **The generator.** A new build step (part of the `node` target) emits `.dawn/build/modules.mjs`: static `import`s of each
   route `index.js`, each tool module, `state.ts`, reducers, and route `memory.ts`; inlined `tools.json` and `state.json`
   content (typegen already computes them); route keys via the same `assistantId` rule the registry uses. The emitted file
   `export default`s a `DawnStaticModules`. Imports are relative (resolvable from `.dawn/build/` in the packed app),
   mirroring how the langsmith entries already import — but the payload is `prepareRouteExecution`'s input set, **not** a
   pre-materialized graph.
3. **Adoption.** The node target's `server.mjs` becomes:
   `import modules from "./modules.mjs"; await serveRuntime({ appRoot, modules })`. Boot then performs no route-tree walk and
   no tsx transpilation. (`dawn.config.ts` itself still loads dynamically at boot — config holds functions and stays a
   runtime concern on Node; making config static is B3's problem for edge, where it becomes a build-time import in the bundle.)
4. **Validation.** `dawn check` gains a pass that, when `.dawn/build/modules.mjs` exists, imports it and verifies each entry's
   `assistantId` matches a discovered route (catching a stale artifact after route renames).

## The safety invariant

Same discipline as B1: **every existing test passes unchanged** in both PRs. The dynamic path must be byte-for-byte
equivalent after PR 1's hoisting (same responses, same tool behavior — only *when* modules load changes). PR 2's static path
must be **response-equivalent to the dynamic path**: the core proof is one fixture app served both ways with identical AP and
AG-UI responses (modulo timing). The `verify:harness:runtime`/`smoke` socket lanes are required gates for both PRs.

## Testing

- **PR 1:** config-memo identity test; no-per-request-`openDb` proof (count `DatabaseSync` constructions via an injected
  spy or by instrumenting `openDb` in-test); tool-edit-restarts-dev-child test (classify-change unit + a dev-session
  integration probe); permissions "Always" grant still applies mid-process in dev; full-suite + harness lanes unedited.
- **PR 2:** generator golden test (fixture app → `modules.mjs` snapshot with stable formatting); registry short-circuit unit
  test; **dynamic-vs-static equivalence e2e** (same fixture, both paths, compare AP + AG-UI response bodies); a packed-app
  boot test through the real `server.mjs` (extend the existing generated-app harness fixtures, which already deep-compare
  `dawn verify` output — expect fixture regeneration for the new artifact); `dawn check` stale-manifest detection test.
- **Perf snapshot (informational, not a gate):** log turn latency on the fixture app before/after PR 1 in the PR description.

## Risks

- **Subtle dev regressions from cache removal** — a stale-module bug would surface as "my tool edit didn't apply." Mitigated by
  the classify-change flip (restart = fresh process, definitionally fresh modules) and an explicit dev-session test.
- **The generated artifact drifting from `prepareRouteExecution`'s needs** as capabilities evolve. Mitigated by the
  equivalence e2e (it fails if the static path drops an input) and by generating from the same discovery functions the runtime
  uses, not a parallel implementation.
- **Harness coupling:** `@dawn-ai/testing`'s `harness.ts` does its own discovery and drives `streamResolvedRoute` directly —
  it keeps working unchanged on the dynamic path. Exercising the static path in the harness is a follow-up, not a
  prerequisite.

## Sequencing

PR 1 → PR 2, same branch family, each independently green and shippable. B3 (edge targets) then consumes `modules.mjs` and
adds per-target capability gating.
