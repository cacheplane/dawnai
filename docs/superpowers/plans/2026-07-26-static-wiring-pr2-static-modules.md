# Static wiring PR 2 — static-modules mechanism + node adoption — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Follow TDD.

**Goal:** A build-generated `.dawn/build/modules.mjs` that statically imports every route/tool/state/memory module; an additive `modules?` seam through the runtime; the node target's `server.mjs` boots from it. Absent `modules`, the dynamic path is byte-for-byte unchanged.

**Architecture:** `DawnStaticModules` types (cli runtime surface) → `createRuntimeRegistry(appRoot, modules?)` short-circuit → `prepareRouteExecution` consumes a `StaticRouteModule` and skips its dynamic-load sites → a generator in the `node` build target emits the manifest → `server.mjs` imports it → `dawn check` validates it.

**Spec:** `docs/superpowers/specs/2026-07-26-static-wiring-design.md` (PR 2 section)
**Depends on:** PR 1 merged (the per-route lazy cache + threaded options this PR reuses).

**Conventions:** `src/`→`.js` imports, `test/`→`.ts`; `exactOptionalPropertyTypes` → conditional-spread; never bare `biome check --write`; changeset **patch**.

**Safety invariant:** all existing tests pass unchanged. The static path's proof is EQUIVALENCE: one fixture served dynamic vs static must produce identical AP + AG-UI responses. `verify:harness:runtime`/`smoke` + `verify:harness:framework` (the generated-app lane WILL see the new artifact — expect its fixtures to need regeneration, done the honest way: from observed output) are required gates.

**Hard rule from the spec:** do NOT reuse the langsmith emitter (`langsmith.ts:65-86`) as the generator — it drops checkpointer/stateFields/promptFragments/summarization/offload/subagents. Generate `prepareRouteExecution` inputs, not materialized graphs.

---

## Task 1: `DawnStaticModules` types + registry short-circuit (TDD)

**Files:**
- Create: `packages/cli/src/lib/runtime/static-modules.ts`
- Modify: `packages/cli/src/lib/dev/runtime-registry.ts`, `packages/cli/src/runtime-exports.ts`
- Test: `packages/cli/test/static-registry.test.ts` (new)

- [ ] **Step 1: READ** `runtime-registry.ts` in full (`RuntimeRegistryEntry` at `:5-11`, `createRuntimeRegistry(appRoot)` at `:19-…`, the `assistantId` rule via `createRouteAssistantId(route.id, route.kind)`), and `execute-route.ts`'s prepared-modules cache from PR 1 (the `PreparedRouteModules` shape it caches per route — the static module must satisfy the SAME shape so the consumption seam is "pre-populate the cache").

- [ ] **Step 2: Types** — `static-modules.ts`:

```ts
import type { NormalizedRouteModule } from "./load-route-kind.js" // VERIFY real export/name
import type { DiscoveredToolDefinition } from "./tool-discovery.js" // VERIFY
// VERIFY the state-fields + route-memory types from state-discovery.ts / load-memory.ts

export interface StaticRouteModule {
  readonly assistantId: string
  readonly routeId: string
  readonly routePath: string
  readonly routeFile: string
  readonly kind: string // VERIFY: reuse the RouteKind union type
  readonly module: NormalizedRouteModule
  readonly tools: readonly DiscoveredToolDefinition[]
  readonly toolSchemas?: Record<string, { readonly description: string; readonly parameters: unknown }>
  readonly stateFields?: readonly unknown[] // VERIFY: the real ResolvedStateField type
  readonly memory?: unknown // VERIFY: the real LoadedRouteMemory type
}
export interface DawnStaticModules {
  readonly routes: readonly StaticRouteModule[]
}
```

Replace every `unknown`/VERIFY with the actual types before finalizing — they all exist (grounding §5); the interface must typecheck against `prepareRouteExecution`'s needs, not approximate them.

- [ ] **Step 3: Failing test** — `createRuntimeRegistry(appRoot, modules)` with a hand-built `DawnStaticModules` (one fake route, `module` built via the real `normalizeRouteModule` on a fixture file — or a minimal in-memory normalized shape) returns a registry whose `entries`/`lookup` match the static entries WITHOUT touching the filesystem (probe: point `appRoot` at a nonexistent dir — discovery would throw; static must succeed).
- [ ] **Step 4: Implement** — `createRuntimeRegistry(appRoot: string, modules?: DawnStaticModules)`: when `modules` present, build entries from them (same `RuntimeRegistryEntry` shape + `lookup`) and skip `discoverRoutes`. Export the new types + (if not already) the registry from `runtime-exports.ts`.
- [ ] **Step 5: Run → pass**; full cli suite unchanged; typecheck/lint. **Commit** `feat(cli): DawnStaticModules types + registry accepts prebuilt entries`.

