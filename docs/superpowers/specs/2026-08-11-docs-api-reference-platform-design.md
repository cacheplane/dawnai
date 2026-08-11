# Dawn API Reference Platform Design

**Status:** Proposed
**Primary audience:** Application developers who need exact Dawn package,
subpath, and TypeScript contracts after learning the framework through the
journey documentation

## Goal

Turn Dawn's single 1,884-line API page into a stable reference system: one
complete package catalog, focused authored pages for supported application and
integration APIs, and source-derived checks that fail when package exports and
documented ownership drift apart.

This follows the application-developer journey rebuild. It must improve exact
lookup without turning the journey sidebar into a package catalog or replacing
the conceptual guides with generated TypeScript output.

## Reader outcomes

An application developer should be able to answer these questions without
reading package source:

1. Is this package or subpath intended for application code, integration code,
   tooling, testing, or Dawn internals?
2. Which runtime can import it: Node.js, a web-standard edge target, or tests
   only?
3. What should I install and import?
4. Which public symbols exist, and which page owns each contract?
5. Who owns resources, refresh, shutdown, and cleanup?
6. Where is the conceptual guide or copyable workflow for this API?

## Design decisions

### 1. Use a hybrid catalog and detailed reference

`/docs/api` remains the one visible **API Reference** entry in the 58-page
application journey. It becomes the complete catalog for every publishable
Dawn package and every declared package subpath.

Supported application and integration surfaces receive nested authored pages.
The first delivery migrates the packages already covered by the monolith:

| Canonical page | Owned surface |
|---|---|
| `/docs/api/sdk` | `@dawn-ai/sdk`, `/pure`, and `/testing` |
| `/docs/api/cli` | `@dawn-ai/cli`, `/fetch`, `/runtime`, and `/testing` |
| `/docs/api/core` | `@dawn-ai/core`, `/node`, and the internal compiler classification |
| `/docs/api/ag-ui` | `@dawn-ai/ag-ui` and `/sse` |
| `/docs/api/memory` | `@dawn-ai/memory`, `/browse`, `/namespace`, and `/reconcile` |
| `/docs/api/memory-pgvector` | `@dawn-ai/memory-pgvector` |
| `/docs/api/postgres-storage` | `@dawn-ai/postgres-storage` and `/node` |
| `/docs/api/testing` | `@dawn-ai/testing` |
| `/docs/api/evals` | `@dawn-ai/evals` |
| `/docs/api/generated-routes` | generated `dawn:routes` types |

The coverage-completion delivery adds the supported surfaces that the current
monolith does not reference in depth:

| Canonical page | Owned surface |
|---|---|
| `/docs/api/permissions` | `@dawn-ai/permissions` and `/node` |
| `/docs/api/workspace` | `@dawn-ai/workspace` and `/node` |
| `/docs/api/sandbox` | `@dawn-ai/sandbox` and `/testing` |
| `/docs/api/langgraph` | `@dawn-ai/langgraph`, `/define-entry`, and `/route-module` |
| `/docs/api/langchain` | `@dawn-ai/langchain`; its `package.json` export is classified as package metadata |
| `/docs/api/sqlite-storage` | `@dawn-ai/sqlite-storage` |

The catalog, rather than a nested page, is sufficient for:

- `create-dawn-ai-app`, which is an executable scaffold entrypoint;
- `@dawn-ai/config-biome` and `@dawn-ai/config-typescript`, which publish
  configuration artifacts;
- `@dawn-ai/devkit`, which supports Dawn's own scaffolding;
- `@dawn-ai/inspector`, which is a separately operated application; and
- `@dawn-ai/vite-plugin`, which is type-generation tooling.

Catalog-only does not mean undocumented. Every catalog row states the package
purpose, audience, stability classification, declared subpaths, runtime
boundary, npm README, and the canonical conceptual guide. It means the website
does not pretend an implementation/tooling package is a recommended application
API.

### 2. Keep the visible journey navigation unchanged

The existing `DOCS_NAV` and `DOCS_PAGES` continue to own:

- desktop and mobile navigation;
- the 58-page journey order;
- journey previous/next links; and
- the current-section behavior in the mobile menu.

Reference discovery uses two additional registries:

```ts
DOCS_PAGES            // the existing 58 visible journey pages
API_REFERENCE_PAGES   // nested detailed API pages, not shown in the sidebar
ALL_DOCS_PAGES        // the union consumed by exhaustive discovery surfaces
```

`API_REFERENCE_PAGES` records the visible title, URL, package or generated
surface, classification, source package/subpaths, and parent API hub. A
separate package catalog records every publishable package, including entries
that do not own a detailed page.

