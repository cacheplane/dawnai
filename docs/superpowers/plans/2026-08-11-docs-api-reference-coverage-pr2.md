# Dawn API Reference Coverage — Pull Request 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete detailed API coverage for the six remaining supported integration packages, classify every catalog-only/internal artifact, eliminate the PR 1 deferral mechanism, and reconcile every remaining package README.

**Architecture:** Branch from merged Pull Request 1 and extend its registries, inventory/fingerprint checks, discovery consumers, and hub. Six new hidden nested pages bring `API_REFERENCE_PAGES` to 16 and `ALL_DOCS_PAGES` to 74 while `DOCS_PAGES` stays 58. The artifact schema removes `deferred-to-pr2` entirely so future public surfaces must be detailed or explicitly catalog/internal in the same change that exposes them.

**Tech Stack:** TypeScript 7, Next.js 16, MDX, Vitest, esbuild, pnpm workspaces, Node.js 24, changesets.

**Prerequisite:** Pull Request 1 from `docs/superpowers/plans/2026-08-11-docs-api-reference-platform-pr1.md` is merged and `origin/main` is green.

---

## File structure

Create six page/wrapper pairs:

- `apps/web/content/docs/api/{permissions,workspace,sandbox,langgraph,langchain,sqlite-storage}.mdx`
- `apps/web/app/docs/api/{permissions,workspace,sandbox,langgraph,langchain,sqlite-storage}/page.tsx`

Extend the PR 1 registry/checker modules; do not introduce a second inventory system. Modify package READMEs only to establish concise canonical entrypoints.

All commands run from the repository root with Node 24:

```bash
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node --version # v24.19.0
```

## Required PR 2 behavior contracts

Each page must include the exact normalized claim below in a bounded `#### Behavior contract \`<id>\`` block and add the matching `API_BEHAVIOR_CONTRACTS` entry. `test-assertion` entries fingerprint the named test's `expect(...)` assertions; `source-ast` entries fingerprint the selected source declaration/export shape. Additional behavior claims require equally exact authorities.

| ID | Exact claim | Authority |
|---|---|---|
| `permissions.match.prefix` | Non-reserved command, path, and memory candidates use prefix matching, and deny wins over allow. | `packages/permissions/test/pattern-matching.test.ts`, tests `commands keep prefix matching`, `treats path candidates with absolute prefixes`, `allows deeper namespaces under the route`, `deny wins over allow when both match`, and `deny wins over allow for the memory key` |
| `permissions.tool.exact` | Reserved tool names match exactly rather than by prefix. | `packages/permissions/test/pattern-matching.test.ts`, tests `does not prefix-match tool names` and `matches an exact tool name` |
| `permissions.store.noninteractive` | Non-interactive mode ignores the runtime permissions file. | `packages/permissions/test/permissions-store.test.ts`, test `ignores the runtime file in non-interactive mode` |
| `workspace.compose.order` | Backend middleware composes right-to-left, with the first listed middleware outermost. | `packages/workspace/test/compose.test.ts`, test `applies middlewares right-to-left (outermost first)` |
| `workspace.exec.timeout` | The local exec backend enforces its configured timeout. | `packages/workspace/test/local-exec.test.ts`, test `runCommand enforces timeout` |
| `workspace.filesystem.symlink` | `localFilesystem.realPath` resolves an escaping symlink to its outside real path; Core owns any path-jail enforcement. | `packages/workspace/test/local-filesystem.test.ts`, test `realPath resolves an escaping symlink to the outside real path` |
| `sandbox.docker.release` | Docker release removes the container but retains its volume; destroy removes both. | `packages/sandbox/test/docker-sandbox.unit.test.ts`, test `release removes container but not volume; destroy removes both` |
| `sandbox.kubernetes.release` | Kubernetes release deletes the Pod but retains the PVC; destroy removes both. | `packages/sandbox/test/kube-sandbox.unit.test.ts`, test `release deletes the pod but keeps the PVC; destroy removes both` |
| `sandbox.kubernetes.allow-network` | Kubernetes `network:allow` without an allowlist emits no NetworkPolicy. | `packages/sandbox/test/kube-sandbox.unit.test.ts`, test `network:allow with no allowlist emits no NetworkPolicy` |
| `sandbox.error.create` | A failed sandbox container creation is tagged `DAWN_E2001`. | `packages/sandbox/test/sandbox-error-code.test.ts`, test `a failed container creation throws an error tagged DAWN_E2001` |
| `sqlite.checkpointer.persistence` | A file-backed SQLite checkpoint persists across saver instances. | `packages/sqlite-storage/test/checkpointer.test.ts`, test `persists across saver instances (file-backed)` |
| `sqlite.threads.order` | `listThreads` returns most-recently-updated threads first. | `packages/sqlite-storage/test/threads.test.ts`, test `listThreads returns most-recently-updated first` |
| `sqlite.db.pragmas` | SQLite opens with WAL mode, foreign keys enabled, and synchronous NORMAL. | `packages/sqlite-storage/test/db.test.ts`, test `opens a database with WAL journal_mode, foreign_keys ON, and synchronous=NORMAL` |
| `sqlite.public.no-close` | The public SQLite saver and thread store expose no explicit close method. | Two required authorities: `packages/sqlite-storage/src/checkpointer/saver.ts` `DawnSqliteSaver` public-member `source-ast` assertion and `packages/sqlite-storage/src/threads/store.ts` `ThreadsStore` public-member `source-ast` assertion; both member sets must omit `close`, and a mutation adding `close` to either set must fail |
| `langgraph.entry.exclusive` | A route module must provide exactly one of graph or workflow. | `packages/langgraph/test/define-entry.test.ts`, tests `rejects modules that provide both graph and workflow` and `rejects modules that provide neither graph nor workflow` |
| `langgraph.route-module.surface` | The route-module subpath exposes only its published normalization and route-module contracts. | `packages/langgraph/test/route-module.test.ts`, test `exposes publishable exports and types on the package surface` |
| `langchain.provider.explicit` | An explicit model provider bypasses provider inference. | `packages/langchain/test/model-provider-resolver.test.ts`, test `explicit provider bypasses inference` |
| `langchain.retry.exhaustion` | Retry throws after the configured maximum attempts are exhausted. | `packages/langchain/test/retry.test.ts`, test `throws after max attempts exhausted` |
| `langchain.tool-loop.limit` | The tool loop limits iterations to prevent an infinite loop. | `packages/langchain/test/tool-loop.test.ts`, test `limits tool loop iterations to prevent infinite loops` |
| `langchain.chain.stream-fallback` | A chain stream falls back to invoke when the entry has no stream method. | `packages/langchain/test/chain-adapter.test.ts`, test `stream falls back to invoke when no stream method` |

