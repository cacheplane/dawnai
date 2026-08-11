# Dawn Application-Developer Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize Dawn's documentation around the application-developer journey, add the missing production guides, split the largest mixed-purpose journey pages, and preserve every existing page URL and important deep link.

**Architecture:** Keep the current flat `DOCS_NAV` data model as the one ordered page registry, but regroup it into eight task-oriented sections and collapse those sections in the mobile presentation. Land every complete MDX page, App Router wrapper, navigation entry, accuracy guard, and discovery update atomically in its owning slice; retain compatibility headings at old non-API anchors and keep API Reference monolithic for this pull request. Start with green structural characterization, use red/green tests inside each slice, and finish with full Node 24 and browser verification.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 7, MDX, Vitest, Node.js 24, pnpm, repository documentation and build-cache checks.

---

## Required skills and working rules

- Use `@superpowers:test-driven-development` for Tasks 1 and 2 and for every later correction that changes a checker or UI behavior.
- Use `@superpowers:requesting-code-review` after each content slice. Review against the implementation authorities in the source ledger, not merely against the old prose being moved.
- Use `@superpowers:verification-before-completion` before every commit and before the final completion claim.
- Use `@browser:control-in-app-browser` for Task 12's visual and interaction review. If that browser is unavailable, stop and request explicit permission before substituting another browser surface.
- Run every command from `/Users/blove/repos/dawn/.worktrees/docs-app-developer-journey` with the installed Node 24 toolchain active, and verify it before each long lane:

```bash
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node --version
pnpm --version
```

Expected: Node `v24.19.0` and pnpm `10.33.0`.

- Do not alter runtime/package behavior to make documentation claims true. Narrow the docs and record a follow-up when the implementation has a limitation.
- Do not remove or rename an existing docs path. Do not remove a moved heading until its original path still exposes the same anchor as a concise compatibility section.
- Do not link to a future page before its owning slice registers the complete
  MDX and wrapper. Link the stable overview temporarily, then repoint that
  inbound link in the later atomic slice.
- Keep `DOCS_NAV` entries as same-line literals with `label` before `href`; `packages/cli/src/lib/docs-bundle.ts` parses that representation.
- Use gpt-5-family models in examples, with `gpt-5-mini` as the default.
- Do not run a bare `biome check --write`.

## File map

### Structural and shell changes

| Responsibility | Files |
|---|---|
| Journey contract and CI coverage | `scripts/check-docs.mjs`, `apps/web/package.json`, `apps/web/app/components/docs/nav.test.ts`, `apps/web/app/components/docs/docs-anchors.test.ts` |
| Navigation registry and helpers | `apps/web/app/components/docs/nav.ts`, `apps/web/app/components/docs/search-index.ts` |
| Discovery parity | `apps/web/app/components/docs/search-index.test.ts`, `apps/web/app/sitemap.test.ts`, `apps/web/app/llms.txt/route.test.ts`, `apps/web/app/llms-full.txt/route.test.ts`, `packages/cli/test/docs-bundle.test.ts`, `packages/cli/test/docs-command.test.ts`, `turbo.json` |
| Mobile section presentation | `apps/web/app/components/docs/MobileDocsNav.tsx`, `apps/web/app/components/docs/mobile-docs-nav.test.ts`, `apps/web/app/components/MobileMenu.tsx` |
| Docs entry and responsive prose | `apps/web/app/docs/page.tsx`, `apps/web/app/docs/page.test.ts`, `apps/web/app/globals.css`, `apps/web/app/components/docs/inline-code-responsive.test.ts` |
| Copy/edit page actions | `apps/web/app/components/docs/page-actions.ts`, `apps/web/app/components/docs/page-actions.test.ts`, `apps/web/app/components/docs/PageActions.tsx`, `apps/web/app/api/markdown/[...slug]/route.ts`, `apps/web/app/api/markdown/[...slug]/route.test.ts` |

### New content and wrappers

| Area | MDX content | App Router wrappers |
|---|---|---|
| Operate | `apps/web/content/docs/persistence.mdx`, `production-topology.mdx`, `security-architecture.mdx`, `memory/browse.mdx` | matching `apps/web/app/docs/{persistence,production-topology,security-architecture}/page.tsx` and `apps/web/app/docs/memory/browse/page.tsx` |
| Integrate | `apps/web/content/docs/embedding.mdx`, `dev-server/agent-protocol.mdx` | `apps/web/app/docs/embedding/page.tsx`, `apps/web/app/docs/dev-server/agent-protocol/page.tsx` |
| Deploy | `apps/web/content/docs/deployment/{node,kubernetes,langsmith,edge}.mdx`, `sandbox/kubernetes.mdx` | matching nested `apps/web/app/docs/deployment/*/page.tsx` and `apps/web/app/docs/sandbox/kubernetes/page.tsx` |
| Build | `apps/web/content/docs/memory/{long-term,retrieval,episodes,distillation}.mdx` | matching nested `apps/web/app/docs/memory/*/page.tsx` |
| Test | `apps/web/content/docs/testing-agents/fixtures.mdx` | `apps/web/app/docs/testing-agents/fixtures/page.tsx` |

Every wrapper follows the existing `DocsPage` pattern. For example:

```tsx
import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/node.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Node and Docker" }

export default function Page() {
  return <DocsPage href="/docs/deployment/node" Content={Content} />
}
```

Root-level wrappers use `../../../content/docs/<slug>.mdx` and
`../../components/docs/DocsPage`; nested wrappers use the four- and three-level
paths shown above. Only `/docs/deployment` retains `promptSlug="deploy"`.

### Existing pages that are split or narrowed

| Canonical role after this change | Existing files |
|---|---|
| Deployment chooser and target compatibility stubs | `apps/web/content/docs/deployment.mdx`, `apps/web/app/docs/deployment/page.tsx` |
| Local development overview and protocol compatibility stubs | `apps/web/content/docs/dev-server.mdx` |
| Portable sandbox overview and Kubernetes compatibility stubs | `apps/web/content/docs/sandbox.mdx` |
| Three-mechanism memory chooser and moved-topic compatibility stubs | `apps/web/content/docs/memory.mdx` |
| First harness test and fixture compatibility stubs | `apps/web/content/docs/testing-agents.mdx`, `apps/web/app/docs/testing-agents/page.tsx` |
| Complete schema with concise operational links | `apps/web/content/docs/configuration.mdx`, `apps/web/app/docs/configuration/page.tsx` |
| Monolithic exact reference with less tutorial duplication | `apps/web/content/docs/api.mdx` |
| Inner versus outer control ownership | `apps/web/content/docs/access-control.mdx`, `apps/web/content/docs/middleware.mdx` |

### Navigation-title and discovery reconciliation

The final reconciliation changes only labels, headings, metadata, or links in:

- `apps/web/content/docs/{ag-ui,cli,context-management,errors,evals,faq,getting-started,inspector,mental-model,observability,retry,routes,state,testing,tools,upgrading,workspace}.mdx`
- `apps/web/content/docs/recipes/{index,add-a-tool,auth-middleware,dispatch-from-route,research-web-ui,retry-flaky-tools,stream-output,typed-state}.mdx`
- corresponding wrappers under `apps/web/app/docs/`
- `scripts/generate-error-docs.mjs`, which owns the generated
  `apps/web/content/docs/errors.mdx` heading
- `apps/web/app/llms.txt/route.ts`
- package/example references found by the focused legacy-link scan in Task 11, including `packages/{memory,memory-pgvector,testing}/README.md` and `examples/memory/README.md`
- `charts/dawn-app/README.md` and its canonical-link/probe comments in
  `charts/dawn-app/values.yaml`

Historical blog posts, landing-page marketing copy, generated package `dist/`,
and publishable package source are not edited.

## Source-of-truth ledger

| Contract | Implementation/test authority |
|---|---|
| Nav literal parser and generated docs order | `packages/cli/src/lib/docs-bundle.ts`, `packages/cli/test/docs-bundle.test.ts`, `packages/cli/scripts/generate-docs.mjs` |
| Search, sitemap, full LLM output, breadcrumbs, pagination | `apps/web/app/components/docs/{search-index,nav}.ts`, `apps/web/app/sitemap.ts`, `apps/web/app/llms-full.txt/route.ts` |
| Runtime endpoints, middleware coverage, health, cancellation | `packages/cli/src/lib/dev/runtime-fetch-core.ts`, `runtime-server.ts`, `run-registry.ts`, `agui-handler.ts`; cancellation/heartbeat tests |
| Node target, generated server, Dockerfile, signal behavior | `packages/cli/src/lib/build/targets/node.ts`, `packages/cli/src/lib/dev/serve-runtime.ts`, `packages/cli/src/commands/start.ts` |
| LangSmith and Hono target boundaries | `packages/cli/src/lib/build/targets/{langsmith,hono,edge-capabilities}.ts`, `deployment-config.ts`, target tests |
| Runtime embedding public surfaces | `packages/cli/src/index.ts`, `fetch-exports.ts`, `runtime-exports.ts`, `runtime-server.ts`, `runtime-fetch-core.ts` |
| Checkpoints, threads, permissions, deletion, teardown | `packages/postgres-storage/src/**`, `packages/sqlite-storage/src/**`, `runtime-fetch-core.ts`, `packages/postgres-storage/README.md` |
| Memory mechanism discovery | `packages/core/src/capabilities/built-in/{agents-md,memory-md,memory}.ts` and capability tests |
| Agent recall versus administrative browse | `packages/memory/src/{types,browse,browse-validate,browse-order,browse-cursor,browse-range,sqlite-store,sqlite-browse-sql}.ts`, `packages/memory-pgvector/src/**`, and `packages/testing/src/memory-conformance.ts` |
| Episodes and distillation | `packages/core/src/capabilities/built-in/memory.ts`, `packages/memory/src/distill.ts`, `packages/cli/src/lib/memory/distill.ts`, and episodic/distillation tests |
| Sandbox providers and Kubernetes enforcement | `packages/sandbox/src/**`, `charts/dawn-sandbox-infra/**`, Docker/Kubernetes sandbox tests |
| Test harness fixtures and live/replay boundary | `packages/testing/src/{harness,fixture-builder,fixture-file,record,record-fixtures}.ts`, harness/fixture tests |

## Final navigation contract

This is the exact end state. Task 2 installs its eight-section foundation using
the 42 existing pages. Tasks 3–8 add their complete pages, wrappers, nav rows,
accuracy guards, and discovery coverage atomically; Task 11 verifies this final
58-page structure without introducing another navigation migration:

