# Dawn API Reference Platform — Pull Request 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic API page with a complete package catalog, ten focused authored reference pages, source-derived drift checks, and exhaustive discovery without changing the 58-page journey navigation.

**Architecture:** `DOCS_PAGES` remains the journey registry. A new `API_REFERENCE_PAGES` registry owns hidden nested reference pages, `ALL_DOCS_PAGES` feeds exhaustive discovery, and a separate artifact registry classifies import subpaths, binaries, the Inspector operated application, and generated `dawn:routes` types. Authored MDX stays canonical for explanation while TypeScript/compiler-backed checks enforce export ownership and exact tagged contracts.

**Tech Stack:** TypeScript 7, Next.js 16, MDX, Vitest, GitHub Slugger, esbuild, pnpm workspaces, Node.js 24, changesets.

**Approved design:** `docs/superpowers/specs/2026-08-11-docs-api-reference-platform-design.md`

---

## File structure

New focused modules:

- `apps/web/app/components/docs/api-reference.ts` — page, 21-package catalog, import-artifact, operated-artifact, and behavior-contract registries plus closed classification schemas.
- `scripts/lib/docs-api-inventory.mjs` — public manifest discovery, TypeScript export enumeration, authored MDX ownership parsing, and tagged contract fingerprints.
- `apps/web/app/components/docs/api-reference.test.ts` — registry, classification, topology, README destination, and compatibility-policy contracts.
- `apps/web/app/components/docs/api-reference-inventory.test.ts` — source/MDX parity and adversarial mutation coverage through one checker subprocess.
- `packages/cli/test/api-reference-compatibility.test.ts` — executable runtime and dependency-graph checks for registry claims.
- Ten `apps/web/content/docs/api/*.mdx` pages and matching `apps/web/app/docs/api/*/page.tsx` wrappers.

Existing files retain their current responsibilities. Do not add the nested pages to `DOCS_NAV`, do not hand-edit ignored `packages/cli/docs/**`, and do not restructure unrelated docs.

All commands run from the repository root with Node 24:

```bash
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node --version # v24.19.0
```

### Task 1: Freeze navigation and legacy API compatibility

**Files:**
- Modify: `apps/web/app/components/docs/docs-anchors.test.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Add the failing topology and anchor assertions**

Pin `DOCS_PAGES` to the existing 58 entries, add the complete ordered 112-ID API baseline, and retain the reorder mutation probe. The baseline must include the suffix-sensitive IDs `agentconfig-1`, `assertidentifiername-value-1`, and `example-1`.

```ts
expect(DOCS_PAGES).toHaveLength(58)
expect(LEGACY_API_HEADING_IDS).toHaveLength(112)
expect(new Set(LEGACY_API_HEADING_IDS).size).toBe(112)
expect(isOrderedSubsequence(LEGACY_API_HEADING_IDS, apiPage.orderedIds)).toBe(true)
```

- [ ] **Step 2: Run the focused tests and record RED**

Run:

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/nav.test.ts app/components/docs/docs-anchors.test.ts
```

Expected: anchor count/order fails against the previous 98-ID snapshot; the 58-page assertion stays green.

- [ ] **Step 3: Replace the snapshot with the exact current 112 IDs**

Generate once with the same GitHub Slugger/MDX heading logic already used by `docs-anchors.test.ts`, paste the ordered literal into the test, and add the same invariant to `scripts/check-docs.mjs`. Do not insert or rename headings in `api.mdx` yet.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2 and `node scripts/check-docs.mjs`.