### Task 1: Start from merged PR 1 and verify the baseline

**Files:**
- No production changes.

- [ ] **Step 1: Create the coverage branch from current main**

```bash
git fetch origin
git switch -c blove/docs-api-reference-coverage origin/main
git merge-base --is-ancestor <PR1_MERGE_SHA> HEAD
```

Expected: the ancestor check exits 0 and the worktree is clean.

- [ ] **Step 2: Verify the exact PR 1 handoff**

Require the merged baseline:

```ts
expect(API_REFERENCE_PAGES).toHaveLength(10)
expect(ALL_DOCS_PAGES).toHaveLength(68)
expect(DOCS_PAGES).toHaveLength(58)
```

Require the PR 1 deferred allowlist to contain exactly the 12 approved import records and no others.

- [ ] **Step 3: Run the merged baseline GREEN**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/nav.test.ts
node scripts/check-docs.mjs
```

Expected: all commands pass. Stop if PR 1 is not fully merged/green; do not reimplement its platform in PR 2.

### Task 2: Add Permissions and Workspace references

**Files:**
- Create: `apps/web/content/docs/api/permissions.mdx`
- Create: `apps/web/app/docs/api/permissions/page.tsx`
- Create: `apps/web/content/docs/api/workspace.mdx`
- Create: `apps/web/app/docs/api/workspace/page.tsx`
- Modify: `apps/web/app/components/docs/api-reference.ts`
- Modify: `apps/web/app/components/docs/api-reference.test.ts`
- Modify: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `packages/cli/test/api-reference-compatibility.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Add RED inventory and contract assertions**

Append Permissions and Workspace to `API_REFERENCE_PAGES`, making the counts 12/70/58. Convert only their four import records from deferred to detailed, leaving the exact eight-record remainder. Permissions root must own its 15 exports and `/node` must own `createPermissionsStore`. Workspace root must own its 16 exports and `/node` must own `localExec`/`localFilesystem` plus the two option types. Root re-exports and `/node` ownership are independent rows.

- [ ] **Step 2: Add compatibility RED cases**