`ALL_DOCS_PAGES` inserts the nested API pages after `/docs/api` for exhaustive
consumers while leaving `DOCS_PAGES` byte-for-byte equivalent in membership and
order. Search, sitemap, Markdown discovery, `llms-full.txt`, and the CLI docs
bundle consume the exhaustive registry. Compact `llms.txt` links only the API
hub.

Breadcrumbs for a nested page are:

```text
Docs → Reference → API Reference → @dawn-ai/sandbox
```

Nested reference pages do not receive journey previous/next links. The API hub
is their navigation home.

### 3. Keep the reference authored and use generation only for drift detection

The pages remain MDX written for application developers. Dawn will not generate
prose from declarations or publish raw TypeDoc output.

Each detailed page follows one template:

1. **Use this when** — supported audience, stability classification, and what
   most applications should import instead when the surface is lower-level.
2. **Install and import** — copyable dependency and root/subpath examples.
3. **Compatibility and audience** — independently rendered runtime, purity,
   audience, and stability labels.
4. **Public exports** — a structured visible inventory by package subpath and
   responsibility.
5. **Key contracts** — exact signatures, defaults, errors, and
   ownership/lifecycle rules for the functions and types developers call.
6. **Examples and related guides** — short examples and canonical task docs.

Every export on a supported application or integration surface receives a
name, subpath, and responsibility. High-value functions and public
configuration/data types receive full signatures or field tables. Re-exported
plumbing may be grouped when its owning package has the canonical contract, but
the alias must remain discoverable. Catalog-only and internal/tooling surfaces
receive an explicit classification and boundary instead of a detailed symbol
inventory.

Every full signature and field table also carries a source-derived contract
fingerprint. The TypeScript checker normalizes overloads, parameters, return
types, generic constraints, optionality, and public object fields for the source
export and the authored declaration, then requires them to match. Mutation tests
cover changes that preserve the symbol name but alter each of those type
dimensions. Behavioral defaults, errors, ownership, and lifecycle rules remain
under explicit source-coupled contract tests rather than being inferred from a
type fingerprint.

Package READMEs remain concise npm-facing entrypoints. They contain install and
primary-import snippets, the stability/runtime boundary, and links to the
canonical website reference and conceptual guides. A package that owns a
detailed page links that page; a catalog-only or internal/tooling package links
its API hub catalog anchor. Registry-driven checks enforce the destination for
every publishable package. READMEs do not duplicate the exhaustive symbol
inventory.

### 4. Derive the inventory from public package boundaries

A reusable documentation inventory helper reads each publishable
`packages/*/package.json`, enumerates its declared export subpaths, resolves the
authored TypeScript entry for the relevant condition, and asks the TypeScript
program for the actual exported bindings. It must follow named and wildcard
re-exports rather than using source-text substring checks. It also enumerates
manifest `bin` entries as independent executable artifacts without treating
their command names as TypeScript subpaths, and enumerates Dawn's published
operated-application selector `dawnInspector.server` for
`@dawn-ai/inspector`.

The machine-readable artifact registry has separate records for import subpaths
keyed by `(package, subpath)` and operated artifacts keyed by their manifest
source selector: `(package, bin.<name>)` or
`(package, dawnInspector.server)`. This lets `@dawn-ai/cli` describe its
importable root and `bin:dawn` independently, and lets `@dawn-ai/inspector`
describe its separately launched application despite having neither `exports`
nor `bin`. Each public artifact is classified as `detailed`, `catalog-only`,
`internal`, or temporarily `deferred-to-pr2`. The authored MDX export tables
are parsed into `(package, subpath, symbol)` ownership. Enforcement follows the
classification:

- `detailed` subpaths require exact bidirectional source/documentation symbol
  ownership;
- `catalog-only` and `internal` subpaths require an explicit classification and
  boundary, but not a detailed symbol owner;
- Pull Request 1 may use `deferred-to-pr2` only for the exact Permissions,
  Workspace, Sandbox, LangGraph, LangChain, and SQLite Storage surfaces; any
  addition to that closed allowlist fails; and
- Pull Request 2 removes `deferred-to-pr2` and proves the allowlist is empty.

The docs check then compares source and documentation in both directions:

- a new public package or subpath without a catalog classification fails;
- a new exported binding on a `detailed` subpath without a detailed-page owner
  fails;
- a documented binding removed or renamed in source fails;
- the same `(subpath, symbol)` assigned to multiple pages fails;
- a catalog-only package presented as a recommended application API fails; and
- an internal/tooling subpath missing an explicit classification fails.

