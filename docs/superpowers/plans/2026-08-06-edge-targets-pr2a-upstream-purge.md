# Edge Targets PR 2a — Upstream `node:` Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive `KNOWN_UPSTREAM_NODE_EDGES` from 33 to **0** (and `LOADER_EDGES` to 0) so a bundle built from `@dawn-ai/cli/fetch` links on a runtime with no `node:` shim — not just Workers with `nodejs_compat`.

**Architecture:** Give `@dawn-ai/core`, `@dawn-ai/permissions`, `@dawn-ai/workspace`, and `@dawn-ai/langchain` the same pure/node split PR1 (#389) gave the CLI, using the patterns that shipped there: node-only **subpath exports** (`@dawn-ai/core/node`, `@dawn-ai/memory/namespace`), **injection facades** (`MarkerFs`), and **pure ports** (`pure-path.ts`, `pure-hash.ts`). Each step leaves the ratchet strictly smaller and the suite green.

**Tech Stack:** TypeScript strict + `exactOptionalPropertyTypes`, vitest, esbuild (the purity gate), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-05-edge-targets-design.md` (Sequencing section, revised 2026-08-06).
**Survey:** the 33-edge inventory, per-edge classification, and risk analyses are reproduced inline below — no task requires re-deriving them.

**Branch:** `feat/edge-purge-upstream` (cut from `main` at `d845720a`). Pin it before dispatching subagents.

**Invariant:** ZERO edits to existing tests. Baselines to re-measure at Task 1 and hold thereafter: root `pnpm test` (currently ~1502 passed / 0 failed / 33 skipped on this branch — CONFIRM before starting), plus per-package counts (core 33 files, permissions 3, workspace 5, langchain 30, cli 89).

**Ratchet discipline:** after every task, `packages/cli/test/fetch-entry-purity.test.ts` must pass with `KNOWN_UPSTREAM_NODE_EDGES` **shrunk by exactly the edges that task removes** — never widened, never left stale. Removing an entry that is still present fails the subset check; leaving a stale entry is caught by Task 9's final `toEqual([])`.

---

## THE SECURITY-CRITICAL DECISION (read before Task 1)

Three sites decide workspace containment, all on the request path:

1. `packages/core/src/capabilities/workspace-fs.ts:30` — `resolve(opts.workspaceRoot, path)`
2. `workspace-fs.ts:31-32` — `backend.realPath()` on **both** operands (symlink canonicalization)
3. `packages/core/src/capabilities/permission-gate.ts:33` — `absPath === workspaceRoot || absPath.startsWith(workspaceRoot + sep)`

**`resolve(root, "/etc/passwd")` returns `/etc/passwd`** — an absolute second argument WINS. A `pureJoin`-shaped replacement yields `<root>/etc/passwd`, which then PASSES the containment check: **a silent jail escape**. Additionally, `pure-path.ts`'s "POSIX-only, Windows paths only flow through build-time code" carve-out is **false here** — `workspaceRoot` derives from `process.cwd()`, so on Windows a POSIX-only `sep` makes every legitimate inside-path read as outside (fail-closed denial storms).

**DECISION (survey's ranked option 1): normalize at the boundary, compare purely.** The node lane converts `workspaceRoot` (and any host-derived absolute path) to a canonical POSIX form **once, at boot, using real `node:path`**; core's jail then does pure string containment against an explicit `"/"`. This confines the Windows question to one node-side conversion that already exists, instead of asking a hand-rolled `pureResolve` to replicate `path.win32`.

Consequences the tasks below implement:
- `pureResolve` still exists (Task 1) and MUST implement absolute-segment-wins, but it is only ever fed already-POSIX inputs.
- Core gains no Windows awareness; the CLI's boot path owns the conversion.
- Task 8 carries an adversarial suite and is reviewed on its own.

---

### Task 1: `@dawn-ai/sdk/pure` — shared pure helpers (keystone)

Everything downstream imports these. `pure-path.ts`/`pure-hash.ts` currently live in `packages/cli/src/lib/runtime/`, but `cli` is DOWNSTREAM of all four target packages, so they must move. `@dawn-ai/sdk` is the right home: zero `node:` imports today, zero `@dawn-ai/*` deps, and `core`/`langchain` already depend on it.

**Files:**
- Create: `packages/sdk/src/pure/path.ts`, `packages/sdk/src/pure/hash.ts`, `packages/sdk/src/pure/index.ts`
- Modify: `packages/sdk/package.json` (add `"./pure"` subpath export — mirror `@dawn-ai/core`'s `"./node"` entry added in #389)
- Modify: `packages/cli/src/lib/runtime/pure-path.ts`, `pure-hash.ts` → become re-export shims (`export * from "@dawn-ai/sdk/pure"`) so the ~9 existing CLI call sites don't churn
- Modify: `packages/permissions/package.json`, `packages/workspace/package.json` (add `@dawn-ai/sdk` dependency — acyclic, sdk is a leaf)
- Test: `packages/sdk/test/pure-path.test.ts`, `packages/sdk/test/pure-hash.test.ts`

- [ ] **Step 1: Move the existing files verbatim, add the subpath, verify nothing broke**

Copy `packages/cli/src/lib/runtime/pure-path.ts` → `packages/sdk/src/pure/path.ts` and `pure-hash.ts` → `packages/sdk/src/pure/hash.ts` UNCHANGED (they are already parity-tested). `packages/sdk/src/pure/index.ts` re-exports both. Add to `packages/sdk/package.json`:

```json
"./pure": {
  "types": "./dist/pure/index.d.ts",
  "default": "./dist/pure/index.js"
}
```

Replace the CLI files' bodies with `export * from "@dawn-ai/sdk/pure"`. Copy `packages/cli/test/pure-path.test.ts` and `pure-hash.test.ts` to `packages/sdk/test/` adjusting import paths (the CLI copies stay — they now exercise the shims, which is a useful re-export regression net).

Run: `pnpm build && pnpm --filter @dawn-ai/cli test && pnpm --filter @dawn-ai/sdk test`
Expected: all green, CLI count unchanged.

- [ ] **Step 2: Write the failing parity tests for the NEW helpers**

Add to `packages/sdk/test/pure-path.test.ts`:

```ts
import { posix } from "node:path"

describe("pureResolve parity with path.posix.resolve", () => {
  // The security-critical case FIRST: an absolute later segment wins.
  const cases: readonly (readonly string[])[] = [
    ["/app/workspace", "/etc/passwd"],
    ["/app/workspace", "notes.txt"],
    ["/app/workspace", "../escape"],
    ["/app/workspace", "./a/./b"],
    ["/app/workspace", ""],
    ["/app/workspace", "a", "/abs", "b"],
    ["/app/workspace/", "sub/"],
    ["/", ".."],
    ["/a/b", "../../../.."],
    ["/app", "a//b"],
  ]
  it("matches node for every case (absolute-wins included)", () => {
    for (const parts of cases) {
      expect(pureResolve(...parts), `resolve(${JSON.stringify(parts)})`).toBe(posix.resolve(...parts))
    }
  })
  it("an absolute second argument discards the base — the jail-escape case", () => {
    expect(pureResolve("/app/workspace", "/etc/passwd")).toBe("/etc/passwd")
  })
})

describe("pureRelative parity with path.posix.relative", () => {
  const pairs: readonly (readonly [string, string])[] = [
    ["/app/workspace", "/app/workspace/tool-outputs/x.txt"],
    ["/app/workspace", "/app/workspace"],
    ["/app/workspace", "/app/workspace-evil/secret"],
    ["/app/workspace", "/etc/passwd"],
    ["/a/b/c", "/a/b"],
    ["/a", "/a/b/c"],
  ]
  it("matches node for every pair", () => {
    for (const [from, to] of pairs) {
      expect(pureRelative(from, to), `relative(${from}, ${to})`).toBe(posix.relative(from, to))
    }
  })
})
```

NOTE: `pureResolve` differs from node's `path.resolve` in one deliberate way — node falls back to `process.cwd()` when no segment is absolute. The pure version has no cwd. **Contract: `pureResolve` REQUIRES its first segment to be absolute and throws a clear error otherwise** (`"pureResolve requires an absolute base; got \"<x>\" — the node lane must canonicalize before calling"`). Add a test asserting that throw, and compare against `posix.resolve` only for absolute-base cases (all the ones listed).

Add to `packages/sdk/test/pure-hash.test.ts` a `sha256Hex` parity block mirroring the existing `sha1Hex` one: spec vectors (empty string, `"abc"`, the 448-bit boundary message), padding boundaries at 55/56/64 bytes, a multi-block input, and a UTF-8 (multi-byte) input — each asserted against `createHash("sha256").update(x).digest("hex")`.

- [ ] **Step 3: Run — must fail** (`pureResolve`/`pureRelative`/`sha256Hex` don't exist)

Run: `pnpm --filter @dawn-ai/sdk exec vitest run test/pure-path.test.ts test/pure-hash.test.ts`

- [ ] **Step 4: Implement, iterating against the parity suite**

Add `pureResolve`, `pureRelative`, and `POSIX_SEP = "/"` to `packages/sdk/src/pure/path.ts`, and `sha256Hex` to `hash.ts`. Port faithfully from node's `path.posix` / FIPS 180-4; the tests are the spec — iterate until green rather than trusting a first draft.

- [ ] **Step 5: Full verification + commit**

Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`

```bash
git add packages/sdk packages/cli/src/lib/runtime/pure-path.ts packages/cli/src/lib/runtime/pure-hash.ts packages/permissions/package.json packages/workspace/package.json pnpm-lock.yaml
git commit -m "feat(sdk): @dawn-ai/sdk/pure — shared pure path/hash helpers (adds pureResolve/pureRelative/sha256Hex)"
```

---

### Task 2: `@dawn-ai/permissions` — `./node` subpath *(−4 edges → 29)*

Smallest surface, leaf package. Establishes the split rhythm.

**Files:**
- Create: `packages/permissions/src/node.ts` (moves `createPermissionsStore` verbatim)
- Modify: `packages/permissions/src/permissions-store.ts` (becomes node-only, re-homed) and `packages/permissions/src/index.ts` (drop the store export from `.`)
- Modify: `packages/permissions/src/suggested-pattern.ts:20` (`dirname` → `pureDirname`)
- Modify: `packages/permissions/package.json` (`"./node"` subpath)
- Modify: CLI import sites — `grep -rn "createPermissionsStore" packages/cli/src` (expect `execute-route.ts` / the node fallbacks) → import from `@dawn-ai/permissions/node`
- Modify: `packages/cli/test/fetch-entry-purity.test.ts` (remove the 4 permissions entries from `KNOWN_UPSTREAM_NODE_EDGES`)
- Test: `packages/permissions/test/entry-purity.test.ts` (new — see Step 3)

- [ ] **Step 1: Move `createPermissionsStore` to `src/node.ts` verbatim**, keep `matchPermission`, `suggested*`, and every type on `.`. The `PermissionsStore` interface stays on `.` (core imports it type-only).

- [ ] **Step 2: Swap `suggested-pattern.ts:20`** `dirname(path)` → `pureDirname(path)` from `@dawn-ai/sdk/pure`; delete the `node:path` import.

- [ ] **Step 3: Write a package-level purity guard** — `packages/permissions/test/entry-purity.test.ts`: bundle `src/index.ts` with esbuild `platform: "neutral"`, assert zero `node:` inputs. (Model it on the CLI's `fetch-entry-purity.test.ts` `bundle()` helper but keep it minimal — this is a per-package tripwire so the split can't silently regress.) Add `esbuild` to `packages/permissions/devDependencies`.

- [ ] **Step 4: Shrink the ratchet by exactly 4** and verify

Run: `pnpm build && pnpm --filter @dawn-ai/permissions test && pnpm --filter @dawn-ai/cli exec vitest run test/fetch-entry-purity.test.ts && pnpm test`
Expected: purity gate green with 29 pinned edges; all 13 existing permissions-store tests pass unmoved.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(permissions): node-only store behind ./node; pure dirname in suggested-pattern"
```

---

### Task 3: `@dawn-ai/langchain` offload — value-pin, then swap *(−2 → 27)*

**Files:**
- Modify: `packages/langchain/test/offload-store.test.ts` — **value pin FIRST** (Step 1)
- Modify: `packages/langchain/src/offload/offload-store.ts` (`createHash` → `sha256Hex`; `join` → `pureJoin`; drop both `node:` imports)
- Modify: `packages/cli/test/fetch-entry-purity.test.ts` (remove the 2 langchain entries)

- [ ] **Step 1: Add the value pin** (existing test asserts only the SHAPE `/^generateReport-[0-9a-f]{16}\.txt$/`, so an algorithm swap would pass silently). This is the one sanctioned edit to an existing test in this PR — it ADDS an assertion, changes none:

```ts
it("derives the fallback filename from a sha256 of the content (value-pinned)", () => {
  // No toolCallId → content-hash fallback. Pinned so an algorithm change is a
  // visible diff rather than an invisible one.
  expect(buildOffloadFileName({ toolName: "generateReport", content: "hello world" }))
    .toBe(`generateReport-${createHash("sha256").update("hello world").digest("hex").slice(0, 16)}.txt`)
})
```

Read the real signature of `buildOffloadFileName` first and match it. Run it — must PASS against the current implementation (it is a characterization test).

- [ ] **Step 2: Swap** `createHash("sha256")…` → `sha256Hex(content).slice(0, 16)` and the four `join` sites → `pureJoin`. Delete `node:crypto`/`node:path` imports. The pin from Step 1 must still pass — that IS the parity proof.

- [ ] **Step 3: Shrink the ratchet by 2; verify** — `pnpm build && pnpm --filter @dawn-ai/langchain test && pnpm --filter @dawn-ai/cli exec vitest run test/fetch-entry-purity.test.ts && pnpm test`

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(langchain): pure sha256/join in offload-store (filename value-pinned first)"
```

---

### Task 4: `@dawn-ai/workspace` `./node` + core injection seam *(−4 → 23)*

The package move is trivial; the work is on the CORE side, which currently reaches for the node backends by static import.

**Files:**
- Create: `packages/workspace/src/node.ts` (re-exports `localExec` + `localFilesystem`)
- Modify: `packages/workspace/package.json` (`"./node"` subpath); `src/index.ts` (drop both from `.`, keep every type + the `FilesystemBackend`/`ExecBackend` interfaces)
- Modify: `packages/core/src/capabilities/built-in/workspace.ts:4,127-128` — delete the static import; take injected factories
- Modify: `packages/core/src/capabilities/types.ts` — `CapabilityMarkerContext` gains `backendFactories?: { filesystem?: () => FilesystemBackend; exec?: () => ExecBackend }` (type-only import from `@dawn-ai/workspace`)
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts` — pass the factories from the existing `RuntimeBootFallbacks.defaultFilesystem` seam
- Modify: CLI import sites of `localExec`/`localFilesystem` → `@dawn-ai/workspace/node`
- Test: `packages/core/test/capabilities/workspace-injection.test.ts` (new)

- [ ] **Step 1: Failing test** — the marker with NO injected factory and NO `backends` must throw the loud message (mirroring PR1's `requireFallbacks` style), not silently construct a node backend:

```ts
it("throws a clear error when no filesystem backend is available", async () => {
  const marker = createWorkspaceMarker()
  const contribution = await marker.load("/route", baseContext({ workspaceRoot: "/workspace" }))
  const readFile = contribution.tools?.find((t) => t.name === "readFile")
  await expect(readFile?.run({ path: "x.txt" }, { signal: new AbortController().signal }))
    .rejects.toThrow(/no filesystem backend/i)
})
```

Plus a positive case asserting an INJECTED factory is used (spy: called once, its backend's `readFile` receives the resolved path).

- [ ] **Step 2: Run — must fail** (today it silently constructs `localFilesystem()`).

- [ ] **Step 3: Implement** the subpath move + the injection. Precedence in core: `context.backends?.filesystem` (an already-constructed backend, e.g. sandbox) → `context.backendFactories?.filesystem()` → throw. Same for exec.

- [ ] **Step 4: Rewire the CLI** so `dawn dev`/`start` behavior is unchanged: `execute-route-core.ts` passes `backendFactories: { filesystem: fallbacks.defaultFilesystem, exec: … }` when fallbacks exist. `packages/cli/test/lazy-node-backends.test.ts` is the regression net — it must still pass unedited.

- [ ] **Step 5: Shrink by 4; full verify** — `pnpm build && pnpm test && pnpm --filter @dawn-ai/cli exec vitest run test/fetch-entry-purity.test.ts`, plus `pnpm verify:harness:runtime` (this touches the live dev path's backend construction).

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(workspace,core): node backends behind ./node; core takes injected backend factories"
```

---

### Task 5: `@dawn-ai/core` discovery + typegen subpaths *(−10 edges, −3 loader edges → 13)*

Largest mechanical diff, zero behavioral risk. Kept separate from the capability work so the review surfaces don't mix.

**Files:**
- Modify: `packages/core/package.json` — extend the existing `"./node"` subpath (added in #389) to also export discovery + typegen, OR add `"./discovery"` and `"./build"` (pick ONE and state it in the commit message; prefer extending `"./node"` — fewer entry points, and both are node-only by nature)
- Modify: `packages/core/src/index.ts:53-56,63-71` — remove the discovery + typegen re-exports from the `.` barrel
- Modify: CLI import sites — `grep -rn "discoverRoutes\|findDawnApp\|extractTool" packages/cli/src` (expect `commands/{typegen,routes,check,build,verify}.ts`, `lib/typegen/run-typegen.ts`, `lib/build/targets/*`, `lib/runtime/*`)
- Modify: `packages/cli/test/fetch-entry-purity.test.ts` — remove 10 upstream entries AND 3 `LOADER_EDGES`
- Modify: any vitest config aliasing `@dawn-ai/core` — **subpath aliases MUST precede the bare alias** (prefix-match trap documented in `packages/cli/vitest.config.ts:15-19`)

- [ ] **Step 1: Move** `discovery/*` and `typegen/*` behind the node subpath; drop from the `.` barrel. This is a **public API surface change** — note it in the changeset (Task 10) and check `apps/web/content/docs/` for any documented import of these symbols (`grep -rn "discoverRoutes\|findDawnApp" apps/web/content/docs/`).

- [ ] **Step 2: Repoint every consumer**, then `pnpm build && pnpm typecheck` — TypeScript finds all of them.

- [ ] **Step 3: Shrink by 10 + 3 loader edges; verify** — `pnpm test`, purity gate green at 13.

- [ ] **Step 4: Commit** — `refactor(core): discovery + typegen behind the node subpath`

---

### Task 6: `@dawn-ai/core` `config.ts` split *(−4 edges, −1 loader edge → 9, loader → 0)*

Isolated deliberately: the memo/eviction semantics are subtle and guarded by 12 tests across 3 files.

**Files:**
- Create: `packages/core/src/config-node.ts` (`loadDawnConfigUncached` + `registerTsxLoader`, verbatim)
- Modify: `packages/core/src/config.ts` → pure: the `configCache` Map, `seedDawnConfig`, `__clearDawnConfigCacheForTests`, and `loadDawnConfig` dispatching through a **registered loader** (`registerConfigLoader(fn)` called by the node lane; absent ⇒ `loadDawnConfig` rejects with a clear "no config loader registered — this runtime cannot read dawn.config.ts; pass `config` instead" error)
- Modify: `packages/core/package.json` (config-node under the node subpath), `src/index.ts`
- Modify: CLI — register the loader at the node entry points (`execute-route.ts`'s node wrapper / CLI bin), so `dawn dev`/`start`/`run`/`test` behavior is unchanged

- [ ] **Step 1: Failing test** — `packages/core/test/config-loader-seam.test.ts`: with no loader registered, `loadDawnConfig` rejects with the named error; with a fake loader registered, it resolves through it and MEMOIZES (second call doesn't re-invoke); `seedDawnConfig` still beats both; the identity-checked rejection eviction (from PR1) still holds when the registered loader rejects.

- [ ] **Step 2: Run red, implement, green.** The 12 existing tests in `config.test.ts`, `config-memo.test.ts`, `seed-dawn-config.test.ts` must pass UNEDITED — they are the real guard.

- [ ] **Step 3: Shrink by 4 + the last loader edge; verify** — `pnpm test`, `pnpm verify:harness:runtime` (config loading is on the live dev path), purity gate at 9 with `LOADER_EDGES` now EMPTY (rework its `length > 0` self-check per Task 9).

- [ ] **Step 4: Commit** — `refactor(core): pure config memo + node-only loader registration`

---

### Task 7: `@dawn-ai/core` capabilities — mechanical swaps *(−7 → 2)*

**Files:** `packages/core/src/capabilities/built-in/{memory,memory-md,planning,skills,agents-md,subagents}.ts`

- [ ] **Step 1: Value-pin memory ids BEFORE touching them.** `packages/core/test/capabilities/memory.test.ts` — add an assertion pinning one `memory_<16 hex>` id for a fixed input (today's tests are regex-shape only). Must PASS pre-change (characterization).

- [ ] **Step 2: Swap** — `memory.ts:209,350` `createHash("sha1")…` → `sha1Hex(...)` (byte-identical, already parity-pinned); `memory-md.ts`, `planning.ts`, `skills.ts` `join` → `pureJoin`; `agents-md.ts:41` `resolve(appRoot, "workspace", "AGENTS.md")` → `pureResolve` (appRoot is absolute on every path that reaches here — assert it, since `pureResolve` throws on a relative base). Delete the `node:path`/`node:crypto` imports.

- [ ] **Step 3: `subagents.ts` injection.** `loadDescription`'s disk branch (`:44-48`) becomes an injected `loadRouteDescription?: (route) => Promise<string | undefined>` on `CapabilityMarkerContext`; the node implementation lives in the core node subpath and is supplied by the CLI's node lane. Confirm the static-map path (`routeDescriptors` present) still short-circuits FIRST — it is what the fetch path uses, and `packages/core/test/capabilities/subagents-static.test.ts` guards it. **Verify the fallback branch has a test before making it injectable; if not, add one.**

- [ ] **Step 4: Shrink by 7; verify** — `pnpm test` (the memory-id pin proves ids are unchanged), purity gate at 2.

- [ ] **Step 5: Commit** — `refactor(core): pure path/hash in capability markers; injected route-description loader`

---

### Task 8: `@dawn-ai/core` path jail *(−2 → 0)* — REVIEW THIS ONE ALONE

Implements the boundary-normalization decision above. **Do not merge this task's commit with any other.**

**Files:**
- Modify: `packages/core/src/capabilities/workspace-fs.ts:30`, `packages/core/src/capabilities/permission-gate.ts:33`, `packages/core/src/capabilities/built-in/workspace.ts:61-64`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (node lane) — canonicalize `workspaceRoot` to POSIX once, at boot
- Test: `packages/core/test/capabilities/path-jail-adversarial.test.ts` (new)

- [ ] **Step 1: Write the adversarial suite FIRST**, asserting today's behavior (characterization — it must pass against the CURRENT node-path implementation, then still pass after):

```ts
// Each case: (workspaceRoot, requestedPath) → inside | outside
const CASES = [
  ["/app/workspace", "notes.txt", "inside"],
  ["/app/workspace", "sub/dir/notes.txt", "inside"],
  ["/app/workspace", ".", "inside"],              // the root itself
  ["/app/workspace", "/etc/passwd", "outside"],   // THE JAIL-ESCAPE CASE
  ["/app/workspace", "../escape", "outside"],
  ["/app/workspace", "../workspace-evil/x", "outside"],
  ["/app/workspace", "sub/../../escape", "outside"],
  ["/app/workspace", "sub/../notes.txt", "inside"],
  ["/app/workspace", "", "inside"],
] as const
```

Drive them through the REAL `createWorkspaceFs` + `gatePathOp` (with a fake `FilesystemBackend` whose `realPath` is identity, so the test isolates the PATH logic from symlink canonicalization). Also keep a case proving the sibling-prefix rule (`/app/workspace-evil/secret` is outside `/app/workspace`) and one proving root-equality (no trailing separator).

- [ ] **Step 2: Run against current code — must PASS** (characterization). If any case fails, STOP: you have found a pre-existing jail bug, which is a security finding to report before proceeding.

- [ ] **Step 3: Swap to pure**, keeping the ORDER of operations identical: `pureResolve(workspaceRoot, path)` → `realPath` on both operands (UNCHANGED — symlink canonicalization stays in the backend) → `absPath === root || absPath.startsWith(root + "/")`. The `tool-outputs` predicate at `built-in/workspace.ts:61-64` uses `pureRelative` + `"/"`.

- [ ] **Step 4: Node-lane canonicalization.** In the CLI's node path, convert `workspaceRoot` to canonical POSIX before handing it to core (on POSIX hosts this is identity; the conversion exists so a Windows host produces `/`-separated absolute paths). Document in a comment that core's jail assumes POSIX-normalized input and that this is the single conversion point.

- [ ] **Step 5: Verify** — the adversarial suite green, `packages/core/test/capabilities/workspace-fs.test.ts` (incl. the symlink-escape cases at `:211`/`:232`) and `workspace.test.ts` and `permission-gate.test.ts` ALL green unedited, `pnpm test`, purity gate at **0 upstream edges**, `pnpm verify:harness:runtime` + `smoke`.

- [ ] **Step 6: Commit** — `refactor(core): pure path jail with node-lane POSIX normalization`

---

### Task 9: Close the gate *(ratchet → strict zero)*

**Files:** `packages/cli/test/fetch-entry-purity.test.ts`

- [ ] **Step 1: Replace the subset check** with `expect(nodeImportEdges(metafile)).toEqual([])`; delete `KNOWN_UPSTREAM_NODE_EDGES`. Rework `LOADER_EDGES` the same way (it is empty after Task 6) — remove its `length > 0` self-check, which existed only to prevent a vacuous subset pass and is meaningless against an equality assertion.

- [ ] **Step 2: Keep the negative control meaningful** — it currently asserts the gate fails against `runtime-exports.ts`; with `KNOWN_*` gone it must still assert `nodeImportEdges(runtime-exports).length > 0`. Verify it fails if you point the strict assertion at `runtime-exports.ts`.

- [ ] **Step 3: Consider a link-smoke** (judgment call — implement if it is under ~30 lines, else note it as a PR3 follow-up): bundle with `platform: "browser"` and no `node:*` externals, asserting the build SUCCEEDS. That is the closest thing to a shim-less-runtime link test available without workerd, and it directly covers the failure mode this whole PR exists to remove.

- [ ] **Step 4: Commit** — `test(cli): purity gate asserts zero node: edges (ratchet closed)`

---

### Task 10: Docs + changeset + full verification + PR

- [ ] **Step 1: Changeset** — confirm the touched set (`git log --oneline origin/main..HEAD --name-only -- packages/ | grep '^packages/' | cut -d/ -f2 | sort -u`; expect sdk, permissions, workspace, langchain, core, cli). **patch** for all (fixed-group 0.x turns any minor into 1.0.0). Call out the public-API surface change: discovery/typegen/`createPermissionsStore`/`localFilesystem`/`localExec` moved off their packages' `.` barrels onto node subpaths.

- [ ] **Step 2: Docs** — update the `deployment.mdx` "Edge runtimes (preview)" callout added in PR1: the `nodejs_compat`-required warning becomes "no `node:` shim required"; state which imports moved to node subpaths so an app author hitting a resolution error knows why.

- [ ] **Step 3: Full gates** — `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/check-docs.mjs && pnpm pack:check` (the new subpaths must package), plus `pnpm verify:harness:runtime && smoke && framework`.

- [ ] **Step 4: PR** — title `refactor: purge upstream node: imports from the edge graph — bundle links without a node shim (deploy-anywhere B3, PR 2a)`. Body: the before/after edge count, the jail decision and its adversarial suite, the two value-pins (memory ids, offload filenames), and the public-API moves. Watch lanes, fix findings, merge on green.

---

## Self-review notes (writing-plans checklist)

- **Survey coverage:** all 33 edges are assigned to a task — permissions 4 (T2), langchain 2 (T3), workspace 4 (T4), core discovery/typegen 10 (T5), core config 4 (T6), core capabilities 7 (T7), core jail 2 (T8) = 33. `LOADER_EDGES` 4 = T5 (3) + T6 (1).
- **The `sideEffects: false` shortcut is deliberately NOT used** as a substitute (it would make the gate pass for a reason unrelated to the source being clean, and fixes only the bundled case). Adding it as a *complement* is fine but out of scope here.
- **Type consistency:** `pureResolve`/`pureRelative`/`sha256Hex` are introduced in T1 and used by name in T3, T7, T8; `backendFactories` is introduced in T4 and not referenced earlier; `loadRouteDescription` only in T7.
- **Known risk:** T8 is the security-relevant one, which is why it carries a characterization suite that must pass BEFORE the swap, is committed alone, and is called out for independent review.