Require Permissions root `edge-safe/not-claimed`, Permissions `/node` `node-only`, Workspace root `edge-safe/dependency-free`, and Workspace `/node` `node-only`. The dependency-free guard must inspect the emitted subpath graph, not merely source text.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
pnpm --filter @dawn-ai/cli test -- test/api-reference-compatibility.test.ts
```

Expected: new registry/page ownership, missing content/wrappers, and guard IDs fail.

- [ ] **Step 4: Author Permissions from source**

Use `packages/permissions/src/{index,node,types,pattern-matching,suggested-pattern}.ts` and its pattern/store/contract tests. Document prefix matching versus exact reserved keys, persistence/load ownership, and the inline `{ appRoot, config, mode }` input to `createPermissionsStore` without claiming private `CreateOptions` is exported.

- [ ] **Step 5: Author Workspace from source**

Use `packages/workspace/src/{index,node,types,sandbox-types,compose,with-logging,local-exec,local-filesystem}.ts` and matching tests. Workspace owns the canonical sandbox interface field tables. Do not attribute Core's path jail to `localFilesystem`.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @dawn-ai/permissions test
pnpm --filter @dawn-ai/workspace test
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
pnpm --filter @dawn-ai/cli test -- test/api-reference-compatibility.test.ts
node scripts/check-docs.mjs
git add apps/web/content/docs/api/permissions.mdx apps/web/app/docs/api/permissions apps/web/content/docs/api/workspace.mdx apps/web/app/docs/api/workspace apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference.test.ts apps/web/app/components/docs/api-reference-inventory.test.ts apps/web/app/components/docs/nav.test.ts packages/cli/test/api-reference-compatibility.test.ts scripts/check-docs.mjs
git commit -m "docs: add permissions and workspace APIs"
```

### Task 3: Add Sandbox and SQLite Storage references

**Files:**
- Create: `apps/web/content/docs/api/sandbox.mdx`
- Create: `apps/web/app/docs/api/sandbox/page.tsx`
- Create: `apps/web/content/docs/api/sqlite-storage.mdx`
- Create: `apps/web/app/docs/api/sqlite-storage/page.tsx`
- Modify: `apps/web/app/components/docs/api-reference.ts`
- Modify: `apps/web/app/components/docs/api-reference.test.ts`
- Modify: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `packages/cli/test/api-reference-compatibility.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Add RED inventories**

Append Sandbox and SQLite Storage, making the counts 14/72/58. Convert their three import records to detailed, leaving exactly the five LangGraph/LangChain records deferred. Sandbox root owns nine exports and `/testing` owns `fakeSandbox`/`runProviderConformance`. SQLite owns its nine public exports. Re-exported sandbox interfaces remain discoverable but link to Workspace for canonical fields.

- [ ] **Step 2: Run focused RED**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
pnpm --filter @dawn-ai/cli test -- test/api-reference-compatibility.test.ts
node scripts/check-docs.mjs
```

Expected: missing Sandbox/SQLite content, wrappers, ownership, and guard IDs fail; prior pages remain green.

- [ ] **Step 3: Author Sandbox with honest runtime boundaries**

Use Docker/Kubernetes provider sources and testing/conformance sources. Keep private `sandboxUnavailable`, `KubePodSpec`, and `PodPhase` out. Label `/testing` Node/test-facing; distinguish portable provider contracts from Docker/Kubernetes behavior and gated integration evidence.

- [ ] **Step 4: Author SQLite Storage from source**

Use checkpointer, saver, threads store, internal DB, migration, and serialization tests. State explicitly that the current public saver/store surface has no close hook; do not invent cleanup ownership.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @dawn-ai/sandbox test
pnpm --filter @dawn-ai/sqlite-storage test
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
pnpm --filter @dawn-ai/cli test -- test/api-reference-compatibility.test.ts
node scripts/check-docs.mjs
git add apps/web/content/docs/api/sandbox.mdx apps/web/app/docs/api/sandbox apps/web/content/docs/api/sqlite-storage.mdx apps/web/app/docs/api/sqlite-storage apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference.test.ts apps/web/app/components/docs/api-reference-inventory.test.ts apps/web/app/components/docs/nav.test.ts packages/cli/test/api-reference-compatibility.test.ts scripts/check-docs.mjs
git commit -m "docs: add sandbox and SQLite APIs"
```

### Task 4: Add LangGraph and LangChain references

**Files:**
- Create: `apps/web/content/docs/api/langgraph.mdx`
- Create: `apps/web/app/docs/api/langgraph/page.tsx`
- Create: `apps/web/content/docs/api/langchain.mdx`
- Create: `apps/web/app/docs/api/langchain/page.tsx`
- Modify: `apps/web/app/components/docs/api-reference.ts`
- Modify: `apps/web/app/components/docs/api-reference.test.ts`
- Modify: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `packages/cli/test/api-reference-compatibility.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Add RED inventories and cross-owner assertions**