The helper treats JSON/config artifacts and executables as catalog entries, not
TypeScript symbol inventories. It intentionally does not descend into
transitive dependencies or private source files that package exports do not
expose.

The generated `dawn:routes` ambient module has no package manifest and therefore
uses a separate source authority and a `generated-types` import-artifact record
with no runtime or purity field. Tests render representative typegen fixtures
both without and with route state, load the generated ambient module through a
TypeScript program, and compare its exports bidirectionally. The stable surface
is `DawnRoutePath`, `DawnRouteParams`, `DawnRouteTools`, and `RouteTools`;
`DawnRouteState` and `RouteState` are conditional on discovered route state.

Mutation tests must prove that comments, imports, non-exported declarations,
string literals, and similarly named private bindings cannot satisfy the
inventory. Separate cases cover named re-exports, wildcard re-exports, default
exports, conditional subpaths, removed subpaths, and wrong entry targets.

### 5. Preserve every existing `/docs/api` deep link

Before moving content, tests snapshot the current ordered API heading IDs. The
current page has 112 IDs, including duplicate-heading suffixes. All remain
valid.

`/docs/api` keeps its title, package index, and reference conventions, followed
by a compact compatibility index in the same heading order. Each former package
or symbol heading becomes a short link to the new canonical nested page and
anchor. New headings that could change GitHub-style duplicate suffixes are not
inserted before the compatibility sequence.

Tests require the old ordered ID list to remain an ordered subset of the hub's
final IDs. Nested pages receive their own canonical symbol anchors. Current
repository-owned links move to the nested page; the hub anchors serve external
compatibility only.

### 6. Make exhaustive discovery use one registry

The following surfaces consume `ALL_DOCS_PAGES` and preserve its order:

- documentation search and its section labels;
- sitemap generation;
- `llms-full.txt`;
- the CLI documentation bundle and README;
- route/content/wrapper topology checks; and
- any test that claims to cover every authored documentation page.

The existing Markdown route continues to resolve a requested file from the
content root, but its tests cover nested API index and leaf paths. Page-action
links such as Copy Markdown and Edit Source must work for the new paths.

The CLI generator's registry loader must select only the named exhaustive
export and validate its runtime shape. Comments, strings, and non-exported
decoys cannot influence generated order. Because this changes publishable CLI
source and bundled docs behavior, the first pull request includes a patch
changeset for `@dawn-ai/cli`.

### 7. Fail closed on topology and classification drift

Compatibility lives in the same machine-readable artifact registry as
documentation ownership, but uses independent fields so labels can overlap and
non-runtime artifacts are not forced into runtime claims. Import records and
operated-artifact records have different address keys and allowed kinds:

- import `surfaceKind`: `typescript-runtime`, `config-artifact`, `metadata`, or
  `generated-types`;
- operated-artifact records use `surfaceKind: executable` for manifest `bin`
  selectors such as `bin:dawn`, or `surfaceKind: operated-application` for
  `dawnInspector.server`;
- `runtime`: `node-only` or `edge-safe`, required only for
  `typescript-runtime`, `executable`, and `operated-application` surfaces and
  absent for config and metadata artifacts and generated types;
- `audience`: `application`, `integration`, `testing`, `tooling`, or `internal`;
- `purity`: `dependency-free` or `not-claimed` for runtime TypeScript surfaces,
  where `dependency-free` means the emitted subpath graph contains no Node
  built-ins, other Dawn packages, or external runtime dependencies; and
- `stability`: the existing supported/low-level/internal boundary used by the
  authored page.

The registry schema rejects runtime or purity values on inapplicable artifact
kinds and rejects a binary or operated application folded into an
import-subpath record. `edge-safe` and `dependency-free` values must be backed
by executable
bundle/dependency guards using the repository's existing purity mechanisms.
The former rejects Node-only built-ins and globals; the latter additionally
requires an empty Dawn-package and external-runtime dependency graph.
`node-only` surfaces require import/type fixtures in Node and negative or
package-condition coverage where applicable.

Audience and stability are semantic policy, not executable properties. Closed
enums, registry-to-page rendering checks, and explicit policy assertions enforce
them—for example, catalog-only/internal surfaces may never be recommended for
application use. Page prose renders every applicable field from this single
registry rather than maintaining unverified free-text classifications.

Structural checks fail on:

- a change to the visible 58-page registry membership or order;
- duplicate package names, page labels, or URLs;
- missing MDX content or route wrappers;
- orphan nested API content/wrappers not registered as API pages;
- a detailed page absent from search, sitemap, Markdown, LLM, or CLI outputs;
- a publishable package absent from the API catalog;
- a declared package subpath absent from its classification;
- a declared package binary absent from its independent executable record;
- the published `dawnInspector.server` selector absent from its independent
  operated-application record;