Expected: both pass; `DOCS_PAGES` is still exactly 58.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/docs/docs-anchors.test.ts apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "test: freeze API reference topology"
```

### Task 2: Add page, package, and artifact registries

**Files:**
- Create: `apps/web/app/components/docs/api-reference.ts`
- Create: `apps/web/app/components/docs/api-reference.test.ts`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Write registry tests first**

Require these exports and relationships:

```ts
export const API_REFERENCE_PAGES = [
  { label: "@dawn-ai/sdk", href: "/docs/api/sdk" },
  { label: "@dawn-ai/cli", href: "/docs/api/cli" },
  { label: "@dawn-ai/core", href: "/docs/api/core" },
  { label: "@dawn-ai/ag-ui", href: "/docs/api/ag-ui" },
  { label: "@dawn-ai/memory", href: "/docs/api/memory" },
  { label: "@dawn-ai/memory-pgvector", href: "/docs/api/memory-pgvector" },
  { label: "@dawn-ai/postgres-storage", href: "/docs/api/postgres-storage" },
  { label: "@dawn-ai/testing", href: "/docs/api/testing" },
  { label: "@dawn-ai/evals", href: "/docs/api/evals" },
  { label: "dawn:routes", href: "/docs/api/generated-routes" },
] as const
```

Tests must prove:

- `DOCS_PAGES` is unchanged at 58;
- `ALL_DOCS_PAGES` is 68 and inserts the ten leaves immediately after `/docs/api`;
- page hrefs, labels, package ownership, and canonical parent are unique;
- import records, `bin.<name>` records, and `dawnInspector.server` records are distinct;
- config/metadata/generated-types omit runtime and purity;
- only runtime TypeScript/executable/operated-application records carry runtime;
- the PR 1 deferred set is exactly the 12 import records for Permissions, Workspace, Sandbox, LangGraph, LangChain, and SQLite Storage; and
- catalog-only/internal records cannot be recommended for application use.
- `PACKAGE_CATALOG` has exactly one row for every package returned by
  `readPublicPackages()`; and
- every catalog row has `packageName`, `purpose`, `readmePath`,
  `canonicalReferenceDestination`, `conceptualGuideDestination`,
  `artifactAddresses`, `audience`, and `stability`,
  with bidirectional package/artifact association.

- [ ] **Step 2: Run the registry tests and record RED**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/nav.test.ts
```

Expected: missing module/exports and 68-page assertions fail.

- [ ] **Step 3: Implement the closed registry types**

Use discriminated records so invalid combinations cannot be authored:

```ts
type ImportKind = "typescript-runtime" | "config-artifact" | "metadata" | "generated-types"
type OperatedKind = "executable" | "operated-application"
type Runtime = "node-only" | "edge-safe"
type Audience = "application" | "integration" | "testing" | "tooling" | "internal"
type Purity = "dependency-free" | "not-claimed"
type Coverage = "detailed" | "catalog-only" | "internal" | "deferred-to-pr2"

interface RuntimeImportArtifact {
  readonly address: { readonly packageName: string; readonly subpath: string }
  readonly surfaceKind: "typescript-runtime"
  readonly runtime: Runtime
  readonly purity: Purity
  readonly audience: Audience
  readonly stability: "supported" | "low-level" | "internal"
  readonly coverage: Coverage
  readonly pageHref?: string
  readonly guardIds: readonly string[]
}
```

Add corresponding non-runtime import and operated-artifact variants. Use conditional spreads rather than explicit `undefined`.

- [ ] **Step 4: Add the complete PR 1 artifact inventory**

Include the detailed PR 1 subpaths, Core `./internal/compiler`, 12 deferred import records, config/devkit/vite catalog records, `bin.dawn`, `bin.create-dawn-ai-app`, and `dawnInspector.server`. Ignore LangChain package `imports` metadata.

- [ ] **Step 5: Add the complete 21-package catalog**

Derive package membership from `readPublicPackages()` in tests. Author concise purpose, README path, separate canonical reference destination and conceptual guide destination, audience, stability, and artifact addresses once in `PACKAGE_CATALOG`; the hub and README checks validate against this source rather than duplicating hand-authored package metadata.

- [ ] **Step 6: Build the exhaustive page union and nested breadcrumbs**

In `nav.ts`, preserve `DOCS_NAV`/`DOCS_PAGES`; import the reference pages and define:

```ts
const apiIndex = DOCS_PAGES.findIndex((page) => page.href === "/docs/api")
export const ALL_DOCS_PAGES = [
  ...DOCS_PAGES.slice(0, apiIndex + 1),
  ...API_REFERENCE_PAGES,
  ...DOCS_PAGES.slice(apiIndex + 1),
] as const
```