Insert LangGraph and LangChain immediately before SQLite Storage so the final PR2 order is Permissions, Workspace, Sandbox, LangGraph, LangChain, SQLite Storage, making the counts 16/74/58. Convert their five records to detailed so the deferred set is empty, but keep the schema value until Task 5's closing mutation. LangGraph root, `/define-entry`, and `/route-module` each own exact rows. `assertExactlyOneEntry` belongs only to `/route-module`; private `ToolRegistry` stays absent. LangChain root owns the 45 barrel exports; `./package.json` is metadata with no TypeScript inventory/runtime/purity.

- [ ] **Step 2: Add compatibility RED cases**

Require all LangGraph subpaths `edge-safe/dependency-free`. Require LangChain root `edge-safe/not-claimed`; reuse the Hono/workerd bundle authorities rather than marking it Node-only.

- [ ] **Step 3: Run focused RED**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
pnpm --filter @dawn-ai/cli test -- test/api-reference-compatibility.test.ts
node scripts/check-docs.mjs
```

Expected: missing LangGraph/LangChain content, wrappers, ownership, and compatibility guards fail; prior pages remain green.

- [ ] **Step 4: Author LangGraph from source**

Use `define-entry.ts`, `route-module.ts`, `langgraph-adapter.ts`, `runtime-context.ts`, and their tests. Link SDK-owned route/runtime aliases to their canonical SDK page and state that reserved route config fields currently have no runtime effect.

- [ ] **Step 5: Author LangChain from source**

Group the large inventory by agent materialization, providers, retry, offloading, summarization, tools/state/subagents, and re-exports. Keep `__resetMaterializedAgentsForTests` discoverable and testing-only. Inline private helper shapes that leak through signatures without pretending the private names are exports. Exclude non-barrel helpers.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @dawn-ai/langgraph test
pnpm --filter @dawn-ai/langchain test
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
pnpm --filter @dawn-ai/cli test -- test/api-reference-compatibility.test.ts test/edge-bundle-purity.test.ts test/fetch-entry-purity.test.ts
node scripts/check-docs.mjs
git add apps/web/content/docs/api/langgraph.mdx apps/web/app/docs/api/langgraph apps/web/content/docs/api/langchain.mdx apps/web/app/docs/api/langchain apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference.test.ts apps/web/app/components/docs/api-reference-inventory.test.ts apps/web/app/components/docs/nav.test.ts packages/cli/test/api-reference-compatibility.test.ts scripts/check-docs.mjs
git commit -m "docs: add graph integration APIs"
```

### Task 5: Complete the catalog, README policy, and discovery contracts