```ts
const EXPECTED_DOCS_NAV = [
  ["Get Started", [
    ["Getting Started", "/docs/getting-started"],
    ["Mental Model", "/docs/mental-model"],
    ["Migrating from LangGraph", "/docs/migrating-from-langgraph"],
  ]],
  ["Build", [
    ["Routes", "/docs/routes"],
    ["Agents", "/docs/agents"],
    ["Tools", "/docs/tools"],
    ["State", "/docs/state"],
    ["Workspace Filesystem", "/docs/workspace"],
    ["Memory", "/docs/memory"],
    ["Long-term Memory", "/docs/memory/long-term"],
    ["Recall and Retrieval", "/docs/memory/retrieval"],
    ["Episodes", "/docs/memory/episodes"],
    ["Distillation", "/docs/memory/distillation"],
    ["Planning", "/docs/planning"],
    ["Skills", "/docs/skills"],
    ["Subagents", "/docs/subagents"],
    ["Context Management", "/docs/context-management"],
    ["Reasoning Effort", "/docs/reasoning-effort"],
  ]],
  ["Integrate", [
    ["Dev Server", "/docs/dev-server"],
    ["Agent Protocol", "/docs/dev-server/agent-protocol"],
    ["Middleware", "/docs/middleware"],
    ["AG-UI and Web Clients", "/docs/ag-ui"],
    ["Embed the Runtime", "/docs/embedding"],
    ["Blueprints", "/docs/blueprints"],
  ]],
  ["Test", [
    ["Scenario Testing", "/docs/testing"],
    ["Agent Test Harness", "/docs/testing-agents"],
    ["Fixtures and Recording", "/docs/testing-agents/fixtures"],
    ["Evals", "/docs/evals"],
  ]],
  ["Operate", [
    ["Persistence and Tenancy", "/docs/persistence"],
    ["Production Topology", "/docs/production-topology"],
    ["Security Architecture", "/docs/security-architecture"],
    ["Access Control", "/docs/access-control"],
    ["Permissions", "/docs/permissions"],
    ["Retry", "/docs/retry"],
    ["Observability", "/docs/observability"],
    ["Inspector", "/docs/inspector"],
    ["Browse and Manage Memory", "/docs/memory/browse"],
    ["Upgrading", "/docs/upgrading"],
  ]],
  ["Deploy", [
    ["Deployment Options", "/docs/deployment"],
    ["Node and Docker", "/docs/deployment/node"],
    ["Kubernetes", "/docs/deployment/kubernetes"],
    ["LangSmith", "/docs/deployment/langsmith"],
    ["Edge and Hono", "/docs/deployment/edge"],
    ["Execution Sandbox", "/docs/sandbox"],
    ["Kubernetes Sandbox", "/docs/sandbox/kubernetes"],
  ]],
  ["Recipes", [
    ["Recipes Overview", "/docs/recipes"],
    ["Add a Tool", "/docs/recipes/add-a-tool"],
    ["Typed State", "/docs/recipes/typed-state"],
    ["Auth Middleware", "/docs/recipes/auth-middleware"],
    ["Stream Output", "/docs/recipes/stream-output"],
    ["Retry Transient Model Calls", "/docs/recipes/retry-flaky-tools"],
    ["Dispatch from a Route", "/docs/recipes/dispatch-from-route"],
    ["Research Assistant Web UI", "/docs/recipes/research-web-ui"],
  ]],
  ["Reference", [
    ["Configuration Reference", "/docs/configuration"],
    ["CLI Reference", "/docs/cli"],
    ["API Reference", "/docs/api"],
    ["Error Codes", "/docs/errors"],
    ["FAQ", "/docs/faq"],
  ]],
] as const
```

### Task 1: Characterize topology and discovery on the current green tree

**Files:**
- Create: `apps/web/app/components/docs/nav.test.ts`
- Create: `apps/web/app/components/docs/search-index.test.ts`
- Create: `apps/web/app/sitemap.test.ts`
- Create: `apps/web/app/llms-full.txt/route.test.ts`
- Modify: `apps/web/app/components/docs/docs-anchors.test.ts`
- Modify: `apps/web/package.json`
- Modify: `scripts/check-docs.mjs`
- Modify: `packages/cli/test/docs-bundle.test.ts`
- Modify: `turbo.json`
- Test: `apps/web/app/components/docs/nav.test.ts`

- [x] **Step 1: Confirm the current documentation baseline is green**

Run:

```bash
pnpm build
node scripts/check-docs.mjs
pnpm --filter @dawn-ai/web exec vitest run
```

Expected: all three commands pass before the new contract is added. The build is
required because `check-docs.mjs` imports package `dist/` output.

- [x] **Step 2: Put existing web tests in the normal repository test lane**

Add this script to `apps/web/package.json` without changing dependencies:

```json
"test": "vitest --run --config vitest.config.ts"
```

Run:

```bash
pnpm --filter @dawn-ai/web test
```

Expected: PASS on the pre-existing web tests.

- [x] **Step 3: Write green structural navigation coverage**

Create `nav.test.ts`. Import `DOCS_NAV`, `DOCS_PAGES`, `breadcrumbsFor`, and
`siblingsFor`. Add these characterization assertions without yet requiring the
future eight-section order or title normalization:

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { breadcrumbsFor, DOCS_NAV, DOCS_PAGES, siblingsFor } from "./nav"