Teach `breadcrumbsFor()` to return `Docs → Reference → API Reference → leaf`. Keep `siblingsFor()` on `DOCS_PAGES` so leaves have no journey pagination. At this stage, do not switch eager discovery consumers or add content/wrapper existence checks; the nested files do not exist yet.

- [ ] **Step 7: Verify GREEN and commit**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts app/components/docs/nav.test.ts
node scripts/check-docs.mjs
git add apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference.test.ts apps/web/app/components/docs/nav.ts apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "docs: add API reference registries"
```

### Task 3: Build the isolated source-derived inventory analyzer

**Files:**
- Create: `scripts/lib/docs-api-inventory.mjs`
- Create: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `apps/web/app/components/docs/api-reference.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Define the authored MDX contract format in a failing fixture**

Public export tables use one row per `(package, subpath, symbol)`:

```md
### `@dawn-ai/sdk`

| Export | Responsibility |
|---|---|
| `agent` | Declare an agent route. |
```

Exact authored declarations use tagged fences:

````md
```ts api-contract="@dawn-ai/sdk#.:agent"
export declare function agent<TState = unknown>(config: AgentConfig<TState>): DawnAgent<TState>
```
````

Tests must reject duplicate owners, missing source symbols, undocumented detailed exports, stale documented exports, and a contract fence that does not map to a table owner.

Visible field tables use an exact caption and four-column grammar:

```md
**Fields: `@dawn-ai/sdk#.:AgentConfig`**

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | `KnownModelId` | no | Model used by the route. |
```

The analyzer maps the caption to the source export and fingerprints field name,
normalized type, and required/optional status. Add mutations for all three.
Behavioral prose blocks have a bounded heading and exact normalized claim:

```md
#### Behavior contract `sdk.agent.default-model`

When `model` is omitted, `agent()` uses the source-defined default model.
```

The block runs until the next heading whose numeric level is less than or equal to four (`#` through `####`); level-five and level-six headings remain inside the block. `API_BEHAVIOR_CONTRACTS` maps each ID to one owner page, the exact normalized claim, and a non-empty list of concrete assertions:

```ts
interface BehaviorContract {
  readonly id: string
  readonly ownerHref: string
  readonly claim: string
  readonly authorities: readonly [BehaviorAuthority, ...BehaviorAuthority[]]
}

type BehaviorAuthority =
  | { readonly kind: "source-ast"; readonly file: string; readonly selector: string; readonly expected: string }
  | { readonly kind: "test-assertion"; readonly file: string; readonly testNames: readonly string[]; readonly assertionFingerprint: string }
```

Every authority must pass. For `test-assertion`, parse the named tests with TypeScript and fingerprint their normalized `expect(...)` calls and expected literals. For `source-ast`, serialize the selected declaration/property/branch and compare with `expected`. Tests mutate the claim while keeping the ID, mutate each source/test expectation while keeping the ID/path/test names, and remove one authority from a multi-authority contract; every mutation must fail. A marker or surviving test name alone cannot satisfy the contract.

- [ ] **Step 2: Add adversarial RED cases**

Cover comments, strings, imports, non-exported declarations, private same-name declarations, named/wildcard/default re-exports, conditional targets, removed subpaths, wrong targets, and type changes that preserve the symbol name: overload, generic constraint, parameter, optionality, return type, and object field.