**Files:**
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/app/components/docs/{api-reference.ts,api-reference.test.ts,nav.test.ts,docs-anchors.test.ts,search-index.test.ts,page-actions.test.ts}`
- Modify: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `apps/web/app/api/markdown/[...slug]/route.test.ts`
- Modify: `apps/web/app/{sitemap.test.ts,llms-full.txt/route.test.ts,llms.txt/route.test.ts}`
- Modify: `packages/cli/test/docs-bundle.test.ts`
- Modify: `scripts/lib/docs-api-inventory.mjs`
- Modify READMEs: `packages/{permissions,workspace,sandbox,langgraph,langchain,sqlite-storage,create-dawn-app,config-biome,config-typescript,devkit,inspector,vite-plugin}/README.md`
- Modify: `scripts/check-docs.mjs`
- Create: `.changeset/api-reference-coverage.md`

- [ ] **Step 1: Add RED final-state, catalog, and README assertions**

Require 16 API pages, 74 exhaustive pages, and 58 journey pages. Add a mutation proving `coverage: "deferred-to-pr2"` is rejected by the schema and require zero live deferred records. Require detailed links for the six owner READMEs and catalog anchors for create-app, config-biome, config-typescript, devkit, inspector, and vite-plugin. Require the final hub to classify every import, both binaries, and Inspector's operated application. Require all six new leaves in search/sitemap/Markdown/full-LLM/CLI outputs while compact `llms.txt` stays hub-only.

- [ ] **Step 2: Remove the deferral escape hatch**

Delete `deferred-to-pr2` from the coverage type, analyzer, diagnostics, and tests. Run:

```bash
rg "deferred-to-pr2" apps/web packages scripts
```

Expected: exit 1 with no matches. The approved historical spec and these plan documents are intentionally outside the scan.

- [ ] **Step 3: Complete catalog-only/internal records**

Use these boundaries:

- `bin.create-dawn-ai-app`: catalog-only/tooling/supported, Node-only executable;
- config-biome/config-typescript exports: internal config artifacts, no runtime/purity;
- devkit root: internal Node TypeScript runtime;
- `dawnInspector.server`: catalog-only/tooling/supported, Node operated application;
- vite-plugin root: internal/tooling Node TypeScript runtime.

Do not turn package `files`, LangChain `imports`, or private source modules into artifacts.

- [ ] **Step 4: Update the hub and README destinations**

Add the six nested destinations without disturbing the ordered 112 compatibility IDs. Catalog anchor IDs must use GitHub Slugger forms such as `dawn-aiconfig-biome` and `dawn-aiinspector`. Keep package READMEs concise and policy-driven.

- [ ] **Step 5: Add a patch changeset**

List all twelve README-owning packages: Permissions, Workspace, Sandbox, LangGraph, LangChain, SQLite Storage, create-dawn-ai-app, config-biome, config-typescript, devkit, Inspector, and vite-plugin. Use patch only.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli test -- test/docs-bundle.test.ts test/api-reference-compatibility.test.ts
node scripts/check-docs.mjs
BASE_REF=origin/main node scripts/check-changesets.mjs
git diff --check
git add apps/web/content/docs/api.mdx apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference.test.ts apps/web/app/components/docs/api-reference-inventory.test.ts apps/web/app/components/docs/nav.test.ts apps/web/app/components/docs/docs-anchors.test.ts apps/web/app/components/docs/search-index.test.ts apps/web/app/components/docs/page-actions.test.ts 'apps/web/app/api/markdown/[...slug]/route.test.ts' apps/web/app/sitemap.test.ts apps/web/app/llms-full.txt/route.test.ts apps/web/app/llms.txt/route.test.ts packages/cli/test/docs-bundle.test.ts packages/permissions/README.md packages/workspace/README.md packages/sandbox/README.md packages/langgraph/README.md packages/langchain/README.md packages/sqlite-storage/README.md packages/create-dawn-app/README.md packages/config-biome/README.md packages/config-typescript/README.md packages/devkit/README.md packages/inspector/README.md packages/vite-plugin/README.md scripts/lib/docs-api-inventory.mjs scripts/check-docs.mjs .changeset/api-reference-coverage.md
git commit -m "docs: complete API reference coverage"
```

### Task 6: Full verification, browser QA, review, and merge-on-green

**Files:**
- Modify only if verification exposes a scoped defect.

- [ ] **Step 1: Run focused source and docs suites**

```bash
pnpm --filter @dawn-ai/permissions test
pnpm --filter @dawn-ai/workspace test
pnpm --filter @dawn-ai/sandbox test
pnpm --filter @dawn-ai/langgraph test
pnpm --filter @dawn-ai/langchain test
pnpm --filter @dawn-ai/sqlite-storage test
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli test -- test/docs-bundle.test.ts test/docs-command.test.ts test/api-reference-compatibility.test.ts test/edge-bundle-purity.test.ts test/fetch-entry-purity.test.ts
```

Expected: all non-gated suites pass with count-bearing output; report gated Docker/Kubernetes/database skips explicitly.

- [ ] **Step 2: Run repository gates serially**

```bash
pnpm lint
pnpm check:build-cache
pnpm build
pnpm typecheck
pnpm test
pnpm check:release-inventory
node scripts/check-docs.mjs
BASE_REF=origin/main node scripts/check-changesets.mjs
pnpm --filter @dawn-ai/web build
pnpm ci:validate
git diff --check origin/main...HEAD
```

Expected: every command exits 0.

- [ ] **Step 3: Run browser QA**

Check direct pages and deep anchors for Permissions, Workspace, Sandbox, LangGraph, LangChain, and SQLite Storage; search; Markdown/page actions; breadcrumbs/no prev-next; unchanged sidebar; 390×844 and 1440×1000; and no page-level overflow on LangChain's wide signatures.

- [ ] **Step 4: Request independent spec/source and quality reviews**

Use `superpowers:requesting-code-review`. Fix every confirmed issue test-first with `superpowers:receiving-code-review`, then rerun affected and full gates.

- [ ] **Step 5: Push and open the ready PR**

Push `blove/docs-api-reference-coverage`, open a non-draft PR titled `docs: complete API reference coverage`, and include the PR 1 dependency, source-authority summary, RED/GREEN evidence, changeset, gated-test caveats, and browser QA.

- [ ] **Step 6: Merge only on required green CI**

Watch required checks, address CI/review feedback with the GitHub skills, and merge only after the branch is current, approvals are satisfied, and every required check is green. Confirm the merge on `origin/main` and that the final registry has 16 API leaves, 74 exhaustive pages, 58 journey pages, and no `deferred-to-pr2` outside the historical design spec.