- a runtime or purity value without its required executable guard;
- an audience or stability label that disagrees with the registry or violates
  its policy assertions;
- a full authored signature or field table whose normalized source fingerprint
  changed;
- a package README whose registry-derived canonical link is absent or wrong;
- source/documented export ownership drift; or
- loss or reordering of a legacy API deep-link ID.

Diagnostics name the package, subpath, symbol, expected owner page, and source
barrel. A large fixture is passed to checker subprocesses over stdin, not one
command-line argument, so Linux CI does not regress to the prior `E2BIG`
failure.

## Verification strategy

Implementation follows test-driven development. Each pull request begins by
adding the structural or content contract and recording the expected red
failure before creating pages or changing consumers.

Focused checks cover:

- API registry membership, ordering, titles, wrappers, and breadcrumbs;
- source-derived export inventory and adversarial mutations;
- exact legacy API anchors and canonical nested anchors;
- search, sitemap, Markdown, `llms.txt`, and `llms-full.txt` output;
- CLI generated topic order, nested paths, and README links;
- copyable imports through TypeScript fixtures for representative package and
  subpath examples; and
- package-specific unit tests for documented lifecycle or error contracts.

Each pull request also runs:

```bash
pnpm lint
pnpm check:build-cache
pnpm build
pnpm typecheck
pnpm test
node scripts/check-docs.mjs
BASE_REF=origin/main node scripts/check-changesets.mjs
pnpm --filter @dawn-ai/web build
pnpm ci:validate
git diff --check origin/main...HEAD
```

Browser QA checks the API hub, representative nested pages, direct deep links,
breadcrumbs, search results, mobile navigation unchanged at 390×844, desktop
navigation unchanged at 1440×1000, Copy Markdown, and absence of horizontal
overflow in signatures and export tables.

## Delivery plan

### Pull request 1: Reference platform and migration

This pull request creates the registries and exhaustive discovery flow, adds the
source-derived inventory guard, rewrites `/docs/api` as the catalog and
compatibility hub, and moves the ten already-documented surfaces to nested
pages. It updates current repository-owned deep links, reconciles the nine
package READMEs that own those detailed pages, and includes the required patch
changeset covering the CLI bundle behavior and canonical README links.

The pull request is complete only when all ten pages, every current API anchor,
all discovery consumers, and the source-derived inventory for those surfaces
are green together. It is opened ready for review and merged automatically only
after required CI succeeds.

### Pull request 2: Coverage completion

This pull request starts from the merged first pull request. It adds detailed
Permissions, Workspace, Sandbox, LangGraph, LangChain, and SQLite Storage pages;
classifies every remaining package/subpath; reconciles the affected package
READMEs for those six owners and the remaining catalog-only/internal packages;
removes the closed `deferred-to-pr2` allowlist; and extends the
inventory contracts to full supported-surface parity. Because package README
changes are user-facing under the repository release policy, it includes a
patch changeset for the affected publishable packages.

It does not expand the visible sidebar, add conceptual tutorials, or document
private implementation modules. It receives its own source-accuracy review,
full validation, ready pull request, and merge-on-green cycle.

## Out of scope

- Adding package pages to the primary journey sidebar.
- Rewriting Configuration, CLI, conceptual, recipe, or deployment guides.
- Generating prose or full TypeScript declarations from source.
- Documenting private modules or transitive third-party APIs.
- Treating tooling/internal packages as recommended application dependencies.
- Runtime behavior or public API changes made only to simplify documentation.
- A new generic documentation generator or TypeDoc adoption.

## Completion criteria

The two-pull-request project is complete when:

- all publishable packages, declared subpaths, package binaries, and the
  published Inspector operated application appear in the API catalog;
- every supported application/integration export has exactly one detailed-page
  owner;
- tooling/internal surfaces are explicitly classified;
- the temporary `deferred-to-pr2` allowlist is empty;
- every applicable runtime and purity value has its required executable
  verification, while audience and stability pass their registry-rendering and
  policy assertions;
- all 112 current API deep-link IDs remain valid;
- the 58-page visible journey registry remains unchanged;
- exhaustive discovery surfaces include nested API pages in deterministic
  order;
- detailed-page owner READMEs point to their canonical page, while catalog-only
  and internal/tooling READMEs point to their API hub catalog anchor, without
  duplicating exhaustive reference content;
- source-derived drift and adversarial mutation tests pass;
- browser QA passes on desktop and mobile; and
- both pull requests pass required CI and merge through their approved
  merge-on-green flow.