Run:

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference-inventory.test.ts
```

Expected: missing analyzer/helper failures only.

- [ ] **Step 3: Implement manifest and export discovery**

Reuse `readPublicPackages()` from `scripts/lib/published-artifacts.mjs`. Enumerate `exports`, manifest `bin`, and `dawnInspector.server`; resolve TypeScript targets through the package's authored source rather than stale `dist`; treat JSON/config/metadata/operated artifacts as catalog records only. Use the TypeScript checker to follow re-exports.

- [ ] **Step 4: Implement MDX ownership and normalized contract fingerprints**

Parse active headings/tables/fences after masking comments and code examples unrelated to `api-contract`. Normalize source and authored declarations through TypeScript with no truncation, preserving overloads, generics/constraints, parameter optionality, returns, and public object fields. Behavioral prose is not inferred from types.

- [ ] **Step 5: Add one stdin analysis mode without enabling repository-wide enforcement**

Expose a batch analysis mode in `check-docs.mjs`; tests pass isolated fixtures through `spawnSync(..., { input: JSON.stringify(fixtures) })`. Do not put the large fixture in argv. Do not yet replace the monolith checks or scan the repository-wide detailed registry; the ten owner pages do not exist. Diagnostics name package, subpath, symbol, owner page, and barrel.

- [ ] **Step 6: Verify GREEN and commit**

```bash
pnpm build
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference-inventory.test.ts
node scripts/check-docs.mjs
git diff --check
git add scripts/lib/docs-api-inventory.mjs apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference-inventory.test.ts scripts/check-docs.mjs
git commit -m "test: enforce API reference ownership"
```

### Task 4: Verify generated `dawn:routes` contracts

**Files:**
- Modify: `packages/core/test/render-route-types.test.ts`
- Modify: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `scripts/lib/docs-api-inventory.mjs`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Write state/no-state RED fixtures**

Render representative generated declarations and load the ambient module through a TypeScript program. Without route state require exactly:

```ts
type Stable = "DawnRoutePath" | "DawnRouteParams" | "DawnRouteTools" | "RouteTools"
```

With state additionally require `DawnRouteState | RouteState`. A mutation that adds/removes a generated export must fail bidirectionally.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @dawn-ai/core test -- test/render-route-types.test.ts
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference-inventory.test.ts
```

Expected: docs/generated-surface ownership is missing.

- [ ] **Step 3: Add the generated-surface adapter to the inventory helper**

Use `renderDawnTypes`, `renderToolTypes`, and `renderStateTypes`; do not invent a package manifest. Classify the page record as `generated-types` with no runtime/purity.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @dawn-ai/core test -- test/render-route-types.test.ts
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference-inventory.test.ts
node scripts/check-docs.mjs
git add packages/core/test/render-route-types.test.ts apps/web/app/components/docs/api-reference-inventory.test.ts scripts/lib/docs-api-inventory.mjs scripts/check-docs.mjs
git commit -m "test: guard generated route contracts"
```

### Task 5: Add runtime and purity guard coverage

**Files:**
- Create: `packages/cli/test/api-reference-compatibility.test.ts`
- Modify: `apps/web/app/components/docs/api-reference.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Write guard-ID RED tests**

Every `edge-safe`, `dependency-free`, and `node-only` record must name a known guard. Config, metadata, and generated types must reject runtime/purity. Testing is an audience, not a runtime.

- [ ] **Step 2: Implement executable guards**