---

## Task 2: `prepareRouteExecution` consumes static modules

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`, `packages/cli/src/lib/dev/runtime-fetch-handler.ts`, `packages/cli/src/lib/dev/runtime-server.ts` (options type), `packages/cli/src/lib/dev/serve-runtime.ts` (passthrough)
- Test: `packages/cli/test/static-route-execution.test.ts` (new)

- [ ] **Step 1:** Seam design (from PR 1's cache): the cleanest consumption is **pre-populating PR 1's per-route prepared-modules cache from the static manifest at boot** — then `prepareRouteExecution` needs no second code path at all: cache hit = static, cache miss = dynamic load. READ PR 1's implementation of the cache and confirm this works; if the cache lives on the fetch handler, populate it in `createRuntimeFetchHandler` when `options.modules` is present. This is strongly preferred over threading a `StaticRouteModule` through every call.
- [ ] **Step 2: Failing test** — fetch handler booted with `modules` on a **nonexistent-tools** appRoot (route dirs present, but delete the tool files after generating the manifest — or point at a pruned copy): a request must SUCCEED using the static tools (proving no dynamic fallback fired). Plus: booted WITHOUT `modules` on the same intact fixture behaves exactly as today.
- [ ] **Step 3: Implement** — `StartRuntimeServerOptions.modules?: DawnStaticModules`; `createRuntimeFetchHandler` passes it to `createRuntimeRegistry` and seeds the prepared-modules cache; `serveRuntime` gains the same optional field and passes through. No changes inside `prepareRouteExecution` beyond what PR 1 already did (cache consultation) — if that's not true, report why.
- [ ] **Step 4: Run** new tests + full cli + testing suites; typecheck/lint. **Commit** `feat(cli): runtime boots from a static module manifest when provided`.

---

## Task 3: The generator — emit `.dawn/build/modules.mjs`

**Files:**
- Create: `packages/cli/src/lib/build/targets/modules-emitter.ts` (pure: manifest+discovery results → file text)
- Modify: `packages/cli/src/lib/build/targets/node.ts` (call the emitter; wire into `emit`)
- Test: `packages/cli/test/modules-emitter.test.ts` (new; golden/snapshot)

- [ ] **Step 1: READ** `langsmith.ts:13-122` for the discovery-at-build pattern (it already runs `discoverToolDefinitions` + reads/injects `tools.json` — REUSE those calls, NOT its emitted shape), `run-typegen.ts:241-277` (`tools.json`/`state.json` writers — the shapes to inline), and the relative-import convention its generated entries use (`../../src/...` from `.dawn/build/`).
- [ ] **Step 2: Failing golden test** — fixture app (1 agent route, 2 tools incl. one route-local, `state.ts`, `memory.ts`) → `emitModulesFile(manifest, …)` returns text that (a) contains static imports for every module with correct relative paths, (b) `export default` s a `DawnStaticModules` literal keyed by the registry's `assistantId` rule, (c) inlines the tool schemas + state fields, (d) snapshot-matches (stable ordering: sort routes by assistantId, tools by name).
- [ ] **Step 3: Implement** the emitter:

```ts
// Shape of the emitted file (illustrative):
import route0 from "../../src/app/chat/index.js"
import route0_tool0 from "../../src/tools/search.js"
import route0_memory from "../../src/app/chat/memory.js" // only when present
// ...
export default {
  routes: [
    {
      assistantId: "/chat#agent",
      routeId: "/chat",
      routePath: "src/app/chat",
      routeFile: "src/app/chat/index.ts",
      kind: "agent",
      module: /* normalized wrapper around route0 — call the SAME normalizeRouteModule shape:
                emit `normalizeStaticRoute(route0, "agent")` importing a tiny runtime helper
                from "@dawn-ai/cli/runtime" rather than duplicating normalization logic in codegen */
      tools: [
        { name: "search", description: "…", schema: {/* inlined */}, run: typeof route0_tool0 === "function" ? route0_tool0 : route0_tool0.run },
      ],
      toolSchemas: {/* inlined tools.json */},
      stateFields: [/* inlined state.json equivalents */],
      memory: route0_memory ? /* wrap */ : undefined,
    },
  ],
}
```

  Key decisions baked in: (a) normalization happens at RUNTIME via an exported helper (`normalizeStaticRoute` — add it to the runtime exports, a thin call into the existing `normalizeRouteModule` logic minus the file import), so codegen stays dumb and can't drift from normalization rules; (b) tool `run` binding copies the `typeof x === "function" ? x : x.run` idiom langsmith already proved; (c) imports reference the COMPILED app layout — VERIFY against how the packed app actually lays out (`langgraphjs`-style `../../src/...js` — confirm from the langsmith entries + the smoke app's built image, which imports from `.dawn/build/` successfully today).
- [ ] **Step 4:** Wire into `node.ts`'s `emit`: after `server.mjs`/Dockerfile, run the discovery (reuse langsmith's calls or share a helper) and write `<buildDir>/modules.mjs`; add it to returned artifacts. Update `SERVER_ENTRY`:

```js
import modules from "./modules.mjs"
// …existing appRoot resolution…
await serveRuntime({ appRoot, modules })
```

- [ ] **Step 5: Run** golden test + existing `build-targets` tests (the node target now emits one more artifact — extend its assertions ADDITIVELY in the new test file if the existing one pins the artifact list; if an existing assertion literally enumerates artifacts, that's a sanctioned, reported edit). Typecheck/lint. **Commit** `feat(cli): node target emits .dawn/build/modules.mjs (static module manifest)`.

---

## Task 4: `dawn check` validation + equivalence e2e

**Files:**
- Modify: `packages/cli/src/commands/check.ts` (stale-manifest pass)
- Test: `packages/cli/test/static-check.test.ts`, `packages/cli/test/static-equivalence.test.ts` (new)

- [ ] **Step 1: check pass** — when `<appRoot>/.dawn/build/modules.mjs` exists: import it, compare its `assistantId` set against `discoverRoutes`' set; mismatch → error listing missing/extra ids (registry-code `DAWN_E1xxx`? — check the error-code registry for a fitting code; if none fits, plain message, note for follow-up). TDD: fixture with a stale manifest (route renamed after generation) → check fails with both ids named; fresh manifest → passes.
- [ ] **Step 2: THE EQUIVALENCE E2E** (the core proof): one fixture app (agent route + tools + state + aimock scripting, reuse the `runtime-fetch-handler.test.ts` fixture pattern). Serve it twice: (a) `createRuntimeFetchHandler({ appRoot })` dynamic; (b) generate `modules.mjs` via the real emitter, import it, boot with `modules`. Drive the identical AP conversation + an AG-UI request against both; assert the response bodies are **deep-equal after normalizing volatile fields** (thread ids, run ids, timestamps — normalize with the fixture-normalization approach `test/generated` uses). Any drift = the static path dropped an input.
- [ ] **Step 3: Run** both new tests + full cli suite. **Commit** `test(cli): static-vs-dynamic equivalence e2e + dawn check stale-manifest pass`.

---

## Task 5: Packed-app proof + harness fixtures

**Files:**
- Possibly modify: `test/generated/fixtures/*.expected.json` (regenerate honestly), `test/generated/run-generated-app.test.ts` (only if the artifact list is pinned)
- Test: extend the packed-app lane

- [ ] **Step 1:** `pnpm verify:harness:framework` — the generated-app lane runs `dawn build` on scaffolded apps; the new `modules.mjs` artifact may appear in transcripts/fixtures. If fixtures diff, regenerate FROM OBSERVED OUTPUT (the `test/generated` normalization pattern; never hand-guess) and report exactly what changed.
- [ ] **Step 2:** Extend the smoke/packed path cheaply: the k8s-smoke app's image build (`test/k8s-smoke/build-image.sh`) runs `dawn build` → its `server.mjs` now boots via `modules.mjs`. Run the LOCAL docker lane (`sh test/k8s-smoke/assert-docker.sh` with Verdaccio, as in the full-arc smoke work — Docker is available) to prove a REAL packed app boots and answers through the static path end-to-end. Report the result; if environmental issues block it locally, say so precisely (CI's lanes will cover it on the PR).
- [ ] **Step 3: Commit** any fixture regenerations `test: regenerate packed-app fixtures for modules.mjs artifact`.

---

## Task 6: Docs, changeset, full verify, PR

- [ ] **Step 1: Docs** — `deployment.mdx`: the node target's artifact list gains `modules.mjs` (one paragraph: what it is, why boot is faster, regenerated every build); `cli.mdx` `dawn check` section: the stale-manifest pass. No banned phrases; gpt-5 ids only; `node scripts/check-docs.mjs` → PASS.
- [ ] **Step 2: Changeset** — **patch**, confirm set via the `git log … --name-only` command (expect `cli` only).
- [ ] **Step 3: Gates** — `pnpm verify:harness:runtime && pnpm verify:harness:smoke && pnpm verify:harness:framework`, then `pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-docs.mjs && pnpm pack:check`.
- [ ] **Step 4:** Rebase, push, PR (`feat(cli): build-time static module manifest — node target boots without discovery (deploy-anywhere B2, PR 2)`), watch lanes + review, fix findings.

**Notes for the executor:** branch continues from PR 1's merged base (new branch `feat/static-modules` off origin/main AFTER PR 1 merges). Pin before subagent dispatch. The equivalence e2e is the heart of this PR — if it's flaky or normalizing away real differences, stop and redesign the normalization rather than loosening assertions.