describe("documentation registry invariants", () => {
  it("uses unique section labels, page labels, and hrefs", () => {
    const sectionLabels = DOCS_NAV.map((section) => section.label)
    const pageLabels = DOCS_PAGES.map((page) => page.label)
    const hrefs = DOCS_PAGES.map((page) => page.href)
    expect(new Set(sectionLabels).size).toBe(sectionLabels.length)
    expect(new Set(pageLabels).size).toBe(pageLabels.length)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("derives breadcrumbs and siblings from the registered order", () => {
    expect(breadcrumbsFor("/docs/ag-ui")).toEqual([
      { label: "Docs", href: "/docs/getting-started" },
      { label: "Tooling" },
      { label: "AG-UI & Web Clients" },
    ])
    expect(siblingsFor("/docs/ag-ui").prev?.href).toBe("/docs/dev-server")
    expect(siblingsFor("/docs/ag-ui").next?.href).toBe("/docs/blueprints")
    expect(siblingsFor("/docs/faq").next).toBeNull()
  })
})
```

Read `nav.ts` and require every item literal to remain on one line with `label`
before `href`. Recursively map current MDX and wrappers, using
`recipes/index.mdx` for `/docs/recipes`, and require the nav/content/wrapper
route sets to match. Title equality is deliberately introduced red-first in
Task 2, where the titles are normalized in the same green commit.

- [x] **Step 4: Strengthen the CI topology check in both directions**

In `scripts/check-docs.mjs`:

1. Report duplicate nav hrefs instead of silently deduplicating them.
2. Recursively enumerate `apps/web/content/docs/**/*.mdx`, map
   `recipes/index.mdx` to `/docs/recipes`, and fail when a content page is not in
   nav.
3. Recursively enumerate `apps/web/app/docs/**/page.tsx`, excluding the new
   `/docs/page.tsx` redirect, and fail when a wrapper is not in nav.
4. Require the nav, authored-content, and wrapper route sets to be identical.

Update the checker's nearby comment to describe those structural checks
honestly; do not claim it validates arbitrary internal links. Real MDX path and
fragment validation belongs to `docs-anchors.test.ts`.

Use an existence guard before reading any accuracy-contract file so a future
slice reports a missing page rather than throwing while its red test is being
written:

```js
for (const contract of accuracyContracts) {
  const filePath = resolve(repoRoot, contract.file)
  if (!existsSync(filePath)) {
    failures.push(`${contract.file} is missing`)
    continue
  }
  const source = readFileSync(filePath, "utf8")
  // existing required/forbidden loops
}
```

Add a reusable `compatibilityStubContracts` checker that accepts an overview
file, retained heading text, canonical href, and `maxChars` (default 600). It
must extract from that heading to the next heading of the same or higher level,
require the canonical link, and fail when the stub grows beyond the cap. Do not
register rows yet; Tasks 4–9 add them with their moved headings so duplicated
canonical prose cannot creep back into overview pages.

- [x] **Step 5: Characterize every registry-driven discovery surface**

Add green tests for the current 42-page registry:

- `search-index.test.ts`: exactly one entry per nav item, in nav order, with the
  same href and section. Title equality waits for Task 2's rename slice.
- `sitemap.test.ts`: docs URLs equal `DOCS_PAGES` exactly and in order; no
  redirect-only `/docs` canonical URL.
- `llms-full.txt/route.test.ts`: every nav page occurs exactly once and in nav
  order, including `recipes/index.mdx` and a nested recipe.
- `packages/cli/test/docs-bundle.test.ts`: extend parser fixtures with a nested
  slug, read the real nav, build generated docs, and require one topic/file per
  current nav entry in order.
- `docs-anchors.test.ts`: collect every repository-owned `/docs` link, not only
  links with fragments; require the target route to exist and, when supplied,
  the target heading to exist. Exclude external URLs and historical blogs.

Add `$TURBO_ROOT$/apps/web/app/components/docs/nav.ts` to the CLI test task's
inputs in `turbo.json` because the integration test reads it. Build before
checking the ignored generated bundle:

```bash
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/web exec vitest --run --config vitest.config.ts \
  app/components/docs/nav.test.ts \
  app/components/docs/search-index.test.ts \
  app/components/docs/docs-anchors.test.ts \
  app/sitemap.test.ts \
  app/llms-full.txt/route.test.ts
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
```

Expected: PASS against the current tree. `packages/cli/docs` is ignored output
and must not be staged.

- [x] **Step 6: Record the accuracy-guard allocation without registering future files**

Do not add a contract for a page that does not exist yet. The table below is the
allocation ledger for Tasks 3–10: each owning task first adds its rows red, then
adds the page/overview edits and commits only after the checker is green. The
fragments are deliberately specific enough to prevent dangerous regressions
while leaving prose editing room:

| File | Required fragments | Forbidden fragments |
|---|---|---|
| `persistence.mdx` | `checkpoints`, `thread metadata`, `permission`, `long-term memory`, `workspace files`, `sandbox volumes`, `does not automatically`, `retention`, `backup`, `encryption` | `thread deletion removes all` |
| `production-topology.mdx` | `process-local`, `shared durable stores`, `thread-aware`, `/healthz`, `does not prove`, `does not currently install signal handlers` | `HPA makes`, `generated server handles graceful termination`, `graceful termination is automatic` |
| `security-architecture.mdx` | `outer authentication`, `tenant`, `/threads/:thread_id/cancel`, `/memory/candidates`, `bypass`, `authored tools`, `build artifact` | `middleware protects every`, `thread ID is an authorization` |
| `embedding.mdx` | `serveRuntime`, `@dawn-ai/cli/fetch`, `@dawn-ai/cli/runtime`, `lower-level tooling surface`, `app.route("/", dawnApp)`, `"/my-app"`, `/healthz`, `/threads`, `/agui`, `/memory`, `close()` | `from "@dawn-ai/cli/runtime"`, `app.mount(`, `app.route("/dawn"` |
| `deployment/node.mdx` | `Node 24`, `.dawn/build/server.mjs`, `127.0.0.1:8000:8000`, `does not currently install signal handlers` | `Node 22` |
| `deployment/kubernetes.mdx` | `liveness`, `not dependency readiness`, `dawn-sandboxes`, `dawn-orchestrator`, `shared durable stores`, `thread-aware` | `/healthz proves dependency readiness`, `HPA makes` |
| `deployment/langsmith.mdx` | `node_version: "22"`, `Node 24`, `does not include`, `middleware`, `AG-UI`, `sandbox` | `same runtime` |
| `deployment/edge.mdx` | `modules.edge.mjs`, `"/my-app"`, `app.route`, `DAWN_E1005`, `local workerd`, `not a live` | `Nothing else is gated` |
| `sandbox/kubernetes.mdx` | `DNS`, `CNI`, `dawn-sandboxes`, `dawn-orchestrator`, `NetworkPolicy`, `not zero egress` | `provides zero egress`, `guarantees zero egress` |
| `dev-server/agent-protocol.mdx` | `POST /threads/:thread_id/cancel`, `GET /memory/candidates`, `POST /memory/candidates/:id/approve`, `POST /memory/candidates/:id/reject`, `: ping` | use the fixed-count regex described below |
| `memory/long-term.mdx` | `defineMemory`, `candidate`, `resolveScope`, `seedMemory`, `procedural`, `not yet wired` | `verified identity is passed to resolveScope` |
| `memory/retrieval.mdx` | `MemoryStore.search`, `MemoryStore.browse`, `keyword`, `semantic`, `approximate`, `evaluation timestamp` | `returns identical ordering`, `byte-identical` |
| `memory/episodes.mdx` | `enabled: false`, `includeFailedRuns`, `TTL`, `cap`, `without embeddings`, `agent-authored` | `episodes are embedded automatically` |
| `memory/browse.mdx` | `MemoryStore.browse`, `@dawn-ai/memory/browse`, `query fingerprint`, `one \`now\``, `transaction snapshot`, `empty final page`, `outer authentication`, `does not use semantic ranking` | `browse uses semantic ranking` |
| `memory/distillation.mdx` | `explicitly`, `consolidate`, `reflect`, `Nothing runs automatically` | `candidate review is distillation` |
| `testing-agents/fixtures.mdx` | `author`, `record`, `replay`, `live`, `never run live in CI` | `tests never call a live model` |
| `memory.mdx` | `workspace/AGENTS.md`, `memory.md`, `memory.ts`, `State is`, `/docs/workspace`, `/docs/memory/long-term`, `/docs/memory/retrieval`, `/docs/memory/episodes`, `/docs/memory/distillation` | `State is a memory mechanism` |
| `deployment.mdx` | `/docs/deployment/node`, `/docs/deployment/kubernetes`, `/docs/deployment/langsmith`, `/docs/deployment/edge`, `Specifying build targets replaces` | `backend that does not exist yet` |
| `dev-server.mdx` | `parent watcher/session`, `child owns the HTTP listener`, `default SQLite`, `/docs/dev-server/agent-protocol`, `/docs/ag-ui` | `parent owns the HTTP server` |
| `sandbox.mdx` | `/docs/sandbox/kubernetes`, `/docs/deployment/kubernetes`, `preflight().warnings` | `backend that does not exist yet` |
| `configuration.mdx` | `# Configuration Reference`, `/docs/persistence`, `/docs/production-topology`, `/docs/memory/long-term`, `/docs/deployment`, `/docs/sandbox` | `dawn start loads` |
| `api.mdx` | `## @dawn-ai/cli`, `### @dawn-ai/cli/fetch`, `## @dawn-ai/memory`, `### @dawn-ai/memory/browse`, `lower-level tooling` | `@dawn-ai/cli/runtime is the application embedding` |

Task 4 moves the existing Deployment accuracy row; Task 6 splits the existing
Dev Server row and endpoint probe. AG-UI-specific encoding/resume checks move to
`ag-ui.mdx` in Task 6.

Tasks 4–9 also register every compatibility heading listed in their outlines
with the canonical page and the 600-character default. A task may use a smaller
cap for a one-line stub, but never a larger cap merely to preserve copied detail.

Add a file-specific forbidden regex for Agent Protocol prose:

```js
/\b\d+\s+(?:HTTP\s+)?endpoints\b/i
```

This prevents a stale count while allowing the page to enumerate the actual
route table. Move the top-level `/agui/{routeId}` and `@dawn-ai/ag-ui`
requirements from `dev-server.mdx` to `ag-ui.mdx`. Split the old Dev Server
contract so only watcher/restart facts remain on the overview; endpoint,
cancellation, candidate-management, and auth facts belong to Agent Protocol.

- [x] **Step 7: Verify the reusable structural contract remains green**

Run:

```bash
pnpm --filter @dawn-ai/web exec vitest --run --config vitest.config.ts \
  app/components/docs/nav.test.ts
node scripts/check-docs.mjs
```

Expected: PASS. This commit adds reusable topology checks only; it does not
register unfinished pages, change the current order, or create an intentionally
red normal test lane.

- [x] **Step 8: Commit the green structural contract**

```bash
git add apps/web/package.json apps/web/app/components/docs/nav.test.ts \
  apps/web/app/components/docs/search-index.test.ts \
  apps/web/app/components/docs/docs-anchors.test.ts \
  apps/web/app/sitemap.test.ts apps/web/app/llms-full.txt/route.test.ts \
  packages/cli/test/docs-bundle.test.ts scripts/check-docs.mjs turbo.json
git commit -m "test(docs): lock documentation topology"
```

### Task 2: Improve the docs shell before adding pages

**Files:**
- Create: `apps/web/app/components/docs/MobileDocsNav.tsx`
- Create: `apps/web/app/components/docs/mobile-docs-nav.test.ts`
- Create: `apps/web/app/components/docs/page-actions.ts`
- Create: `apps/web/app/components/docs/page-actions.test.ts`
- Create: `apps/web/app/components/docs/inline-code-responsive.test.ts`
- Create: `apps/web/app/api/markdown/[...slug]/route.test.ts`
- Create: `apps/web/app/docs/page.tsx`
- Create: `apps/web/app/docs/page.test.ts`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `apps/web/app/components/docs/search-index.ts`
- Modify: `apps/web/app/components/docs/search-index.test.ts`
- Modify: `apps/web/app/components/MobileMenu.tsx`
- Modify: `apps/web/app/components/docs/PageActions.tsx`
- Modify: `apps/web/app/api/markdown/[...slug]/route.ts`
- Modify: `apps/web/app/globals.css`
- Modify: `scripts/generate-error-docs.mjs`
- Modify: `scripts/check-docs.mjs`
- Modify: `apps/web/content/docs/{ag-ui,configuration,deployment,errors,evals,testing,testing-agents}.mdx`
- Modify: all eight `apps/web/content/docs/recipes/*.mdx` files
- Modify: matching wrappers for AG-UI, Configuration, Deployment, Scenario
  Testing, Agent Test Harness, Recipes Overview, and all seven recipe leaves

- [x] **Step 1: Write the failing eight-section foundation and title contract**

In `nav.test.ts`, add an exact `FOUNDATION_DOCS_NAV` assertion by copying the
final contract from this plan and omitting these 16 not-yet-authored hrefs:

```text
/docs/memory/long-term
/docs/memory/retrieval
/docs/memory/episodes
/docs/memory/distillation
/docs/dev-server/agent-protocol
/docs/embedding
/docs/testing-agents/fixtures
/docs/persistence
/docs/production-topology
/docs/security-architecture
/docs/memory/browse
/docs/deployment/node
/docs/deployment/kubernetes
/docs/deployment/langsmith
/docs/deployment/edge
/docs/sandbox/kubernetes
```

This produces the exact eight sections and 42 existing pages in their final
relative order. Add title assertions that each nav label equals its MDX H1 and
wrapper `metadata.title`. Extend `search-index.test.ts` so every search title
equals its nav label. Run the two tests; expected red is the old five-section
registry plus current title mismatches.

- [x] **Step 2: Write failing tests for mobile section presentation**

Create a test that renders `MobileDocsNav` with `renderToStaticMarkup` and
`createElement` (the test file remains `.test.ts`, which the current Vitest
include pattern discovers). Assert:

- there is one native `<details>` and `<summary>` per `DOCS_NAV` section;
- only the section containing the supplied pathname has `open` initially;
- the active link has `aria-current="page"`;
- every page link is present under its section.

The component does not exist yet, so the first run must fail at import time.

- [x] **Step 3: Write failing tests for copy/edit source resolution**

In `page-actions.test.ts`, require:

```ts
expect(pageUrl("memory/retrieval")).toBe("https://dawnai.org/docs/memory/retrieval")
expect(sourceSlug("recipes")).toBe("recipes/index")
expect(sourceSlug("memory/retrieval")).toBe("memory/retrieval")
```

In the Markdown route test, call `GET()` with `slug: ["recipes"]` and require a
200 response containing `# Recipes`; also require `recipes/add-a-tool` to keep
working. The current route returns 404 for the section index, so this proves the
existing bug before the fix.

In `page.test.ts`, mock `next/navigation`, invoke the default page component,
and assert one call to `redirect("/docs/getting-started")`. In
`inline-code-responsive.test.ts`, read `globals.css` and require a sub-48rem
`.mdx-inline-code` rule with `white-space: normal` and
`overflow-wrap: anywhere`, while preserving a `pre .mdx-inline-code` override.
Both files are missing or lack the rule, so these assertions begin red.

- [x] **Step 4: Run the focused tests to verify red**

Run:

```bash
pnpm --filter @dawn-ai/web exec vitest run \
  app/components/docs/nav.test.ts \
  app/components/docs/search-index.test.ts \
  app/components/docs/mobile-docs-nav.test.ts \
  app/components/docs/page-actions.test.ts \
  app/components/docs/inline-code-responsive.test.ts \
  app/docs/page.test.ts \
  'app/api/markdown/[...slug]/route.test.ts'
```

Expected: FAIL for the old five-section order/title mismatches, missing
component/helper/redirect, absent responsive rule, and recipes Markdown 404.

- [x] **Step 5: Install the foundation registry and normalize existing titles**

Replace `DOCS_NAV` with the exact 42-page foundation from Step 1. Keep every
literal on one line with `label` before `href`. Change these H1s and matching
metadata/visible card labels to their final names: AG-UI and Web Clients,
Scenario Testing, Agent Test Harness, Evals, Deployment Options,
Configuration Reference, Error Codes, Recipes Overview, and the seven exact
recipe-leaf titles in the final contract. `sandbox.mdx`, CLI, and API already
have their final H1s. Because `errors.mdx` is generated, change the heading in
`scripts/generate-error-docs.mjs` from `# Error codes` to `# Error Codes`, then
run `node scripts/generate-error-docs.mjs`; do not hand-edit the generated MDX.
Remove `search-index.ts`'s silent missing-MDX catch so a registry/content
mismatch fails instead of quietly disappearing. Now that the existing titles
are normalized, extend `scripts/check-docs.mjs` so every nav label, first MDX
H1, and wrapper `metadata.title` must agree exactly.

- [x] **Step 6: Extract and render the mobile docs navigation**

Implement `MobileDocsNav` as a focused client component:

```tsx
"use client"

import Link from "next/link"
import { DOCS_NAV } from "./nav"

interface Props {
  readonly pathname: string
  readonly onNavigate: () => void
}

export function MobileDocsNav({ pathname, onNavigate }: Props) {
  return (
    <nav className="space-y-2" aria-label="Documentation">
      {DOCS_NAV.map((section) => {
        const activeSection = section.items.some((item) => item.href === pathname)
        return (
          <details key={section.label} open={activeSection} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-saas">
              <span>{section.label}</span>
              <span aria-hidden className="transition-transform group-open:rotate-45">+</span>
            </summary>
            <ul className="space-y-0.5 pb-2">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                      className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? "bg-accent-saas-soft text-accent-saas"
                          : "text-ink-muted hover:bg-surface hover:text-ink"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </details>
        )
      })}
    </nav>
  )
}
```

Use the exact existing link classes from `MobileMenu.tsx`; add only summary
focus/hover affordances and a small disclosure marker. Replace the duplicated
mobile docs loop in `MobileMenu` with:

```tsx
<MobileDocsNav pathname={pathname} onNavigate={() => setIsOpen(false)} />
```

Native `details`/`summary` supplies Enter/Space keyboard behavior; do not add a
parallel custom accordion state machine.

- [x] **Step 7: Fix canonical page actions and recipe-index source mapping**

Move pure URL/source functions to `page-actions.ts`:

```ts
const CANONICAL_BASE = "https://dawnai.org"

export function pageUrl(slug: string): string {
  return `${CANONICAL_BASE}/docs/${slug}`
}

export function sourceSlug(slug: string): string {
  return slug === "recipes" ? "recipes/index" : slug
}
```

Import them into `PageActions.tsx`. Use `sourceSlug(slug)` for both the Markdown
request and GitHub edit URL; keep the public docs URL on `/docs/recipes`.

In the Markdown route, try `<slug>.mdx` first and then
`<slug>/index.mdx`, applying the existing traversal/containment checks to both
candidates. Return 404 only when neither exists.

- [x] **Step 8: Add the docs-root redirect and mobile inline-code wrapping**

Create `apps/web/app/docs/page.tsx`:

```tsx
import { redirect } from "next/navigation"

export default function Page(): never {
  redirect("/docs/getting-started")
}
```

Add a narrow-screen override after `.mdx-inline-code` in `globals.css`:

```css
@media (max-width: 47.999rem) {
  .mdx-inline-code {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  pre .mdx-inline-code {
    white-space: inherit;
    overflow-wrap: normal;
  }
}
```

This changes inline chips only; block code and tables retain horizontal scroll.

- [x] **Step 9: Verify the green foundation slice**

Run:

```bash
node scripts/generate-error-docs.mjs
pnpm --filter @dawn-ai/web exec vitest run \
  app/components/docs/nav.test.ts \
  app/components/docs/search-index.test.ts \
  app/components/docs/mobile-docs-nav.test.ts \
  app/components/docs/page-actions.test.ts \
  app/components/docs/inline-code-responsive.test.ts \
  app/docs/page.test.ts \
  'app/api/markdown/[...slug]/route.test.ts'
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: the 42-page eight-section registry, title sync, all web/discovery
tests, generated CLI bundle test, lint, typecheck, docs checker, and diff check
pass. There are no nav entries for unfinished pages.

- [x] **Step 10: Commit the shell slice**

```bash
git add apps/web/app/components/MobileMenu.tsx \
  apps/web/app/components/docs/MobileDocsNav.tsx \
  apps/web/app/components/docs/mobile-docs-nav.test.ts \
  apps/web/app/components/docs/page-actions.ts \
  apps/web/app/components/docs/page-actions.test.ts \
  apps/web/app/components/docs/inline-code-responsive.test.ts \
  apps/web/app/components/docs/PageActions.tsx \
  'apps/web/app/api/markdown/[...slug]/route.ts' \
  'apps/web/app/api/markdown/[...slug]/route.test.ts' \
  apps/web/app/docs/page.tsx apps/web/app/docs/page.test.ts \
  apps/web/app/globals.css \
  apps/web/app/components/docs/nav.ts apps/web/app/components/docs/nav.test.ts \
  apps/web/app/components/docs/search-index.ts \
  apps/web/app/components/docs/search-index.test.ts \
  apps/web/content/docs/ag-ui.mdx apps/web/content/docs/configuration.mdx \
  apps/web/content/docs/deployment.mdx apps/web/content/docs/errors.mdx \
  apps/web/content/docs/evals.mdx apps/web/content/docs/testing.mdx \
  apps/web/content/docs/testing-agents.mdx apps/web/content/docs/recipes \
  apps/web/app/docs/ag-ui/page.tsx apps/web/app/docs/configuration/page.tsx \
  apps/web/app/docs/deployment/page.tsx apps/web/app/docs/testing/page.tsx \
  apps/web/app/docs/testing-agents/page.tsx apps/web/app/docs/recipes \
  scripts/generate-error-docs.mjs scripts/check-docs.mjs
git diff --cached --name-status
git commit -m "feat(web): improve mobile documentation navigation"
```

### Task 3: Add the missing operating and embedding guides

**Files:**
- Create: `apps/web/content/docs/persistence.mdx`
- Create: `apps/web/content/docs/production-topology.mdx`
- Create: `apps/web/content/docs/security-architecture.mdx`
- Create: `apps/web/content/docs/embedding.mdx`
- Create: `apps/web/app/docs/persistence/page.tsx`
- Create: `apps/web/app/docs/production-topology/page.tsx`
- Create: `apps/web/app/docs/security-architecture/page.tsx`
- Create: `apps/web/app/docs/embedding/page.tsx`
- Modify: `apps/web/content/docs/access-control.mdx`
- Modify: `apps/web/content/docs/middleware.mdx`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`

- [x] **Step 1: Register the four guides and capture the intended red**

Add Embed the Runtime after AG-UI in Integrate. Add Persistence and Tenancy,
Production Topology, and Security Architecture at the start of Operate. Extend
the exact expected registry in `nav.test.ts` to 46 pages. Add only these four
page contracts from Task 1's allocation table to `scripts/check-docs.mjs`.

Run the nav test and docs checker. Expected: red only for the four missing
content files/wrappers and their required fragments. Do not commit and do not
register any later page.

- [x] **Step 2: Write Persistence and Tenancy from the data inventory**

Use this exact page shape:

1. `# Persistence and Tenancy` — verdict: SQLite is the one-process default;
   production tenancy is an application boundary, not inferred from a thread id.
2. `## What Dawn persists` — one matrix covering checkpoints, thread metadata,
   permission decisions, typed long-term memory, `workspace/` files, and sandbox
   volumes. Columns: default location, shared option, namespace/tenant key,
   deletion behavior, and owner.
3. `## Choose local or shared stores` — SQLite versus Postgres, with long-term
   memory explicitly separate from the three Postgres runtime stores. A running
   process caches loaded permission decisions, so do not promise instant
   cross-replica invalidation merely because the backing store is shared.
4. `## Tenant ownership` — derive tenant/user scope from verified identity;
   caller route/thread/scope values do not authenticate ownership.
5. `## What deleting a thread removes` — thread metadata, best-effort
   checkpoints, and its sandbox; explicitly not global permission decisions,
   long-term memory, or arbitrary workspace files.
6. `## Backup, restore, encryption, and retention` — Dawn does not provide
   application-level encryption or an account-erasure transaction.
7. `## Migration checklist` — local disk to shared services without claiming
   that shared stores distribute active-run coordination.
8. `## Related` — State, Memory, Permissions, Workspace, Production Topology,
   and Security Architecture. Use the existing Memory overview in this slice;
   Task 7 repoints the link to Long-term Memory when that page lands.

Do not invent a database migration tool. Link exact configuration fields to
Configuration Reference.

- [x] **Step 3: Write Production Topology as the consumer of that inventory**

Use these headings and contracts:

- `# Production Topology`
- `## Start with one process` — Node runtime plus default SQLite.
- `## Where state lives` — process-local run gate/cancel registry versus local
  disk versus configured shared stores.
- `## Move to ephemeral compute` — Postgres for checkpoint/thread/permission,
  separate memory backend, durable workspace/sandbox decisions.
- `## Add replicas safely` — shared persistence **and** guaranteed thread-aware
  routing/serialization plus cancel routing. Dawn supplies no distributed run
  coordinator. Explain why AG-UI's body-carried thread id is not automatically
  usable by an ordinary path-only load balancer.
- `## Streaming and proxy behavior` — AP viewers may disconnect while a run
  continues; AG-UI disconnect aborts its ephemeral run.
- `## Health and readiness` — a successful `/healthz` is a liveness signal, not
  a dependency-readiness guarantee for Postgres, model providers, or sandboxes.
  The fetch/Hono path may initialize request stores before route dispatch, so do
  not claim that no dependency work can occur before the health response.
- `## Shutdown and rollouts` — handler `close()` drains up to 30 seconds when
  invoked; injected pools remain app-owned. `dawn start` installs signal
  handlers, but generated `server.mjs` currently does not.
- `## Kubernetes implications` — HPA/PDB are availability primitives, not run
  coordination.

Use one state-placement table rather than repeating paragraphs from Persistence.

- [x] **Step 4: Write Security Architecture as the outer boundary**

Use this outline:

1. `# Security Architecture`
2. `## Start at the service edge` — authenticate and restrict the entire
   non-local service.
3. `## Endpoint coverage` — matrix with outer auth required for health, thread
   management, execution, cancellation, AG-UI, and memory candidates; identify
   the narrower routes where Dawn middleware runs.
4. `## Authorize the tenant, not the identifier` — compare verified claims with
   route params, thread ownership, tenant, user, and memory namespace.
5. `## Pass verified identity to tools` — canonical identity travels through
   allowed middleware context; the model/caller does not choose it.
6. `## Inner agent controls` — concise links to Access Control, Tool Scope,
   Permissions, Sandbox, and Subagents. State that authored tools run in the app
   process unless they isolate themselves.
7. `## Secrets and stored data` — Hono serializes config into `app.mjs`, so
   secrets use bindings/environment; Postgres rows are plaintext application
   data unless the app/platform encrypts them.
8. `## Target differences` — Node/Hono middleware, LangSmith platform boundary,
   sandbox availability.
9. `## Production checklist` and `## Related`.

Do not turn Access Control into an identity page. Add a short outer-boundary
callout to `access-control.mdx`; add a matching “middleware is execution-only”
link in `middleware.mdx`.

- [x] **Step 5: Write Embed the Runtime around stable exports only**

Use this outline:

- `# Embed the Runtime`
- `## Choose standalone or embedded`
- `## Own a Node server with serveRuntime` — import `serveRuntime` and
  `loadStaticModules` from the package root. Show `installSignalHandlers: true`
  only when the host wants Dawn to own SIGINT/SIGTERM handling.
- `## Compose the fetch runtime` — import `createRuntimeFetchHandler` from
  `@dawn-ai/cli/fetch`; supply static modules/config/stores explicitly.
- `## Compose with Hono` — use `app.route("/", dawnApp)`. Never show `mount()`
  and do not imply `/dawn` or another prefix is a Dawn base-path feature.
- `## Lower-level tooling surface` — mention `@dawn-ai/cli/runtime` only to
  classify it; applications should use the package root or `/fetch`.
- `## Dependency precedence` — supplied instances, configuration, then Node
  fallbacks; edge has no filesystem fallback.
- `## Endpoint paths` — `/healthz`, `/threads`, `/agui`, `/memory` are rooted.
- `## Resource ownership and shutdown` — wait for response and run lifetime,
  close the handler before the caller-owned pool, and clean partial request-store
  allocation inside the factory if it throws.
- `## Authentication` and `## Test the embedded host`.

The edge example uses the opaque rooted namespace `appRoot: "/my-app"` and
`modules.edge.mjs`. Do not import or recommend `@dawn-ai/cli/runtime`; its own
source labels it a tooling surface. Link Deployment Options in this slice;
Task 4 can repoint target-specific links after those pages exist.

- [x] **Step 6: Add wrappers with exact titles and paths**

Use the wrapper template from the file map with these pairs:

| href | metadata/H1 |
|---|---|
| `/docs/persistence` | `Persistence and Tenancy` |
| `/docs/production-topology` | `Production Topology` |
| `/docs/security-architecture` | `Security Architecture` |
| `/docs/embedding` | `Embed the Runtime` |

- [x] **Step 7: Verify the operating-guide slice**

Run:

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: all web/discovery tests, generated CLI bundle coverage, typecheck,
docs checker, and diff check pass with exactly 46 registered pages.

- [x] **Step 8: Request source-contract review**

Ask the reviewer to compare the four pages with the ledger authorities,
especially thread deletion, middleware coverage, generated signal handling,
store ownership, `/healthz`, Hono request identity, and public export stability.
Resolve Critical/Important findings before committing.

- [x] **Step 9: Commit the operating guides**

```bash
git add apps/web/content/docs/persistence.mdx \
  apps/web/content/docs/production-topology.mdx \
  apps/web/content/docs/security-architecture.mdx \
  apps/web/content/docs/embedding.mdx \
  apps/web/content/docs/access-control.mdx \
  apps/web/content/docs/middleware.mdx \
  apps/web/app/docs/persistence/page.tsx \
  apps/web/app/docs/production-topology/page.tsx \
  apps/web/app/docs/security-architecture/page.tsx \
  apps/web/app/docs/embedding/page.tsx \
  apps/web/app/components/docs/nav.ts \
  apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "docs: add production operating guides"
```

### Task 4: Split deployment guidance by target

**Files:**
- Create: `apps/web/content/docs/deployment/node.mdx`
- Create: `apps/web/content/docs/deployment/kubernetes.mdx`
- Create: `apps/web/content/docs/deployment/langsmith.mdx`
- Create: `apps/web/content/docs/deployment/edge.mdx`
- Create: matching `apps/web/app/docs/deployment/{node,kubernetes,langsmith,edge}/page.tsx`
- Modify: `apps/web/content/docs/deployment.mdx`
- Modify: `apps/web/content/docs/embedding.mdx`
- Modify: `apps/web/app/docs/deployment/page.tsx`
- Modify: `charts/dawn-app/README.md`
- Modify: `charts/dawn-app/values.yaml`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`
- Test: `apps/web/app/components/docs/docs-anchors.test.ts`

- [x] **Step 1: Register the four target guides and capture the intended red**

Insert Node and Docker, Kubernetes, LangSmith, and Edge and Hono immediately
after Deployment Options in Deploy. Extend the exact nav test to 50 pages. Add
the four deployment-page accuracy rows from Task 1, move the existing monolithic
Deployment row to the correct focused owners, and add the stale chart phrases
to the chart guard.

Run nav/checker tests. Expected: red only for these four missing pages/wrappers,
their accuracy fragments, and the known stale chart wording. Do not commit or
register Kubernetes Sandbox. Repoint Embed the Runtime's temporary
target-specific links to the new pages in this same slice.

- [x] **Step 2: Turn Deployment into the verdict-first chooser**

Retitle it `# Deployment Options` and keep only:

- a recommendation: choose Node unless a named LangSmith or edge constraint
  determines otherwise;
- a Node/LangSmith/Hono matrix covering artifact, runtime/protocol, middleware,
  storage, filesystem/sandbox, Node requirement, and evidence boundary;
- the fact that Node and LangSmith are defaults, Hono is opt-in, and an authored
  `build.targets` list replaces the defaults;
- the shared `dawn check` → `dawn build` → `dawn verify` flow;
- concise cards to the four target pages, Production Topology, Persistence, and
  Security Architecture;
- existing troubleshooting that is genuinely cross-target.

Retain every moved Deployment heading as a one-paragraph compatibility section
linking to the canonical page. The required headings are:

```text
## Deploying to production (Node/Docker)
## Deploying on Kubernetes
## The LangSmith / LangGraph Platform path
## Edge runtimes
### The `@dawn-ai/cli/fetch` entry point
### The `hono` build target
#### Why the stores are per-request
#### What the edge cannot serve
#### What is proven, and what is not
```

Do not copy the moved examples back into these stubs.

- [x] **Step 3: Write Node and Docker**

Use headings: recommendation/prerequisites, select the target, emitted files,
run directly, build/run the generated Dockerfile, environment/secrets,
filesystem/sandbox, health and shutdown, production checklist, troubleshooting,
related. Preserve these exact contracts:

- Node 24+ and `@dawn-ai/cli` in production dependencies;
- `.dawn/build/server.mjs` and the marker-managed generated Dockerfile;
- host build occurs before image build;
- local smoke publishes only `127.0.0.1:8000:8000`;
- a successful `/healthz` is a process-liveness signal, not dependency
  readiness, and request-store initialization can occur first on fetch/Hono;
- generated server currently does not install signal handlers;
- external auth/network restriction covers the full service.

- [x] **Step 4: Write Kubernetes**

Own application-chart installation here, not in Sandbox. Include:

1. prerequisites: built Node image and sandbox-infra namespace/service account
   when Kubernetes sandbox is configured;
2. exact Helm install/upgrade commands with `--namespace dawn-sandboxes`;
3. probe semantics (a successful `/healthz` is liveness, not dependency
   readiness; request-store setup may run before dispatch);
4. secrets/environment and storage links;
5. the chart mounts only `/tmp`, so local `.dawn` SQLite data is ephemeral
   across Pod replacement;
6. ServiceAccount/namespace wiring: the defaults are
   `serviceAccount.create=false` and `serviceAccount.name=dawn-orchestrator`, so
   the same-namespace path requires the sandbox-infra release first; the
   alternate path creates/selects an app ServiceAccount and adds it as an
   orchestrator subject. `sandboxNamespace` is informational, not namespace
   creation. Applications not using the Kubernetes sandbox should disable token
   automount where their setup allows;
7. replica checklist: shared checkpoint/thread/permission stores, separate
   memory store, and thread-aware serialization/cancel routing;
8. rollout/shutdown caveat for the generated server;
9. chart README as exhaustive values reference.

Do not imply the HPA or PDB supplies Dawn run coordination.
Link the existing Execution Sandbox overview for Kubernetes sandbox setup in
this slice; Task 5 repoints that link to Kubernetes Sandbox when it lands.

- [x] **Step 5: Write LangSmith**

Cover emitted `langgraph.json`, route entries and `assistant_id`, environment
file path, agent-route materialization versus raw workflow/graph/chain exports,
and platform authentication. State that Dawn HTTP middleware, AG-UI server, and
sandbox manager are absent. Keep the exact unresolved compatibility statement:
the emitted `node_version: "22"` conflicts with Dawn packages' Node 24+
requirement. Explain merge precedence: user-defined extra keys survive, while
generated `graphs`, `dependencies`, `env`, and `node_version` overwrite
identically named user keys.

- [x] **Step 6: Write Edge and Hono**

Move the current accurate edge material, then tighten it into this order:

1. fit check and local-workerd evidence limit;
2. select Hono and inspect emitted `modules.edge.mjs`, `stores.mjs`, `app.mjs`,
   and `wrangler.toml`;
3. hand composition with `@dawn-ai/cli/fetch`, `appRoot: "/my-app"`, and
   `app.route("/", dawnApp)`;
4. per-request store lifetime and why request identity matters;
5. the complete `DAWN_E1005` capability-gate matrix;
6. config-in-artifact secret warning;
7. deploy checklist and what local workerd has not proven.

Never show `app.mount()`, a relative app root, arbitrary Dawn base-path support,
or a live Cloudflare deployment claim.

- [x] **Step 7: Correct the chart's stale scaling contract**

In `charts/dawn-app/README.md`, replace “shared backend does not exist yet” and
the obsolete `Single replica only`/threads-diverge-only explanation with a
`Scaling requirements` section:

- Postgres can share checkpoints, thread metadata, and permission decisions;
- long-term memory is separately configured;
- the active run gate and cancellation registry remain process-local;
- shared stores are necessary but insufficient for replicas;
- multiple replicas require guaranteed thread-aware routing or distributed
  serialization plus cancel routing;
- `/healthz` is a process probe, not dependency readiness.

Keep the conservative default of one replica and the chart's non-enforcement
warning. In `values.yaml`, repoint the old deployment/sandbox comments to the
newly available deployment pages, keep the existing Execution Sandbox link
until Task 5, and describe `/healthz` as the shared liveness/readiness path
without implying it validates dependencies. Do not change chart defaults.

- [x] **Step 8: Add wrappers and canonical anchor assertions**

Use these exact titles: `Node and Docker`, `Kubernetes`, `LangSmith`, and
`Edge and Hono`. Extend `docs-anchors.test.ts` so it requires the canonical
edge page to own `what-the-edge-cannot-serve`, `why-the-stores-are-per-request`,
and `what-is-proven-and-what-is-not`, while the Deployment overview still owns
the same compatibility anchors.

- [x] **Step 9: Verify and review the deployment slice**

Run:

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
helm lint --strict charts/dawn-app
charts/dawn-app/test/render.sh
git diff --check
```

Expected: 50-page nav/discovery/CLI coverage, anchors, lint, typecheck, checker,
chart render/lint, and diff check all pass. Request a source-contract review of
all copied commands and target-boundary claims.

- [x] **Step 10: Commit the deployment split**

```bash
git add apps/web/content/docs/deployment.mdx apps/web/content/docs/deployment \
  apps/web/content/docs/embedding.mdx \
  apps/web/app/docs/deployment/page.tsx apps/web/app/docs/deployment \
  apps/web/app/components/docs/docs-anchors.test.ts charts/dawn-app/README.md \
  charts/dawn-app/values.yaml apps/web/app/components/docs/nav.ts \
  apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "docs: split deployment guidance by target"
```

### Task 5: Separate Kubernetes sandbox operations

**Files:**
- Create: `apps/web/content/docs/sandbox/kubernetes.mdx`
- Create: `apps/web/app/docs/sandbox/kubernetes/page.tsx`
- Modify: `apps/web/content/docs/sandbox.mdx`
- Modify: `apps/web/content/docs/deployment/kubernetes.mdx`
- Modify: `charts/dawn-app/values.yaml`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`

- [x] **Step 1: Register Kubernetes Sandbox and capture the intended red**

Add Kubernetes Sandbox after Execution Sandbox, extend the exact registry test
to 51 pages, add the focused Kubernetes sandbox row from Task 1, and replace
any Kubernetes-specific overview guard with the concise-overview row. Run the
nav test and checker. Expected: red only for the new page/wrapper and its
allocated fragments. Repoint the temporary Execution Sandbox link in
Deployment/Kubernetes and the app-chart values comment to the new canonical page
in this same slice. Do not commit or register later pages.

- [x] **Step 2: Narrow Execution Sandbox to the portable contract**

Keep Docker quickstart, what is isolated, lifecycle, security hardening,
per-command timeout, Docker network behavior, subagents, custom provider
interface (including `preflight().warnings`), testing, E2E verification, and
“What it is — and isn't.” Replace Kubernetes and Helm detail with concise links.

- [x] **Step 3: Preserve moved Kubernetes anchors on the overview**

Retain these headings as short compatibility sections:

```text
## Kubernetes provider
### Security hardening on Kubernetes
### Network policy on Kubernetes
## Deploying the sandbox infrastructure (Helm)
### Key caveats
## Deploying a Dawn app (Helm)
### ServiceAccount and namespace wiring
### Env, secrets, and replicas
```

`## Quickstart` and `## What it is — and isn't` remain full canonical sections
on the overview because error-code links depend on them.

- [x] **Step 4: Write Kubernetes Sandbox**

Use this outline:

1. prerequisites and provider fit;
2. install `dawn-sandbox-infra` in `dawn-sandboxes`;
3. configure `kubernetesSandbox({ namespace: "dawn-sandboxes" })`;
4. ServiceAccount/RBAC wiring for the application release;
5. per-thread Pod plus RWO PVC lifecycle, Pod Security Standards, resource
   limits/quotas, and the PVC reaper;
6. NetworkPolicy: default-deny plus allowed DNS, CNI enforcement dependency,
   the infra chart's DNS-only backstop for managed Pods, and the fact that
   provider `network: "allow"` does not override that chart policy. Because DNS
   remains allowed, say explicitly that deny mode is not zero egress;
7. PID/resource exhaustion and cleanup behavior;
8. verify provider preflight and gated E2E lanes;
9. links to Kubernetes deployment and chart README values.

Every `helm install dawn-app` example belongs on Deployment/Kubernetes, not on
this page. This page may link there when explaining the app-side service account.
State that preflight verifies Pod-create authorization but reports NetworkPolicy
as unknown; it does not prove DNS, CNI enforcement, or end-to-end networking.
Sandbox Pods disable service-account-token automount. Describe Pod Security
admission generally; do not claim a particular writable-root setting is rejected
unless a chart test proves it. State that PID limits are a node/runtime concern,
not something this chart supplies.

- [x] **Step 5: Add the wrapper and verify**

Use title `Kubernetes Sandbox`, then run:

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
helm lint --strict charts/dawn-sandbox-infra
charts/dawn-sandbox-infra/test/render.sh
git diff --check
```

Expected: all 51-page web/discovery/CLI coverage, anchor/typecheck, checker,
chart tests, and diff check pass. Request review against both providers, chart
defaults, DNS/CNI behavior, and namespace/service-account wiring.

- [x] **Step 6: Commit the sandbox split**

```bash
git add apps/web/content/docs/sandbox.mdx \
  apps/web/content/docs/sandbox/kubernetes.mdx \
  apps/web/content/docs/deployment/kubernetes.mdx \
  charts/dawn-app/values.yaml \
  apps/web/app/docs/sandbox/kubernetes/page.tsx \
  apps/web/app/components/docs/nav.ts \
  apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "docs: separate Kubernetes sandbox operations"
```

### Task 6: Extract the Agent Protocol reference from local-development guidance

**Files:**
- Create: `apps/web/content/docs/dev-server/agent-protocol.mdx`
- Create: `apps/web/app/docs/dev-server/agent-protocol/page.tsx`
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`
- Test: `apps/web/app/components/docs/docs-anchors.test.ts`

- [x] **Step 1: Register Agent Protocol and capture the intended red**

Add Agent Protocol immediately after Dev Server, extend the exact nav test to
52 pages, add the Agent Protocol and concise Dev Server rows from Task 1, and
move endpoint/cancellation/candidate checks from the old Dev Server contract to
the new file. Move `/agui/{routeId}`, encoded route IDs,
`@dawn-ai/ag-ui`, and `RunAgentInput.resume` requirements to `ag-ui.mdx`. Add
the fixed-count regex guard.

Run nav/checker tests. Expected: red only for the new page/wrapper and its
required route facts. Do not commit or register memory pages.

- [x] **Step 2: Turn Dev Server into the short local-development path**

Keep the existing `# Dev Server` title and retain complete sections for starting
the server, invoking a route, the parent watcher/session versus child-owned HTTP
listener restart cycle, logging, and related pages. The overview must still say:

- the child runtime stops and starts on a restart while the parent retains the
  watcher, session, selected URL, and persisted state configuration;
- the default SQLite stores, or another configured durable store, preserve
  checkpoints across the child restart;
- this is child-process restart behavior, not in-process HMR and not a claim that
  a parent-owned listener remains bound.

Replace protocol detail with short compatibility sections under these unchanged
headings:

```text
## Agent Protocol endpoints
### Thread lifecycle with curl
### One run at a time per thread
### Client disconnect
## AG-UI endpoint
## Tracing
## Middleware
```

The Agent Protocol headings link to the new canonical page. The AG-UI heading
links to `AG-UI and Web Clients`, Tracing links to Observability, and Middleware
links to Middleware plus Security Architecture. Do not duplicate their canonical
examples on the Dev Server overview.

- [x] **Step 3: Write the complete Agent Protocol page**

Create `# Agent Protocol` with this order:

1. a local-development quickstart and a prominent production warning that the
   management routes are not all covered by Dawn execution middleware;
2. an endpoint table for `POST /threads`, `GET`/`DELETE /threads/:thread_id`,
   `GET /threads/:thread_id/state`, `POST /threads/:thread_id/runs/wait`,
   `POST /threads/:thread_id/runs/stream`, `POST /threads/:thread_id/resume`,
   `POST /threads/:thread_id/cancel`, and the three memory-candidate routes;
3. a copyable create → wait → read-state flow;
4. SSE streaming, with each `data:` payload described as the runtime's raw JSON
   chunk and `: ping` treated as a comment heartbeat;
5. interrupt/resume semantics;
6. the one-active-run gate and explicit cancellation;
7. disconnect behavior: an Agent Protocol viewer disconnect does not itself
   cancel the run, whereas explicit cancellation does;
8. candidate listing/approve/reject, including the cross-namespace scope and
   destructive mutations;
9. production topology and outer-auth links;
10. an AG-UI link that explains it is a different endpoint and lifecycle.

Do not state a fixed endpoint count. Keep request/response shapes synchronized
with `runtime-fetch-core.ts` and its tests; do not infer a route from a comment
alone.

- [x] **Step 4: Add the wrapper and compatibility-anchor assertions**

Add the wrapper with title `Agent Protocol`. Extend `docs-anchors.test.ts` to
assert that both `/docs/dev-server` and the canonical Agent Protocol page expose
`agent-protocol-endpoints`, `thread-lifecycle-with-curl`,
`one-run-at-a-time-per-thread`, and `client-disconnect`.

- [x] **Step 5: Verify and review the protocol slice**

Run:

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: all 52-page web/discovery/CLI coverage, anchors, lint, typecheck,
checker, and diff check pass. Request review against the route dispatcher,
heartbeat and cancellation tests, middleware coverage, and run registry.

- [x] **Step 6: Commit the protocol split**

```bash
git add apps/web/content/docs/dev-server.mdx \
  apps/web/content/docs/dev-server/agent-protocol.mdx \
  apps/web/app/docs/dev-server/agent-protocol/page.tsx \
  apps/web/app/components/docs/docs-anchors.test.ts \
  apps/web/app/components/docs/nav.ts \
  apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "docs: extract Agent Protocol reference"
```

### Task 7: Split memory by developer task and add administrative browse

**Files:**
- Create: `apps/web/content/docs/memory/long-term.mdx`
- Create: `apps/web/content/docs/memory/retrieval.mdx`
- Create: `apps/web/content/docs/memory/episodes.mdx`
- Create: `apps/web/content/docs/memory/distillation.mdx`
- Create: `apps/web/content/docs/memory/browse.mdx`
- Create: matching `apps/web/app/docs/memory/{long-term,retrieval,episodes,distillation,browse}/page.tsx`
- Modify: `apps/web/content/docs/memory.mdx`
- Modify: `apps/web/content/docs/persistence.mdx`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`
- Test: `apps/web/app/components/docs/docs-anchors.test.ts`

- [x] **Step 1: Register the five memory guides and capture the intended red**

Insert Long-term Memory, Recall and Retrieval, Episodes, and Distillation after
Memory in Build. Insert Browse and Manage Memory before Upgrading in Operate.
Extend the exact nav test to 57 pages. Add the five focused rows plus the Memory
chooser row from Task 1 to `scripts/check-docs.mjs`.

Run nav/checker tests. Expected: red only for the five new pages/wrappers and
their allocated contracts. Do not commit or register Fixtures and Recording.

- [x] **Step 2: Make Memory a three-mechanism chooser**

Keep `# Memory` and explain only these three built-in choices:

| Need | Canonical mechanism | Lifetime and audience |
|---|---|---|
| Durable app-wide agent instructions/profile | `workspace/AGENTS.md` | Re-read each turn; shared host prompt source unless the app isolates its app root/trust domain |
| Versioned route-local prompt facts | `src/app/<route>/memory.md` | Source-controlled prompt context for that route |
| Typed, queryable long-term records | `src/app/<route>/memory.ts` | Store-backed records exposed through generated recall/remember tools |

State is runtime input/checkpoint data, not a fourth memory mechanism. Preserve
the complete route-local `memory.md` walkthrough. Keep the workspace profile
section concise and link to Workspace Filesystem for the host/sandbox trust
boundary. End the typed-memory section after the smallest correct schema and
links to Long-term Memory, Recall and Retrieval, Episodes, Distillation, and
Browse and Manage Memory.

Retain the old moved headings below as concise compatibility sections that link
to the canonical pages. Keep their text short enough that the overview remains
a chooser:

```text
## Long-term collection (`memory.ts`)
### Generated tools
### How recall ranks
### Semantic recall (opt-in)
### Postgres backend (pgvector)
### The injected index
## Episodic memory
### Enabling the run recorder
### What gets recorded
### Retention
### Time-windowed recall
### Governance
### Agent-authored episodes
## Distillation
### Consolidation
### Reflection
### Distilled records are found by keyword
### Provenance
### Cost
### Running it on a schedule
### Distillation configuration
## Write governance
### `ask` mode
## Reviewing candidates
## Configuration
## Testing
### Verifying against a real model
## What's deferred
```

- [x] **Step 3: Write Long-term Memory**

Use these sections: define the schema, choose kind and scope, generated
`recall_<name>`/`remember_<name>` tools, deterministic record identity and
write-time timestamp caveat, append versus upsert, governance modes and
candidates, store selection, retention/deletion, configuration, testing, and
related pages. Distinguish the typed collection from route prompt memory and
episodes. State that writes default to `candidate`, that `resolveScope` receives
route path and app root rather than verified middleware identity, and that the
declared `procedural` kind is not yet wired for generated writes. Put the general
candidate-review workflow and `seedMemory` here; Distillation links to it rather
than redefining candidate review. Explain that timestamp-salted append IDs
normally separate repeated writes, but namespace, data, and the same millisecond
timestamp can still collide and upsert.

- [x] **Step 4: Write Recall and Retrieval**

Document `MemoryStore.search`, not `browse`, in this order:

1. generated agent recall and its namespace/scope inputs;
2. query-less deterministic filtering and query-based keyword ranking;
3. explicit evaluation timestamp and expiry/time-window behavior;
4. opt-in embeddings, model id matching, keyword/vector union, RRF fusion, and
   recency/confidence tuning;
5. SQLite exact vector scan versus Postgres pgvector HNSW approximate-nearest
   candidate retrieval;
6. retrieval evaluation and troubleshooting.

Do not promise identical result order across backends. Use
`packages/memory/src/types.ts`, both store implementations, and conformance
tests as authorities. End with a short explicit contrast and link: `search`
serves agent recall, while `browse` serves administrative inventory.

- [x] **Step 5: Write Episodes**

Separate recorder-authored episodes from agent-authored episodic records. Cover
enablement, recorded source/data, one run timestamp, TTL/cap pruning, time-window
recall, governance, and tests. Include the actual defaults: recording disabled,
30-day TTL, 500-record cap, and failed runs included. State that the current
`embed` option warns and records without embeddings. Link Long-term Memory for
schema/write controls and Recall and Retrieval for ranking. Explain settled,
failed, and parked-interrupt behavior from the runtime tests; do not describe a
parked run as a completed episode before it resumes.

- [x] **Step 6: Write Distillation**

Start with the verdict that nothing runs automatically. Document only the
explicit `dawn memory consolidate` and `dawn memory reflect` flows, their flags,
selection rules, output kinds, provenance/supersession behavior, cost, safe
scheduling, configuration, and tests. Include dry-run behavior, consolidation's
write-first/then-link failure boundary and source expiry, reflection watermarks
and no-insight sentinel, the candidate default for reflected insights,
`maxRecords` backlog behavior, and keyword reachability of derived records.
Candidate review is governance, not distillation; link to Long-term Memory for
it.

- [x] **Step 7: Write Browse and Manage Memory as an admin contract**

Use `packages/memory/src/{types,browse,browse-validate,browse-cursor,browse-order,browse-range}.ts`
and `packages/testing/src/memory-conformance.ts` as the public authorities. Do
not copy the stale browse comments in `packages/core/src/capabilities/types.ts`.
Cover:

- `MemoryStore.browse` versus agent-facing `MemoryStore.search`;
- there is no public Dawn administrative browse HTTP endpoint; the application
  owns that authenticated surface, and Inspector is a local/internal tool;
- pure validation/cursor imports from `@dawn-ai/memory/browse`, which do not pull
  in `node:sqlite`;
- server-derived tenant namespace prefixes and outer authentication;
- exact namespace, prefix, enum, source, time, confidence, content, sort, and
  pagination filters, including the closed sort whitelist;
- opaque cursors tied to a query fingerprint and one fixed `now` for an entire
  walk; explain behavior and safe continuation without reproducing every
  validator limit, fingerprint field, or error identifier from API Reference;
- exact matching-set `total` plus records from one transaction snapshot;
- the legitimate empty final page when total rows are an exact multiple of the
  page limit;
- intentional SQLite/Postgres parity for namespace, ordering, and cursor rules,
  qualified by SQLite `lower()` being ASCII-only and Postgres `float4`
  confidence potentially tying ultra-close values differently;
- a small authenticated application-owned server-handler example and links to
  the distinct candidate management endpoints. Explicitly say browse does not
  use semantic ranking.

- [x] **Step 8: Add wrappers and compatibility-anchor tests**

Use exact titles: `Long-term Memory`, `Recall and Retrieval`, `Episodes`,
`Distillation`, and `Browse and Manage Memory`. Extend
`docs-anchors.test.ts` to require the old Memory overview anchors and their new
canonical owners; include at least `how-recall-ranks`, `semantic-recall-opt-in`,
`postgres-backend-pgvector`, `episodic-memory`, `distillation`,
`write-governance`, `reviewing-candidates`, `configuration`, and `testing`.

- [x] **Step 9: Verify and review the memory slice**

Run:

```bash
pnpm --filter @dawn-ai/memory test
pnpm --filter @dawn-ai/memory-pgvector test
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: both memory packages, all 57-page web/discovery/CLI coverage, anchors,
lint, typecheck, checker, and diff check pass. Request review against built-in
capability tests, both stores, browse conformance, episode tests, and
distillation tests.

- [x] **Step 10: Commit the memory split**

```bash
git add apps/web/content/docs/memory.mdx apps/web/content/docs/memory \
  apps/web/content/docs/persistence.mdx \
  apps/web/app/docs/memory apps/web/app/components/docs/docs-anchors.test.ts \
  apps/web/app/components/docs/nav.ts \
  apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "docs: split memory by developer task"
```

### Task 8: Extract reusable fixture and recording guidance

**Files:**
- Create: `apps/web/content/docs/testing-agents/fixtures.mdx`
- Create: `apps/web/app/docs/testing-agents/fixtures/page.tsx`
- Modify: `apps/web/content/docs/testing-agents.mdx`
- Modify: `apps/web/app/docs/testing-agents/page.tsx`
- Modify: `apps/web/app/components/docs/nav.ts`
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `scripts/check-docs.mjs`
- Test: `apps/web/app/components/docs/docs-anchors.test.ts`

- [x] **Step 1: Register Fixtures and Recording and capture the intended red**

Add Fixtures and Recording immediately after Agent Test Harness, extend the
exact registry test to the final 58 pages, and add the focused fixture row from
Task 1. Run nav/checker tests. Expected: red only for this page/wrapper and its
record/replay/live contract. Do not commit until the full 58-page discovery
lane is green.

- [x] **Step 2: Refocus the harness overview**

Retitle the page and wrapper to `Agent Test Harness`. Keep installation, the
first deterministic test, the fixture-script primer, matchers/assertions,
same-thread and reset examples, boundary choice, CI setup, scaffolded-app
example, and related links. Preserve the `test/agent.test.ts` app-root rule:

```ts
const appRoot = fileURLToPath(new URL("..", import.meta.url))
```

Keep the process-global aimock warning and awaited `h.close()`. Replace moved
fixture-file/live detail with concise compatibility headings:

```text
## Fixture files: author, commit, replay
### Author inline and snapshot to a file
### Record from a real model (local only)
### Replay a fixture file in tests
## Live mode (real model)
```

Each compatibility section links to Fixtures and Recording.

- [x] **Step 3: Write Fixtures and Recording**

Use this order:

1. choose inline fixtures versus a committed fixture file;
2. explain `script()` matching by user text, cumulative `turnIndex`, and
   `hasToolResult`;
3. author a `script()` and snapshot it with `writeFixtures`;
4. replay strictly with `loadFixtures` at harness or run scope;
5. integrated recording with `createAgentHarness({ record: true })`, one run,
   `getRecordedFixtures()`, and `writeFixtures(...)`;
6. the separate standalone `record({ out, provider? })` process, which launches
   the recorder and is not the same API as harness recording;
7. opt into `live: true` only for local prompt validation; it proxies real calls,
   registers no fixtures, requires `OPENAI_API_KEY`, and needs loose assertions;
8. CI rules and the fixture-drift check;
9. process-global aimock/environment constraints and awaited cleanup;
10. update workflow and troubleshooting.

State exactly which paths are relative to the test file versus process cwd.
Do not claim every test is offline: live and record modes are intentional,
explicit opt-ins. Never call live mode “proxy-record mode,” and never recommend
live model tests in CI.

- [x] **Step 4: Add the wrapper and anchor assertions**

Use title `Fixtures and Recording`. Extend `docs-anchors.test.ts` so the old
Agent Test Harness fixture/live anchors and the new canonical counterparts all
remain buildable.

- [x] **Step 5: Verify and review the testing slice**

Run:

```bash
pnpm --filter @dawn-ai/testing test
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
  test/docs-bundle.test.ts
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: testing package, final 58-page web/discovery/CLI coverage, anchors,
lint, typecheck, checker, and diff check pass. Request review against harness
and fixture-builder tests, especially `turnIndex`, reset, record/live mode,
environment restoration, and async teardown.

- [x] **Step 6: Commit the fixture split**

```bash
git add apps/web/content/docs/testing-agents.mdx \
  apps/web/content/docs/testing-agents/fixtures.mdx \
  apps/web/app/docs/testing-agents/page.tsx \
  apps/web/app/docs/testing-agents/fixtures/page.tsx \
  apps/web/app/components/docs/docs-anchors.test.ts \
  apps/web/app/components/docs/nav.ts \
  apps/web/app/components/docs/nav.test.ts scripts/check-docs.mjs
git commit -m "docs: extract agent fixture guidance"
```

### Task 9: Focus Configuration on exact schema and precedence

**Files:**
- Modify: `apps/web/content/docs/configuration.mdx`
- Modify: `apps/web/app/docs/configuration/page.tsx`
- Modify: `scripts/check-docs.mjs`
- Test: `apps/web/app/components/docs/docs-anchors.test.ts`

- [x] **Step 1: Add the focused-reference guard and capture red**

Add the Configuration row allocated in Task 1. Run the checker. Expected: red
for missing canonical operational links or stale `dawn start` environment
wording only; the 58-page topology remains green.

- [x] **Step 2: Retitle without weakening the complete example**

Use `# Configuration Reference` and matching metadata. Keep the complete
annotated `dawn.config.ts` example copyable and keep every public `DawnConfig`
field represented. Before editing, inventory the current schema from
`packages/core/src/config.ts` and turn the key list into a review checklist.

- [x] **Step 3: Tighten each key to contract, default, and canonical guide**

For `appDir`, backends, permissions, checkpointer, threads store, env,
tool-output offloading, summarization, memory, build, and sandbox, keep:

- the exact type/shape;
- the default and precedence;
- the operational caveat needed to avoid unsafe copying;
- one canonical guide link for setup/detail.

Remove duplicated tutorials now owned by Permissions, Context Management,
Long-term Memory, Deployment, Execution Sandbox, Persistence, and Production
Topology. Preserve the exact permission matching and persistence distinction:
reserved `tool`/`subagent` keys exact-match; resource paths, bash commands, and
memory scopes prefix-match; config maps stay in memory and do not seed the
runtime permissions store.

- [x] **Step 4: Reduce the Postgres section to a compatibility summary**

Keep `## Postgres backend` as an anchor-bearing summary with one minimal
configuration example and links to Persistence and Production Topology. Retain
these source-accurate points:

- checkpointer, thread store, and permission store are three explicit entries;
- the application owns the pool and tears it down after Dawn;
- `config.env` is loaded by dev/inspect flows, not by `dawn start`;
- the generated LangSmith target records an env-file path, not a list of
  variable names;
- shared persistence does not distribute active-run/cancel coordination.

- [x] **Step 5: Verify no schema field or anchor was lost**

Run:

```bash
pnpm --filter @dawn-ai/core test
pnpm --filter @dawn-ai/web exec vitest run app/components/docs/docs-anchors.test.ts
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: core tests, anchors, lint, and typecheck pass. Request review against
`DawnConfig`, config loading, the start command, deployment emitters, and all
three store factories. The reviewer must compare every inventoried key, not
only the prose that changed.

- [x] **Step 6: Commit the focused reference**

```bash
git add apps/web/content/docs/configuration.mdx \
  apps/web/app/docs/configuration/page.tsx \
  apps/web/app/components/docs/docs-anchors.test.ts scripts/check-docs.mjs
git commit -m "docs: focus configuration reference"
```

### Task 10: Tighten the monolithic application API reference

**Files:**
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `scripts/check-docs.mjs`
- Test: `apps/web/app/components/docs/docs-anchors.test.ts`

- [x] **Step 1: Inventory the existing public-reference anchors**

Before editing, extract every heading slug from `api.mdx` and save the current
exact 98 IDs in an API-specific assertion in `docs-anchors.test.ts`:

```bash
node --input-type=module - <<'NODE'
import { readFileSync } from "node:fs"
import GithubSlugger from "./apps/web/node_modules/github-slugger/index.js"

const source = readFileSync("apps/web/content/docs/api.mdx", "utf8")
const slugger = new GithubSlugger()
const ids = []
let inFence = false
for (const line of source.split("\n")) {
  if (line.trim().startsWith("```")) {
    inFence = !inFence
    continue
  }
  if (inFence) continue
  const match = /^(#{1,6})\s+(.+)$/.exec(line.trim())
  if (match?.[2]) ids.push(slugger.slug(match[2].replace(/`([^`]+)`/g, "$1")))
}
console.log(ids.length)
console.log(JSON.stringify(ids, null, 2))
NODE
```

Expected baseline: `98`. The test must require these IDs as a subset of the
final IDs, including duplicate-slug results such as `agentconfig-1`,
`assertidentifiername-value-1`, `example`, and `example-1`. Do not split this
page into package leaves in this pull request.

- [x] **Step 2: Add the new public-surface guard and capture red**

Add the API row allocated in Task 1 and extend the existing package-heading
guard for `@dawn-ai/cli` and `@dawn-ai/memory`. Run the checker and API anchor
test. Expected: red for the missing sections while all 98 legacy IDs remain.

- [x] **Step 3: Add a package table of contents and reference conventions**

At the top, add an ordered package/surface index and one short conventions
section explaining Node-only subpaths, edge-safe subpaths, generated types, and
where examples live. Keep signatures and return types in API Reference; replace
duplicated tutorial walkthroughs with links to the new journey pages. Classify
SDK, CLI root/fetch, Testing, Evals, and `dawn:routes` as application-facing;
Core, AG-UI, Memory, pgvector, and Postgres storage as lower-level
store/integration surfaces; and `@dawn-ai/cli/runtime` as tooling.

- [x] **Step 4: Document stable application-runtime exports**

Add an `## @dawn-ai/cli` section for the root exports `serveRuntime`,
`ServeRuntimeHandle`, `ServeRuntimeOptions`, `loadStaticModules`, and
`DawnStaticModules`. Add the edge-safe `@dawn-ai/cli/fetch` subsection for
`createRuntimeFetchHandler`, `RuntimeFetchHandler`, and the public static-module
builder/types. State resource ownership and rooted endpoint behavior precisely.

Add a short `@dawn-ai/cli/runtime` classification stub because the package
exports it, but label it a lower-level tooling surface and do not recommend it
for application embedding. Mention deprecated `shutdownController` only to
direct readers to await `close()`. Link Embed the Runtime for examples.

- [x] **Step 5: Document the core memory store and pure browse contract**

Add `## @dawn-ai/memory` with exact `MemoryStore`, `MemoryQuery`, `BrowseQuery`,
`BrowsePage`, `MemoryRecord`, and stats/prune signatures. Add a pure
`@dawn-ai/memory/browse` subsection for its exported validation, cursor, order,
range, constants, and types. Use package source and export maps as authorities,
not the stale duplicate comments in core capability types. Link agent recall to
Recall and Retrieval and admin listing to Browse and Manage Memory.

Keep the low-level browse boundary contract here rather than duplicating it in
the task guide: document the default limit of 50; trusted in-process larger
limits; the exported 1000-row maximum applying when an untrusted-boundary caller
passes `{ maxLimit }`; non-empty strings up to 1024 UTF-8 bytes; cursors up to
4096 characters; full millisecond UTC instants; at most eight filters and three
sort entries with one filter per field; cursor/offset compatibility; the exact
query-fingerprint included and excluded fields; and the `invalid-query` versus
`continuation-invalid` error identifiers.

- [x] **Step 6: Reconcile package coverage without broadening scope**

Keep the existing `@dawn-ai/sdk`, core, AG-UI, pgvector, Postgres storage,
testing, evals, and generated-route sections exact. Do not create new reference
pages for internal Vite, LangGraph, or LangChain packages. Update the checker’s
required package-heading list only for the two newly documented public
surfaces. Avoid introducing generic `### Example` headings before the existing
testing/evals examples, because that would renumber their retained fragments.

- [x] **Step 7: Verify signatures, old anchors, and package tests**

Run:

```bash
pnpm --filter @dawn-ai/cli test
pnpm --filter @dawn-ai/memory test
pnpm --filter @dawn-ai/web exec vitest run app/components/docs/docs-anchors.test.ts
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
node scripts/check-docs.mjs
git diff --check
```

Expected: CLI/memory tests, API anchor inventory, lint, typecheck, and all
API-specific checker rows pass. Request a signature-by-signature review against
package barrels, export maps, and public types before committing.

- [x] **Step 8: Commit the API reference tightening**

```bash
git add apps/web/content/docs/api.mdx \
  apps/web/app/components/docs/docs-anchors.test.ts scripts/check-docs.mjs
git commit -m "docs: tighten application API reference"
```

### Task 11: Publish the final navigation, titles, links, and discovery surfaces

**Files:**
- Modify: `apps/web/app/components/docs/nav.test.ts`
- Modify: `apps/web/app/components/docs/docs-anchors.test.ts`
- Modify: `apps/web/app/components/docs/search-index.test.ts`
- Modify: `apps/web/app/sitemap.test.ts`
- Modify: `apps/web/app/llms-full.txt/route.test.ts`
- Create: `apps/web/app/llms.txt/route.test.ts`
- Modify: `apps/web/app/llms.txt/route.ts`
- Modify: `packages/cli/test/docs-bundle.test.ts`
- Modify: `packages/cli/test/docs-command.test.ts`
- Modify: `scripts/check-docs.mjs`
- Modify: headings, metadata, cards, and links in the reconciliation file set
  listed in the file map

- [x] **Step 1: Extend the existing discovery tests for focused pages**

Add these explicit final assertions on top of the generic tests from Task 1:

- `search-index.test.ts`: one entry per final nav item, in nav order, with
  `{ href, title, section }` equal to nav; explicitly include `/docs/recipes`,
  `/docs/memory/long-term`, and `/docs/testing-agents/fixtures`.
- `sitemap.test.ts`: documentation URLs equal `DOCS_PAGES` exactly and in order;
  the redirect-only `/docs` URL is not emitted.
- `llms-full.txt/route.test.ts`: every nav page appears exactly once under its
  nav label and in nav order; verify both `recipes/index.mdx` and nested pages.
- `llms.txt/route.test.ts`: the curated map links Getting Started, Memory,
  Agent Protocol, Fixtures and Recording, Deployment Options, Persistence and
  Tenancy, Production Topology, Security Architecture, Configuration Reference,
  and API Reference.
- `packages/cli/test/docs-bundle.test.ts`: parse a nested-memory fixture, parse
  the real nav in order, and after build require one generated Markdown topic
  and file per nav entry, including nested and index pages.
- `packages/cli/test/docs-command.test.ts`: add a real-shaped nested
  `memory/long-term.md` topic beside the existing recipe/index fixture.

Extend Task 1's all-link test with the explicit compatibility-anchor map and
Task 10's 98 legacy API IDs. Every target path and supplied fragment must still
exist; external URLs and historical blog content remain excluded. Add the
inverse canonical-ownership assertion: maintained MDX outside an overview's own
stub may not link to a moved old fragment when the mapping names a focused
canonical destination.

Run the focused tests. Expected: the registry-driven assertions are already
green at 58 pages; the new compact-LLM, exhaustive internal-link, and explicit
CLI command cases begin red until the reconciliation below.

- [x] **Step 2: Audit the already-installed final registry**

Compare the current `DOCS_NAV` byte-for-byte in meaning with
`EXPECTED_DOCS_NAV` from this plan. It must already contain 58 pages from Tasks
2–8, preserve same-line `{ label, href }` literals, and omit `/docs`. If it
differs, correct the owning slice before continuing. Confirm `DOCS_PAGES` still
derives from the registry and remains the sole reading order for breadcrumbs,
previous/next, search, sitemap, LLM full text, and generated CLI docs.

- [x] **Step 3: Align every nav label, H1, and metadata title**

Use exact final titles for all new pages and normalize these existing pages:

| Path | Exact title |
|---|---|
| `/docs/ag-ui` | `AG-UI and Web Clients` |
| `/docs/testing` | `Scenario Testing` |
| `/docs/testing-agents` | `Agent Test Harness` |
| `/docs/evals` | `Evals` |
| `/docs/deployment` | `Deployment Options` |
| `/docs/sandbox` | `Execution Sandbox` |
| `/docs/recipes` | `Recipes Overview` |
| `/docs/recipes/add-a-tool` | `Add a Tool` |
| `/docs/recipes/typed-state` | `Typed State` |
| `/docs/recipes/auth-middleware` | `Auth Middleware` |
| `/docs/recipes/stream-output` | `Stream Output` |
| `/docs/recipes/retry-flaky-tools` | `Retry Transient Model Calls` |
| `/docs/recipes/dispatch-from-route` | `Dispatch from a Route` |
| `/docs/recipes/research-web-ui` | `Research Assistant Web UI` |
| `/docs/configuration` | `Configuration Reference` |
| `/docs/cli` | `CLI Reference` |
| `/docs/api` | `API Reference` |
| `/docs/errors` | `Error Codes` |

Audit the normalized titles from Task 2 and the exact titles on every new page.
Update any remaining visible RelatedCards and the research UI's AG-UI label.
Do not change URLs merely to match labels.

- [x] **Step 4: Refocus Getting Started and group the Recipes Overview**

Keep Getting Started to install/scaffold, the accurate file tour, offline
typegen/check/typecheck/tests/eval, and the first explicitly keyed live run.
Delete the entire `## 5. Ship it` deployment tutorial and its public-bind Docker
command; replace it with one short sentence linking Deployment Options and Node
and Docker. End with exactly three decision cards:

1. Mental Model — understand the application model;
2. Add a Tool — build the first feature;
3. Deployment Options — choose the production path.

On Recipes Overview, replace the flat list with four task groups without
inventing recipe pages:

- Build: Add a Tool, Typed State, Retry Transient Model Calls, Dispatch from a
  Route;
- Integrate: Auth Middleware, Stream Output, Research Assistant Web UI;
- Test: links to Scenario Testing, Agent Test Harness, and Fixtures and
  Recording;
- Deploy: links to Deployment Options, Node and Docker, and Kubernetes.

Keep the exact final recipe labels and make it clear that Test/Deploy point to
canonical guides rather than hidden recipe leaves.

Add file-specific guards: Getting Started must contain the two deployment links
and exactly three final decision-card titles, and must not contain
`## 5. Ship it` or `docker run -p 8000:8000`; Recipes Overview must contain
`## Build`, `## Integrate`, `## Test`, and `## Deploy` with every final recipe
label exactly once.

- [x] **Step 5: Repoint every internal deep link to its canonical owner**

Scan the entire normative docs/source set for old split-page anchors. At
minimum reconcile:

- deployment links from Getting Started, CLI, FAQ, Upgrading, Configuration,
  Context Management, and blueprint/recipe pages;
- Agent Protocol links from Routes, CLI, Planning, Subagents, Observability,
  recipes, and AG-UI;
- sandbox Kubernetes links from Access Control, Deployment, and sandbox-related
  examples;
- memory retrieval, episode, distillation, governance, and testing links from
  Inspector, Configuration, API, package READMEs, and the memory example;
- fixture/live links from Scenario Testing, Evals, API, and
  `packages/testing/README.md`.

Keep the compatibility headings at the old URLs, but make new and maintained
inbound links target the canonical page. Exclude historical blog posts from the
rewrite.

- [x] **Step 6: Update compact machine discovery**

Add a concise `## Documentation map` to `llms.txt` with the application path:
Getting Started → build/integrate/test → Persistence/Topology/Security → target
deployment, plus direct links to the memory chooser, embedding, configuration,
CLI, and API references. Preserve the already-correct runtime/auth/cancellation
warnings; do not turn the compact file into a duplicate of `llms-full.txt`.

- [x] **Step 7: Make the topology and discovery contract green**

Run:

```bash
pnpm --filter @dawn-ai/web test
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/cli build
pnpm --filter @dawn-ai/cli exec vitest run \
  test/docs-bundle.test.ts test/docs-command.test.ts
node scripts/check-docs.mjs
pnpm check:build-cache
git diff --check
```

Expected: the exact 58-page registry, bidirectional content/wrapper topology,
title sync, search, sitemap, LLM full output, generated CLI docs, anchor set,
accuracy contracts, lint, typecheck, and build-cache check all pass. Generated
`packages/cli/docs` output is ignored and must not be staged.

- [x] **Step 8: Request integrated navigation/discovery review**

Ask one reviewer to trace each registry consumer and another to audit title and
deep-link ownership. Resolve all Critical/Important findings, rerun Step 7, and
then commit.

- [x] **Step 9: Commit the published journey**

Stage the exact files reported by `git status --short`, inspect the staged file
list, and commit:

```bash
git diff --cached --name-status
git commit -m "docs: publish application developer journey"
```

Do not stage generated CLI docs or unrelated files.

### Task 12: Run independent content review, browser QA, and the full gate

**Files:**
- Modify only files required to resolve verified review or QA findings
- Update: this plan's checkboxes as each final gate completes

- [x] **Step 1: Dispatch three independent read-only reviews**

Give each reviewer the approved design, this plan, and the final diff, with
non-overlapping ownership:

1. information architecture, titles, compatibility anchors, discovery output,
   mobile navigation, and responsive prose;
2. persistence, topology, security, embedding, deployment, sandbox, and copied
   production commands;
3. memory, testing, configuration, API signatures, and source-linked claims.

Each reviewer reports only Critical/Important findings with exact file/line,
source authority, impact, and recommended correction. Resolve findings using
`@superpowers:receiving-code-review`; request re-review of each corrected slice.

- [x] **Step 2: Run the complete Node 24 verification lane before browser QA**

Start with a clean build because packages import generated `dist/` output:

```bash
export PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH"
node --version
pnpm --version
pnpm lint
pnpm check:build-cache
pnpm build
pnpm typecheck
pnpm test
node scripts/check-docs.mjs
BASE_REF=origin/main node scripts/check-changesets.mjs
git diff --check origin/main...HEAD
```

Expected: Node prints `v24.19.0`, pnpm prints `10.33.0`, and every command
passes. The final review added a publishable CLI typegen correction, so the
changeset check must accept the checked-in `@dawn-ai/cli` patch changeset. If
it reports otherwise, investigate the actual diff rather than bypassing the
check.

- [x] **Step 3: Run desktop and mobile browser QA**

Start the docs app in a persistent terminal session:

```bash
pnpm --filter @dawn-ai/web dev
```

Use the in-app browser at 1440×1000 and 390×844. Verify:

- `/docs` redirects to `/docs/getting-started`;
- desktop sidebar order and previous/next boundaries match the 58-page
  registry;
- mobile sections are collapsed except the active section, each summary is
  reachable by Tab and toggles with Enter and Space, the current page has
  `aria-current="page"`, and changing pages opens the new active section;
- long labels and inline code wrap without page-level horizontal overflow,
  while block code and tables still scroll inside their containers;
- representative new pages render: Persistence, Agent Protocol, Embedding,
  Long-term Memory, Browse and Manage Memory, Fixtures and Recording,
  Kubernetes, Edge and Hono, and Kubernetes Sandbox;
- every retained old deep anchor scrolls to its compatibility heading, while
  maintained cross-links target the canonical page;
- search finds nested pages and uses final labels/sections;
- Copy Markdown and Edit Source resolve both `/docs/recipes` and nested pages;
- `/sitemap.xml`, `/llms.txt`, and `/llms-full.txt` contain the new canonical
  pages without `/docs` as a duplicate canonical page.

Capture screenshots for desktop navigation, mobile navigation, a long inline
command, and one representative split page. Stop the dev server after QA. If
the required in-app browser is unavailable, pause and ask the user before using
another browser surface.

- [x] **Step 4: Run the repository's final all-in-one validation**

After all review and browser fixes, run from a clean working tree except for
the intended final corrections:

```bash
pnpm ci:validate
git diff --check origin/main...HEAD
git status --short
```

Expected: `pnpm ci:validate` passes, the branch diff has no whitespace errors,
and status contains only intended unstaged plan-checkbox or final-review edits.
Do not claim completion from the focused checks alone.

- [x] **Step 5: Commit final verified corrections and record evidence**

If review/QA produced changes, stage only those files, inspect the staged diff,
and commit them with a message describing the correction rather than a generic
cleanup. Mark completed plan checkboxes in a separate documentation commit so
the implementation diff remains reviewable. Re-run:

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline --decorate origin/main..HEAD
```

Expected: clean status, a readable commit series, and all design, plan, content,
shell, review-fix, and completion-record commits present. Do not push or open a
pull request until the user chooses that integration step.

**Completion evidence (2026-08-11):** Node `v24.19.0`, pnpm `10.33.0`, the
full 3,080-test source lane (2,871 passed, 209 skipped), docs contracts,
changesets, release checks, pack checks, TypeScript tooling-pack verification,
and all three framework/runtime/smoke harness lanes passed. In-app browser QA
passed at 1440×1000 and 390×844 with four captured screenshots; a search-palette
Escape regression found during QA was corrected and rechecked before the final
validation.