Reuse bundle/dependency logic from `fetch-entry-purity.test.ts`, `edge-bundle-purity.test.ts`, Permissions entry purity, and Postgres edge bundle tests. `edge-safe` rejects Node built-ins/globals. `dependency-free` additionally rejects other Dawn packages and external runtime dependencies. Node-only records compile/import in Node and have a negative browser/package-condition control when applicable.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @dawn-ai/cli test -- test/api-reference-compatibility.test.ts test/fetch-entry-purity.test.ts test/edge-bundle-purity.test.ts
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference.test.ts
node scripts/check-docs.mjs
git add packages/cli/test/api-reference-compatibility.test.ts apps/web/app/components/docs/api-reference.test.ts scripts/check-docs.mjs
git commit -m "test: verify API runtime classifications"
```

### Task 6: Create foundational detailed pages

**Files:**
- Create: `apps/web/content/docs/api/sdk.mdx`
- Create: `apps/web/content/docs/api/cli.mdx`
- Create: `apps/web/content/docs/api/core.mdx`
- Create: `apps/web/content/docs/api/generated-routes.mdx`
- Create: matching wrappers under `apps/web/app/docs/api/{sdk,cli,core,generated-routes}/page.tsx`
- Modify: `apps/web/app/components/docs/api-reference.ts`
- Modify: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Add missing-page/export RED contracts**

Require exact title/H1/wrapper href, template sections, every root/subpath export, and key source-coupled behavior claims. Core `./internal/compiler` is discoverable but explicitly internal. CLI root, `/fetch`, `/runtime`, `/testing`, and `bin:dawn` are distinct. SDK `/testing` is not the `@dawn-ai/testing` package.

- [ ] **Step 2: Create wrapper skeletons and run RED**

Wrapper pattern:

```tsx
import type { Metadata } from "next"
import Content from "../../../../content/docs/api/sdk.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "@dawn-ai/sdk" }
export default function Page() {
  return <DocsPage href="/docs/api/sdk" Content={Content} />
}
```

Run the inventory, nav, title, Markdown, and page-action tests. Expected: missing MDX contracts fail.

- [ ] **Step 3: Author the four pages from source**

Follow the six-section template. Inventory all exports by subpath; tag high-value exact declarations and field tables; link aliases to canonical owners; and add behavior-contract IDs only for claims proved by these authorities:

- SDK barrels: `packages/sdk/src/index.ts`, `packages/sdk/src/pure/index.ts`, `packages/sdk/src/testing/index.ts`; contracts: `packages/sdk/src/{agent,backend-adapter,errors,known-model-ids,memory,middleware,model-provider,route-config,route-types,runtime-context,runtime-result,validate-model-id,workspace-fs}.ts`; exact tests: `packages/sdk/test/agent-config.contract.ts`, `packages/sdk/test/agent.test.ts`, `packages/sdk/test/memory.test.ts`, `packages/sdk/test/middleware.test.ts`, `packages/sdk/test/runtime-context.contract.ts`, `packages/sdk/test/runtime-context.test.ts`, `packages/sdk/test/tool-context.contract.ts`, `packages/sdk/test/known-model-ids.test.ts`, `packages/sdk/test/validate-model-id.test.ts`, `packages/sdk/test/pure-hash.test.ts`, `packages/sdk/test/pure-path.test.ts`, `packages/sdk/test/scenario-builder.contract.ts`, `packages/sdk/test/scenario-builder.test.ts`, and `packages/sdk/test/scenario-snapshot.test.ts`.
- CLI barrels: `packages/cli/src/{index,fetch-exports,runtime-exports,testing/index}.ts`; lifecycle/storage authorities: `packages/cli/src/lib/dev/{serve-runtime,runtime-fetch-core,runtime-fetch-handler,runtime-server}.ts`, `packages/cli/src/lib/runtime/{static-modules,static-modules-core,execute-route,execute-route-core,stream-types}.ts`; tests: `serve-runtime.test.ts`, `serve-runtime-injection.test.ts`, `runtime-fetch-handler.test.ts`, `runtime-fetch-parity.test.ts`, `request-stores.test.ts`, `static-registry.test.ts`, `static-equivalence.test.ts`, and `runtime-exports.test.ts`.
- Core barrels: `packages/core/src/{index,node,compiler/index}.ts`; authorities: `capabilities/{registry,types,permission-gate,workspace-fs}.ts`, `config.ts`, `config-helper.ts`, `config-node.ts`, discovery/state/tool-scope/typegen sources; tests: matching capability/config/discovery/state/tool-scope/typegen/compiler-boundary suites under `packages/core/test`.
- Generated routes: `packages/core/src/typegen/{render-route-types,render-tool-types,render-state-types}.ts`, `packages/cli/src/lib/typegen/run-typegen.ts`, and their Core/CLI tests.

For every behavior ID, record the exact source/test path and test name in `API_BEHAVIOR_CONTRACTS`; defaults/errors/lifecycle must fail if the named assertion or checked source fact disappears.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @dawn-ai/sdk test
pnpm --filter @dawn-ai/core test
pnpm --filter @dawn-ai/cli test -- test/serve-runtime.test.ts test/runtime-fetch-handler.test.ts test/request-stores.test.ts test/runtime-exports.test.ts
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts 'app/api/markdown/[...slug]/route.test.ts' app/components/docs/page-actions.test.ts
node scripts/check-docs.mjs
git add apps/web/content/docs/api/sdk.mdx apps/web/content/docs/api/cli.mdx apps/web/content/docs/api/core.mdx apps/web/content/docs/api/generated-routes.mdx apps/web/app/docs/api/sdk apps/web/app/docs/api/cli apps/web/app/docs/api/core apps/web/app/docs/api/generated-routes apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference-inventory.test.ts scripts/check-docs.mjs
git commit -m "docs: add foundational API references"
```

### Task 7: Create integration, storage, testing, and eval pages

**Files:**
- Create: `apps/web/content/docs/api/{ag-ui,memory,memory-pgvector,postgres-storage,testing,evals}.mdx`
- Create: matching wrappers under `apps/web/app/docs/api/*/page.tsx`
- Modify: `apps/web/app/components/docs/api-reference.ts`
- Modify: `apps/web/app/components/docs/api-reference-inventory.test.ts`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: Add RED page/export contracts for the remaining six owners**

Require every explicit subpath inventory. Root re-exports do not satisfy `/browse`, `/namespace`, `/reconcile`, `/node`, or `/sse`. Require Testing's currently omitted `fakeEmbedder` and four conformance runners. Require Postgres `/node` wildcard ownership and instance-scoped migration wording.

- [ ] **Step 2: Run focused RED**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
node scripts/check-docs.mjs
```

Expected: the six missing MDX/wrapper inventories and behavior contracts fail; the four Task 6 owners stay green.

- [ ] **Step 3: Author pages from the authoritative barrels and tests**

Use:

- AG-UI: `packages/ag-ui/src/{index,sse,ids,inbound,interrupts,outbound,types}.ts`
- Memory: `packages/memory/src/{index,browse,namespace,reconcile,types}.ts` plus browse/ranking/distill sources
- pgvector: `packages/memory-pgvector/src/{index,pgvector-store,schema,queries,browse-sql}.ts`
- Postgres: `packages/postgres-storage/src/{index,node,options,sql,schema,checkpointer,threads,permissions}.ts`
- Testing: `packages/testing/src/index.ts` and direct re-exports
- Evals: `packages/evals/src/index.ts` and direct re-exports

- [ ] **Step 4: Run package/source checks**

```bash
pnpm --filter @dawn-ai/ag-ui test
pnpm --filter @dawn-ai/memory test
pnpm --filter @dawn-ai/memory-pgvector test
pnpm --filter @dawn-ai/postgres-storage test
pnpm --filter @dawn-ai/testing test
pnpm --filter @dawn-ai/evals test
```

Expected: all available non-gated tests pass; report Docker/Postgres-gated skips rather than claiming them.

- [ ] **Step 5: Verify docs and commit**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/api-reference-inventory.test.ts app/components/docs/nav.test.ts
node scripts/check-docs.mjs
git add apps/web/content/docs/api/ag-ui.mdx apps/web/content/docs/api/memory.mdx apps/web/content/docs/api/memory-pgvector.mdx apps/web/content/docs/api/postgres-storage.mdx apps/web/content/docs/api/testing.mdx apps/web/content/docs/api/evals.mdx apps/web/app/docs/api/ag-ui apps/web/app/docs/api/memory apps/web/app/docs/api/memory-pgvector apps/web/app/docs/api/postgres-storage apps/web/app/docs/api/testing apps/web/app/docs/api/evals apps/web/app/components/docs/api-reference.ts apps/web/app/components/docs/api-reference-inventory.test.ts scripts/check-docs.mjs
git commit -m "docs: add package API references"
```

### Task 8: Enable fail-closed topology and exhaustive discovery

**Files:**
- Modify: `scripts/check-docs.mjs`
- Modify: `apps/web/app/components/docs/{nav.test.ts,api-reference-inventory.test.ts,search-index.ts,search-index.test.ts,page-actions.test.ts}`
- Modify: `apps/web/app/{sitemap.ts,sitemap.test.ts,llms-full.txt/route.ts,llms-full.txt/route.test.ts,llms.txt/route.test.ts}`
- Modify: `apps/web/app/api/markdown/[...slug]/route.test.ts`
- Modify: `packages/cli/src/lib/docs-bundle.ts`
- Modify: `packages/cli/scripts/generate-docs.mjs`
- Modify: `packages/cli/test/{docs-bundle.test.ts,docs-command.test.ts}`

- [ ] **Step 1: Add RED repository-wide ownership and topology tests**

Now that all ten page/wrapper pairs exist, require the detailed registry to match content/wrappers exactly and run the inventory analyzer across every detailed owner. Replace the weak monolith `collectExportedBindings`/`apiSurfaceAuthorities`/`apiSubpathAuthorities` checks. Require every tagged signature, field table, and behavior ID to resolve to its source authority.

- [ ] **Step 2: Add RED tests for all exhaustive consumers**

Require all ten nested pages, in registry order, in search, sitemap, `llms-full.txt`, Markdown routes, page actions, CLI topics, and CLI README. Compact `llms.txt` keeps only `/docs/api`; nested leaves use section label `API Reference`. Add CLI decoys in comments, strings, and non-exported arrays, and require one runtime import of only `ALL_DOCS_PAGES`.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/nav.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/search-index.test.ts app/components/docs/page-actions.test.ts app/sitemap.test.ts app/llms-full.txt/route.test.ts app/llms.txt/route.test.ts 'app/api/markdown/[...slug]/route.test.ts'
pnpm --filter @dawn-ai/cli test -- test/docs-bundle.test.ts test/docs-command.test.ts
node scripts/check-docs.mjs
```

Expected: global analyzer integration, eager consumers, and old CLI loader assumptions fail; no missing-content error occurs because Tasks 6–7 created every leaf.

- [ ] **Step 4: Enable the global checker and exhaustive consumers**

Run the inventory helper against all detailed owners and retain stdin batching for large fixtures. Change search, sitemap, and full LLM output to `ALL_DOCS_PAGES`. Generalize CLI `loadNav`/`parseNav` to `loadDocsPages`/`parseDocsPages`, select only the named `ALL_DOCS_PAGES` export, validate runtime shape, and remove unregistered-file append ordering. Keep Markdown/page-action production code unchanged unless tests expose a real nested-path bug.

- [ ] **Step 5: Verify GREEN and commit**

Run Step 3, then:

```bash
pnpm --filter @dawn-ai/cli build
git status --short --ignored packages/cli/docs
```

Expected: all focused tests and checker pass; generated CLI docs remain ignored.

```bash
git add scripts/check-docs.mjs apps/web/app/components/docs/nav.test.ts apps/web/app/components/docs/api-reference-inventory.test.ts apps/web/app/components/docs/search-index.ts apps/web/app/components/docs/search-index.test.ts apps/web/app/components/docs/page-actions.test.ts apps/web/app/sitemap.ts apps/web/app/sitemap.test.ts apps/web/app/llms-full.txt/route.ts apps/web/app/llms-full.txt/route.test.ts apps/web/app/llms.txt/route.test.ts 'apps/web/app/api/markdown/[...slug]/route.test.ts' packages/cli/src/lib/docs-bundle.ts packages/cli/scripts/generate-docs.mjs packages/cli/test/docs-bundle.test.ts packages/cli/test/docs-command.test.ts
git commit -m "docs: include API leaves in discovery"
```

### Task 9: Rewrite the hub, migrate links, reconcile READMEs, and add the changeset

**Files:**
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/content/docs/{agents,reasoning-effort}.mdx`
- Modify: `apps/web/content/docs/memory/browse.mdx`
- Modify: `apps/web/content/docs/recipes/{add-a-tool,typed-state,dispatch-from-route,retry-flaky-tools}.mdx`
- Modify: `packages/{sdk,cli,core,ag-ui,memory,memory-pgvector,postgres-storage,testing,evals}/README.md`
- Modify: `apps/web/app/components/docs/docs-anchors.test.ts`
- Modify: `scripts/check-docs.mjs`
- Create: `.changeset/api-reference-platform.md`

- [ ] **Step 1: Add RED link, README, and compatibility-stub checks**

Require symbol-specific repository links to use the nested owner. General API discovery links in FAQ, compact `llms.txt`, and nav remain on `/docs/api`. Registry-driven checks require each of the nine owner READMEs to link its detailed page and forbid exhaustive duplicate inventories.

- [ ] **Step 2: Rewrite `/docs/api` without breaking 112 IDs**

Keep the H1 and existing `Package and surface index`/`Reference conventions` headings. Render or validate the complete 21-package catalog from `PACKAGE_CATALOG` inside those sections without adding headings before the compatibility sequence. The checker compares every visible purpose, README, canonical reference, conceptual guide, artifact association, audience, and stability value bidirectionally with the registry. Replace each moved section with a bounded canonical-link compatibility stub in original heading order; preserve suffix-only IDs on the hub even when the nested canonical ID is unsuffixed.

- [ ] **Step 3: Update subject links and nine READMEs**

Move exact symbol links to canonical nested anchors. Keep README content npm-facing: install/primary import, runtime/stability boundary, canonical reference, and conceptual guide. Do not copy the exhaustive page tables.

- [ ] **Step 4: Add the patch changeset**

Use patch entries for `@dawn-ai/cli` and the other eight README-owning packages. Mention exhaustive CLI docs discovery and canonical package references. Never use `minor` on the fixed 0.x train.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/docs-anchors.test.ts app/components/docs/nav.test.ts app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts
node scripts/check-docs.mjs
BASE_REF=origin/main node scripts/check-changesets.mjs
git diff --check
git add apps/web/content/docs/api.mdx apps/web/content/docs/agents.mdx apps/web/content/docs/reasoning-effort.mdx apps/web/content/docs/memory/browse.mdx apps/web/content/docs/recipes/add-a-tool.mdx apps/web/content/docs/recipes/typed-state.mdx apps/web/content/docs/recipes/dispatch-from-route.mdx apps/web/content/docs/recipes/retry-flaky-tools.mdx packages/sdk/README.md packages/cli/README.md packages/core/README.md packages/ag-ui/README.md packages/memory/README.md packages/memory-pgvector/README.md packages/postgres-storage/README.md packages/testing/README.md packages/evals/README.md apps/web/app/components/docs/docs-anchors.test.ts .changeset/api-reference-platform.md scripts/check-docs.mjs
git commit -m "docs: publish the API reference platform"
```

### Task 10: Full verification, browser QA, review, and merge-on-green

**Files:**
- Modify only if verification exposes a scoped defect.

- [ ] **Step 1: Run fresh focused verification**

```bash
pnpm --filter @dawn-ai/web test -- app/components/docs/nav.test.ts app/components/docs/api-reference.test.ts app/components/docs/api-reference-inventory.test.ts app/components/docs/search-index.test.ts app/components/docs/docs-anchors.test.ts app/components/docs/page-actions.test.ts 'app/api/markdown/[...slug]/route.test.ts' app/llms-full.txt/route.test.ts app/llms.txt/route.test.ts app/sitemap.test.ts
pnpm --filter @dawn-ai/core test -- test/render-route-types.test.ts
pnpm --filter @dawn-ai/cli test -- test/docs-bundle.test.ts test/docs-command.test.ts test/api-reference-compatibility.test.ts
```

Expected: all focused tests pass with count-bearing output.

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

Expected: every command exits 0. If a monolithic runner is cut off without a summary, split it into disjoint count-bearing shards; do not claim an unobserved pass.

- [ ] **Step 3: Run browser QA**

Use the browser skill against the local production build. Check `/docs/api`, `/docs/api/sdk`, `/docs/api/memory`, `/docs/api/generated-routes`, one old deep link, search, Copy Markdown, Edit Source, breadcrumbs, no prev/next, unchanged sidebar, 390×844 mobile, 1440×1000 desktop, and no page-level horizontal overflow.

- [ ] **Step 4: Request two-stage review and fix findings test-first**

Use `superpowers:requesting-code-review`: one spec/source-accuracy reviewer and one code-quality/checker reviewer. Apply `superpowers:receiving-code-review` to each finding, add a failing regression, fix, and rerun affected plus full gates.

- [ ] **Step 5: Push and open the ready PR**

Push `blove/docs-api-reference-platform`, open a non-draft PR titled `docs: build the API reference platform`, and include design/plan links, scope, RED/GREEN evidence, gated-test caveats, and browser QA.

- [ ] **Step 6: Merge only after required checks are green**

Watch required GitHub checks. Address failures with `github:gh-fix-ci`; address review threads with `github:gh-address-comments`. When the branch is current, approvals are satisfied, and all required checks pass, merge using the repository's allowed method and confirm `origin/main` contains the PR commit before starting Pull Request 2.
