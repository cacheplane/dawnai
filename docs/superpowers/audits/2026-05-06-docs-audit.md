# Dawn Docs Audit — 2026-05-06

**Status:** in progress
**Spec:** `docs/superpowers/specs/2026-05-06-docs-review-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-docs-review.md`

## Findings format

Each finding uses this schema:

```markdown
### F-NNN: <one-line summary>
- **Surface:** <surface>
- **File:** <path:line if applicable>
- **Type:** gap | misalignment | error | broken-example
- **Severity:** critical | important | minor
- **Description:** <what's wrong>
- **Suggested fix:** <concrete change, or "needs design">
```

Findings are numbered globally across all sections (F-001, F-002, ...). Each subagent claims a contiguous range and announces it in its closing summary so the next subagent picks up from F-(N+1).

## 1. Root README (`README.md`)

### F-001: README opening sentence omits agent execution and tools — Dawn's primary capability
- **Surface:** Root README
- **File:** README.md:3
- **Type:** misalignment
- **Severity:** important
- **Description:** The opening line describes Dawn as a framework for "filesystem-based route discovery, route validation, type generation, local route execution, and a local development runtime." This omits agent execution, route-local tool authoring, middleware, and `dawn build` for LangGraph Platform deployment artifacts — all currently shipping capabilities. The scaffold even ships an `agent()` route by default (see F-005), so describing Dawn purely as a route/runtime framework is misleading.
- **Suggested fix:** Update the opening to mention agent authoring (`agent()` descriptor), route-local tools, middleware, and the `dawn build` deployment-artifact path alongside discovery/typegen/dev.

### F-002: "Status" section says Dawn is not a deployment runtime, but `dawn build` produces LangGraph Platform deployment artifacts
- **Surface:** Root README
- **File:** README.md:5-7
- **Type:** misalignment
- **Severity:** important
- **Description:** The Status section asserts Dawn "is not a deployment runtime, not a LangSmith trace replacement, and not a hosted platform." This is technically still true (Dawn does not host or run production traffic), but it ignores the fact that `dawn build` (packages/cli/src/commands/build.ts) now exists specifically to emit `langgraph.json` + entry files for LangGraph Platform deployment. Readers will be confused when `dawn build` is missing from Commands and the Status disclaimer suggests deployment is out of scope.
- **Suggested fix:** Reword to "Dawn does not host or run production traffic. Dawn produces deployment artifacts (`dawn build`) for LangGraph Platform, which owns the runtime." Then add `dawn build` to the Commands section (see F-007).

### F-003: Quickstart `pnpm create dawn-app` invokes a non-existent npm package
- **Surface:** Root README
- **File:** README.md:14, 72
- **Type:** error
- **Severity:** critical
- **Description:** The README instructs users to run `pnpm create dawn-app my-dawn-app`. `pnpm create dawn-app` resolves to the npm package `create-dawn-app`, but the published package is `create-dawn-ai-app` (see packages/create-dawn-app/package.json line 2: `"name": "create-dawn-ai-app"`, and bin name `create-dawn-ai-app` on line 23). The Quickstart command will fail with a "package not found" error for any first-time user.
- **Suggested fix:** Replace both occurrences with `pnpm create dawn-ai-app my-dawn-app`. Also align CONTRIBUTORS.md (line 56) which has the same divergence — flag for the contributor doc audit.

### F-004: Scaffold route example documents `workflow`/`graph` exports but actual scaffold exports `agent`
- **Surface:** Root README
- **File:** README.md:40-50
- **Type:** misalignment
- **Severity:** critical
- **Description:** The App Contract section says a route's `index.ts` "exports either a `workflow` function or a `graph` function/object" and shows two snippets using those exports. But the basic template ships `index.ts` that does `export default agent({...})` (packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts). The discovery layer (packages/core/src/discovery/discover-routes.ts) actually accepts four kinds: `agent`, `workflow`, `graph`, and `chain` (RouteKind in packages/sdk/src/route-config.ts:1). A user reading this section and then opening the scaffold would be very confused — the scaffolded route does not match either pattern shown.
- **Suggested fix:** Add `agent` (the recommended/default) and `chain` to the supported exports list. Show the `agent({ model, systemPrompt })` form first since it is the scaffold's default. Keep the `workflow`/`graph` snippets for users who need lower-level control.

### F-005: README under-claims scaffold contents — omits `state.ts` and the default `agent` export
- **Surface:** Root README
- **File:** README.md:58-61
- **Type:** misalignment
- **Severity:** important
- **Description:** README says the basic scaffold ships `index.ts` and `tools/greet.ts`. The actual template (packages/devkit/templates/app-basic/) also ships `state.ts` (line 7 of the file listing). The README's own App Contract section even calls out that "Route directories may also include companion files such as `state.ts`," yet the scaffold listing omits it. Additionally the `index.ts` content is `export default agent({...})`, not the `workflow`/`graph` forms shown in the contract.
- **Suggested fix:** Add `src/app/(public)/hello/[tenant]/state.ts` to the bullet list. Optionally clarify that the scaffold uses an agent-style route (`export default agent(...)`).

### F-006: Commands section omits `dawn build` and `dawn verify` — both shipping commands
- **Surface:** Root README
- **File:** README.md:63-105
- **Type:** gap
- **Severity:** important
- **Description:** The Commands section documents `dawn check`, `dawn routes`, `dawn typegen`, `dawn run`, `dawn test`, and `dawn dev`. Two shipping commands are missing:
  - `dawn build` (packages/cli/src/commands/build.ts) — produces LangGraph Platform deployment artifacts in `.dawn/build/` (langgraph.json + per-route entry files).
  - `dawn verify` (packages/cli/src/commands/verify.ts) — runs four integrity checks (app, routes, typegen, deps) with optional `--json` output.
  The CLI registers all eight commands in packages/cli/src/index.ts:36-44. The "user-first command set" framing on line 65 does not justify omitting `dawn build` (which is the only path to deployment) or `dawn verify` (which is the canonical integrity gate).
- **Suggested fix:** Add `### dawn build` and `### dawn verify` sub-sections describing what each does. For `dawn build`, mention that it emits `langgraph.json` with `dependencies: ["."]` and the entry files referenced by `graphs`.

### F-007: Quickstart never mentions `dawn check`/`dawn typegen`/`dawn verify` despite Commands listing them
- **Surface:** Root README
- **File:** README.md:9-30
- **Type:** gap
- **Severity:** minor
- **Description:** The Quickstart goes from `pnpm install` straight to `dawn run`. A first-time user will hit cryptic errors if `dawn typegen` has not been run (the scaffolded `.dawn/dawn.generated.d.ts` ships pre-generated, but any added route requires regeneration). At minimum a `pnpm exec dawn check` step would surface validation issues before invocation, and `pnpm exec dawn typegen` would set expectations.
- **Suggested fix:** Add a step between install and run: "Validate the app and generate types: `pnpm exec dawn check && pnpm exec dawn typegen`." Or fold this into a single `dawn verify` invocation once that command is documented.

### F-008: README does not mention `agent()` descriptor, `retry`, middleware, or any new SDK surface
- **Surface:** Root README
- **File:** README.md (entire file, esp. App Contract and Packages)
- **Type:** gap
- **Severity:** critical
- **Description:** Recent feature work (per the audit context, dated 2026-05-05/2026-05-06) added several user-facing primitives that are now exported from `@dawn-ai/sdk` (packages/sdk/src/index.ts):
  - `agent()` descriptor with optional `retry: { maxAttempts, baseDelay }` (`AgentConfig`, `RetryConfig`, `DawnAgent`, `isDawnAgent`).
  - `defineMiddleware`, `reject(status, body?)`, `allow(context?)`, plus types `DawnMiddleware`, `MiddlewareRequest`, `MiddlewareResult`, `ContinueResult`, `RejectResult`.
  - Tools receive `middleware` context via `RuntimeContext`/`RuntimeTool`.
  None of these appear in the README. The Packages section describes `@dawn-ai/sdk` only as "the backend-neutral author-facing contract: types, helpers, runtime context, and tool authoring," which technically covers them but gives the reader nothing concrete. Since `agent()` is the default scaffold's export, this is a critical gap.
- **Suggested fix:** Add a short "Authoring agents" subsection under App Contract that shows `agent({ model, systemPrompt, retry: { maxAttempts, baseDelay } })`. Add a short "Middleware" subsection showing `defineMiddleware`, `reject`, and `allow` with a one-line description of `MiddlewareRequest`. Reference the website pages for full detail.

### F-009: App Contract claims `appDir` is "the only supported config option today" — accurate but tonally fragile
- **Surface:** Root README
- **File:** README.md:38
- **Type:** misalignment
- **Severity:** minor
- **Description:** The claim is currently true (packages/core/src/config.ts:90 only accepts `appDir`; the type at packages/core/src/types.ts:6 has `appDir?: string` as the only field). However the wording invites churn — every time a config option lands, this line needs editing. More importantly, it does not state the default value (`src/app`) inline, even though that default is documented one line earlier.
- **Suggested fix:** Reword to "`appDir` is the only currently supported config option, and it defaults to `src/app`." Cross-link to the dawn.config.ts docs page if/when it exists.

### F-010: Route directory "additional files" list says only `page.tsx` — omits `state.ts`, `run.test.ts`, and `tools/`
- **Surface:** Root README
- **File:** README.md:54-56
- **Type:** misalignment
- **Severity:** important
- **Description:** The README lists `page.tsx for UI routes` as the only additional file, but two paragraphs earlier (line 52) it acknowledges `state.ts` and `tools/*.ts`. The `dawn test` command (line 95-97) further depends on `run.test.ts` colocated next to `index.ts`. The "additional files" list is contradicted by the rest of the same section.
- **Suggested fix:** Expand the list to include `state.ts` (route state shape), `tools/*.ts` (route-local tools), `run.test.ts` (colocated scenarios), and `page.tsx` (UI). Mark each with one-line purpose.

### F-011: Packages section is missing `@dawn-ai/vite-plugin`
- **Surface:** Root README
- **File:** README.md:107-116
- **Type:** gap
- **Severity:** minor
- **Description:** The Packages section enumerates eight packages. The workspace also ships `@dawn-ai/vite-plugin` (packages/vite-plugin/ exists in the tree). Whether this is "internal-only" or user-facing should be made explicit; right now it is silently absent.
- **Suggested fix:** Either add a one-line bullet for `@dawn-ai/vite-plugin` describing its role, or add a sentence noting that internal-only packages are documented in CONTRIBUTORS.md. Coordinate with the internal-package-READMEs audit task.

### F-012: README does not link to website docs (getting-started, routes, tools, deployment)
- **Surface:** Root README
- **File:** README.md (overall)
- **Type:** gap
- **Severity:** important
- **Description:** The README contains a Quickstart and one inline link to CONTRIBUTORS.md, but never points readers at the website docs that cover routes, tools, state, deployment, dev-server, testing, etc. (the audit plan references getting-started.mdx, routes.mdx, tools.mdx, deployment.mdx). For a meta-framework, the README should be a launching pad to deeper docs, not a self-contained tutorial.
- **Suggested fix:** Add a "Documentation" section near the top (or replace the Quickstart's tail) with links to the canonical pages on the public docs site for routes, tools, state, deployment, dev server, and testing.

### F-013: "Current Boundaries" repeats Status disclaimers without adding new information
- **Surface:** Root README
- **File:** README.md:118-124
- **Type:** misalignment
- **Severity:** minor
- **Description:** Lines 118-124 restate "Dawn is not a deployment runtime" and "Dawn is not a LangSmith trace replacement" — both already stated in the Status section (lines 5-7). The third sentence ("starter template surface is intentionally small") is the only novel content. This duplication wastes readers' attention and amplifies the F-002 misalignment about deployment scope.
- **Suggested fix:** Either fold Current Boundaries into a single revised Status block (with the deployment-artifact correction from F-002) or drop it.

Root README findings: F-001 through F-013 (3 critical, 6 important, 4 minor).

## 2. Website load-bearing pages (`getting-started.mdx`, `routes.mdx`, `tools.mdx`, `deployment.mdx`)

### F-014: Getting Started uses `npx create-dawn-app` — package does not exist
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/getting-started.mdx:13
- **Type:** error
- **Severity:** critical
- **Description:** The Scaffold step says `npx create-dawn-app my-agent`. `create-dawn-app` is unpublished; the published package is `create-dawn-ai-app` (packages/create-dawn-app/package.json line 2: `"name": "create-dawn-ai-app"`; bin name `create-dawn-ai-app` on line 23). First-time users will hit a "package not found" error. Same divergence as F-003 in the README.
- **Suggested fix:** Replace with `npx create-dawn-ai-app my-agent` (or `pnpm create dawn-ai-app my-agent`). Align with whatever spelling PR A picks for the README.

### F-015: Getting Started lists three route entry kinds — Dawn supports four (`agent` is missing and is the scaffold default)
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/getting-started.mdx:38-43
- **Type:** misalignment
- **Severity:** critical
- **Description:** "Each route is a directory under `src/app/` with an `index.ts` that exports exactly one of: `workflow`, `graph`, `chain`." But `RouteKind` (packages/sdk/src/route-config.ts:1) is `"agent" | "chain" | "graph" | "workflow"`, and the discovery layer (packages/core/src/discovery/discover-routes.ts:112) explicitly accepts all four. The basic scaffold itself ships `export default agent({ model, systemPrompt })` (packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/index.ts), so the Getting Started flow is internally inconsistent: the user scaffolds, then reads a paragraph that claims their scaffolded route shape doesn't exist.
- **Suggested fix:** List all four kinds with `agent` first as the recommended/default. Reorder examples so the `agent({...})` form appears before the `workflow` form on this page.

### F-016: Getting Started claims "the scaffolded app uses a workflow export" — actually scaffolds an `agent` default export
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/getting-started.mdx:44-58
- **Type:** error
- **Severity:** critical
- **Description:** The page asserts the scaffold uses a `workflow` export and shows a sample `export async function workflow(state, ctx)` snippet. The actual basic template's `index.ts` is `export default agent({ model: "gpt-4o-mini", systemPrompt: "You are a helpful assistant for the {tenant} organization. Answer questions about the tenant." })`. There is no `workflow` function in the scaffold. A user opening the scaffolded `index.ts` after running through this page will see a completely different file from what is documented.
- **Suggested fix:** Replace the snippet with the actual scaffolded `agent(...)` body, then point readers to the routes page for `workflow`/`graph`/`chain` alternatives.

### F-017: Getting Started's run-output example shows a fake table and tenant resolution that the real `dawn run` does not produce
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/getting-started.mdx:77-88
- **Type:** error
- **Severity:** important
- **Description:** Documented output is a multi-row table (`Route /hello/[tenant]`, `Mode workflow`, `Tenant acme`, `✓ { greeting: "Hello, acme!" }`). Actual `runRunCommand` (packages/cli/src/commands/run.ts:96-101) prints the result via `JSON.stringify(payload, null, 2)` after reading state from stdin. There is no row-formatted table, no "Mode" line, and no tenant echo. Worse, the snippet implies `dawn run '/hello/acme'` alone resolves the tenant — but the command reads JSON from stdin (run.ts:42, 82-94), so the user must pipe state in, e.g. `echo '{"tenant":"acme"}' | dawn run '/hello/acme'`. The shown invocation will actually receive `null` input.
- **Suggested fix:** Show the real invocation form (pipe state via stdin) and the real JSON output. Either drop the pretty table or note it as an aspirational future format.

### F-018: Getting Started never mentions `dawn typegen`, `dawn check`, `dawn verify`, or `dawn build`
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/getting-started.mdx (overall)
- **Type:** gap
- **Severity:** important
- **Description:** The flow goes scaffold → write tool → `dawn run` → `dawn dev`. None of `dawn typegen` (regenerates `dawn.generated.d.ts`, mentioned later under tools), `dawn check` (validates app), `dawn verify` (4-check integrity gate), or `dawn build` (produces langgraph.json) appears. Several of these are needed before runs work cleanly, and `dawn build` is the only path to deployment.
- **Suggested fix:** Add a "Validate the app" step between scaffold and run: `dawn check && dawn typegen` (or `dawn verify`). Add a closing "Ship to production" pointer to `dawn build` and the deployment page.

### F-019: Getting Started "What's next" links to GitHub but not to other website docs
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/getting-started.mdx:100-104
- **Type:** gap
- **Severity:** important
- **Description:** The closing section sends readers to the GitHub repo and "the template code in src/app/" but never links to `/docs/routes`, `/docs/tools`, `/docs/state`, `/docs/deployment`, `/docs/cli`, `/docs/dev-server`, or `/docs/testing`. Routes/tools/deployment are direct sequels of this page. Without internal cross-links, users have no obvious path forward inside the docs site.
- **Suggested fix:** Replace or augment "What's next" with bullet links to `/docs/routes`, `/docs/tools`, `/docs/state`, and `/docs/deployment` at minimum.

### F-020: Getting Started omits the `agent()` descriptor, `retry`, middleware (`defineMiddleware`, `reject`, `allow`)
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/getting-started.mdx (overall)
- **Type:** gap
- **Severity:** critical
- **Description:** Per the audit context (2026-05-05/06), `agent({ model, systemPrompt, retry?: { maxAttempts, baseDelay } })`, `defineMiddleware`, `reject(status, body?)`, `allow(context?)`, and `MiddlewareRequest` are now exported from `@dawn-ai/sdk` (packages/sdk/src/index.ts:1-21, packages/sdk/src/agent.ts, packages/sdk/src/middleware.ts). The basic scaffold ships an `agent()` route by default, yet Getting Started never names this primitive. Users finishing the page have no model of what they just scaffolded.
- **Suggested fix:** Add a short "Authoring an agent" section that introduces `agent({ model, systemPrompt })` with the optional `retry` shape, then a one-line pointer to a future middleware page.

### F-021: Routes page lists three entry kinds — `agent` is missing
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/routes.mdx:3,11-43,46
- **Type:** error
- **Severity:** critical
- **Description:** The opening sentence says routes export "exactly one of three entry types: a `workflow` function, a LangGraph `graph`, or a LangChain `chain`." The `<Tabs>` block exposes only those three. The Callout claims `dawn check` enforces "exactly one of `workflow`, `graph`, or `chain`." Reality: `RouteKind` is four kinds (packages/sdk/src/route-config.ts:1) and discoverRoutes accepts `agent | workflow | graph | chain` (packages/core/src/discovery/discover-routes.ts:112). The scaffold default is an `agent` route. `dawn check` will gladly accept `agent` exports.
- **Suggested fix:** Lead the page with `agent` (since it is the scaffold default), then `workflow`, `graph`, `chain` as alternatives. Update the Callout to enumerate all four. Update the count in the opening line.

### F-022: Routes page Callout says `dawn check` enforces single-entry rule — discovery throws, not check
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/routes.mdx:45-47
- **Type:** misalignment
- **Severity:** minor
- **Description:** Callout: "A single `index.ts` may export only one of `workflow`, `graph`, or `chain`. `dawn check` enforces this." `dawn check` (packages/cli/src/commands/check.ts) just calls `discoverRoutes`, and the multi-export check is inside discovery (`packages/core/src/discovery/discover-routes.ts:108-113`), not check itself. `dawn run`, `dawn routes`, `dawn typegen`, `dawn build`, and `dawn verify` all surface the same error since they all call discovery. Wording is mostly harmless, but it under-claims where the rule lives.
- **Suggested fix:** Reword: "Discovery enforces this — `dawn check`, `dawn routes`, `dawn build`, and friends all surface the violation." Also update to include `agent` after F-021.

### F-023: Routes page state example uses a TypeScript `interface` — actual scaffold uses a default-exported Zod schema
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/routes.mdx:64-77
- **Type:** error
- **Severity:** critical
- **Description:** The State section shows `export interface HelloState { readonly tenant: string; readonly greeting?: string }`. The actual scaffold's `state.ts` (packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts) is `import { z } from "zod"; export default z.object({ context: z.string().default("") })`. The runtime state-discovery layer (packages/cli/src/lib/runtime/state-discovery.ts:11-30) imports `state.ts`'s default export and treats it as a schema with `extractDefaults`. A reader following the docs and writing an `interface` will produce a state.ts whose default-export-based discovery returns `null`, silently disabling state defaults. Same misalignment also implicit in getting-started.mdx:49 (the `HelloState` import).
- **Suggested fix:** Replace with the Zod default-export form. Note that dynamic-segment fields (`[tenant]`) appear automatically in state and are not declared in `state.ts`. Cross-reference state.mdx (which is the canonical state page).

### F-024: Routes page `dawn run` example omits stdin input, suggesting bare invocation works
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/routes.mdx:82-92
- **Type:** error
- **Severity:** important
- **Description:** Says `dawn run '/hello/acme'` "reads state from stdin (JSON)" — that text is correct (run.ts:82-94) — but the example shows the command alone with no pipe and no example payload. Users who copy this verbatim will pass `null` as input and get either a typegen mismatch or an unexpected null-state result. Same issue manifests in getting-started.mdx (F-017).
- **Suggested fix:** Show the working invocation: `echo '{"tenant":"acme"}' | dawn run '/hello/acme'` (or a heredoc). Mention that `[tenant]` resolves from the URL path *and* must match a state field per F-023.

### F-025: Routes page never mentions `agent()` or middleware — the user-facing primitives shipped 2026-05-05/06
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/routes.mdx (overall)
- **Type:** gap
- **Severity:** critical
- **Description:** This is the canonical routes page. It does not name `agent()`, `AgentConfig`, `RetryConfig`, `defineMiddleware`, `reject`, `allow`, or `MiddlewareRequest` — all currently exported from `@dawn-ai/sdk` (packages/sdk/src/index.ts) and recently added per the audit context. Since the scaffold default is `agent()`, an `agent` subsection on this page is mandatory.
- **Suggested fix:** Add an `## Agents` subsection covering `agent({ model, systemPrompt, retry? })` with the `RetryConfig` shape (`maxAttempts`, `baseDelay`). Add a `## Middleware` subsection covering `defineMiddleware`, `reject(status, body?)`, `allow(context?)`, and the `MiddlewareRequest` shape (assistantId, headers, method, params, routeId, url).

### F-026: Routes page does not link to `/docs/tools` (only inline reference) or to `/docs/state`, `/docs/cli`, `/docs/deployment`
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/routes.mdx:79-80
- **Type:** gap
- **Severity:** minor
- **Description:** One inline link to `/docs/tools` exists. The routes page mentions state and `dawn run` but does not link to `/docs/state` or `/docs/cli`. Adjacent pages exist (apps/web/content/docs/state.mdx, cli.mdx) so the cross-links would resolve.
- **Suggested fix:** Add cross-links to `/docs/state`, `/docs/cli` (for `dawn run`), and `/docs/deployment` at the bottom of the page.

### F-027: Tools page documents tool input only — the second `(input, ctx)` arg shape (signal + middleware) is invisible
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/tools.mdx:6-12,22-30,33-51
- **Type:** gap
- **Severity:** critical
- **Description:** The minimal tool example is `async (input: { ... }) => { ... }`. Per the audit context (2026-05-06), tools' second arg now has shape `{ middleware?: Readonly<Record<string, unknown>>, signal: AbortSignal }`. The runtime call sites confirm this: packages/cli/src/lib/runtime/dawn-context.ts:15-30 builds `{ signal, ...(middleware ? { middleware } : {}) }`; packages/langchain/src/tool-loop.ts:54 and packages/langchain/src/tool-converter.ts:31 pass that shape into `tool.run(input, {...})`. Tools authors that need cancellation or middleware-derived context have no way to discover this from the docs.
- **Suggested fix:** Document the second-argument shape: `async (input, { signal, middleware }) => { ... }`. Note that `signal` is always present (`AbortSignal`) and `middleware` is `Readonly<Record<string, unknown>>` populated by `defineMiddleware`/`allow(context)`. Add a one-tool example using `signal` for cancellation.

### F-028: Tools page "generated declaration" snippet is non-functional shorthand presented as real
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/tools.mdx:54-66
- **Type:** misalignment
- **Severity:** important
- **Description:** Shows:
  ```
  declare module "dawn:routes" {
    export type RouteTools<P> = DawnRouteTools[P]
    // greet signature inferred from tools/greet.ts export
  }
  ```
  `DawnRouteTools` is presented as if it were a real symbol, but the file is "roughly" what gets generated. Readers who try to import `DawnRouteTools` will fail. The actual generated file (renderDawnTypes in packages/core/src) emits a populated `RouteTools` map with concrete pathnames as keys. The current snippet is too lossy to be useful and too detailed to be obviously sketch.
- **Suggested fix:** Either (a) show the real shape Dawn emits — e.g. `declare module "dawn:routes" { export type RouteTools<P extends keyof DawnRouteTypes> = DawnRouteTypes[P]["tools"] }` with a concrete entry — or (b) drop the code block and point users at running `dawn typegen` and reading their own `dawn.generated.d.ts`.

### F-029: Tools page invocation example uses unannotated `state, ctx` — relies on the `workflow` form contradicted by Routes/Getting-Started fixes
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/tools.mdx:22-28
- **Type:** misalignment
- **Severity:** minor
- **Description:** The "Invoking a tool" snippet shows `export async function workflow(state, ctx) { ... }` with no type annotations. In a strict TS config (every Dawn-generated app turns on strict), this would be `noImplicitAny` errors. The bigger problem: it is the `workflow` form, but per F-015/F-021 the recommended scaffold shape is `agent()`. Tool invocation from inside an `agent()` route happens via tool binding at build (packages/cli/src/commands/build.ts:80-106), not via `ctx.tools` in user code. The page never explains this branching.
- **Suggested fix:** Add types to the snippet. Add a one-paragraph note: "Inside `workflow` and `graph` exports, tools are invoked through `ctx.tools.<name>(...)`. Inside `agent()` routes, Dawn binds the tools to the agent at `dawn build` time and the LLM invokes them — see Routes." Cross-link to /docs/routes.

### F-030: Tools page never mentions `dawn typegen` outputs `.dawn/routes/<id>/tools.json` or interplay with `dawn dev` watcher
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/tools.mdx:14-18,68-72
- **Type:** gap
- **Severity:** minor
- **Description:** The page says types appear "on the next `dawn typegen` or `dawn dev` reload." Accurate, but skipped: `dawn build` (packages/cli/src/commands/build.ts:60) consumes `tools.json` schemas, and the dev server invalidates per-route state on tool-file change. Authors debugging "my tool isn't appearing" would benefit from a note that the type pipeline produces both `.dawn/dawn.generated.d.ts` and per-route `.dawn/routes/<slug>/tools.json`.
- **Suggested fix:** Add a sentence under "The generated declaration" explaining that typegen also writes per-route `tools.json` artifacts under `.dawn/routes/`, consumed by `dawn build` for LangGraph Platform deployment.

### F-031: Deployment page tells users to hand-write `langgraph.json` — `dawn build` exists and produces it for them
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx:28-41
- **Type:** error
- **Severity:** critical
- **Description:** Step 3 instructs users to "Create a `langgraph.json` at the app root" by hand. But `dawn build` (packages/cli/src/commands/build.ts:32-153) writes `.dawn/build/langgraph.json` automatically with `graphs`, `dependencies: ["."]`, `env` (path string from extractDeploymentConfig — `.env.example` if present, else `.env`), and `node_version: "22"` (packages/cli/src/lib/build/deployment-config.ts:18-24). It also generates per-route entry files under `.dawn/build/<slug>.ts` and (for `agent` routes) handles tool binding via `agent.bindTools([...])` (build.ts:104). Telling users to hand-write the JSON in 2026 is a critical user-experience regression: they will produce something that misses the entry-file generation `dawn build` does for them.
- **Suggested fix:** Replace Step 3 with `dawn build` (clean form `dawn build --clean`). Show a sample of the generated `.dawn/build/langgraph.json` so users know what to expect, and explain the merge behavior with a user-supplied root `langgraph.json` (build.ts:124-142 reads and shallow-merges).

### F-032: Deployment page sample `langgraph.json` is missing `dependencies` and `node_version` — both required for LangGraph Platform
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx:31-38
- **Type:** error
- **Severity:** critical
- **Description:** The sample shows only `{ "graphs": ..., "env": ".env" }`. The real `dawn build` output (packages/cli/src/lib/build/deployment-config.ts:18-24, used at packages/cli/src/commands/build.ts:136-142) emits `dependencies: ["."]`, `env`, and `node_version: "22"`. LangGraph Platform requires `dependencies` and `node_version`. A user copying the documented sample will fail to build a deploy image. Also note that `env` resolves to `.env.example` when that file exists, not `.env` blindly (deployment-config.ts:26-34).
- **Suggested fix:** Replace the sample with the actual `dawn build` output, including `dependencies: ["."]`, `env: ".env.example"` (or `.env`), and `node_version: "22"`. Cross-reference: F-031 (use `dawn build`), and the audit context's note that `dawn build` produces `langgraph.json` with `dependencies: ["."]` and `env` as a path.

### F-033: Deployment page shows non-existent `dawn test --url` flag
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx:21-24
- **Type:** error
- **Severity:** critical
- **Description:** Step 2 says `dawn test --url http://127.0.0.1:3001`. `runTestCommand` (packages/cli/src/commands/test.ts:34-41) registers only `--cwd <path>`. There is no `--url` option on `dawn test`. The `--url` flag exists on `dawn run` (packages/cli/src/commands/run.ts:29) and scenario files can declare a `run.url` field (packages/cli/src/lib/runtime/load-run-scenarios.ts:278), but `dawn test --url` will fail with "unknown option" from commander. This breaks the documented protocol-parity step.
- **Suggested fix:** Either (a) replace with `dawn run` examples that use `--url`, or (b) document scenario-level `run: { url }` configuration in the test file and how to point all scenarios at a live server. Until parity tooling exists for `dawn test`, mark this step as "use scenario-level `run.url`."

### F-034: Deployment page does not enumerate `dawn verify`'s four checks (app, routes, typegen, deps)
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx:7-16
- **Type:** gap
- **Severity:** important
- **Description:** Step 1 lists four pre-deploy commands: `dawn check`, `dawn routes`, `dawn typegen`, `dawn test`. None is `dawn verify`. Per the audit context (2026-05-06), `dawn verify` runs four checks (app, routes, typegen, deps — packages/cli/src/commands/verify.ts:162-218) and is the canonical integrity gate. Re-running four shell commands manually duplicates what `dawn verify` does in one call, and importantly skips the `deps` check (missing packages, missing env vars) which is most relevant pre-deploy.
- **Suggested fix:** Replace the four-command list in Step 1 with `dawn verify`, optionally followed by `dawn test` for scenarios. Mention that verify includes a deps check that is uniquely useful before a deploy.

### F-035: Deployment page never mentions `dawn build` anywhere — the only path to a deployable artifact
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx (overall)
- **Type:** gap
- **Severity:** critical
- **Description:** `dawn build` does not appear once on the deployment page. It is the command that produces deployable artifacts (langgraph.json + per-route entry files). Self-hosting (lines 53-58) tells users to "wrap Dawn's runtime in a Docker container" — but the canonical container starts from `dawn build` output, not from `dawn dev`'s in-process server. Telling users to ship `dawn dev` in production is misleading and contradicts the build pipeline that exists today.
- **Suggested fix:** Restructure the page around `dawn build` as the central command. Self-hosting section should reference the `.dawn/build/` directory and show how to feed it to a container build, not "ship dawn dev."

### F-036: Deployment page assistant-id format is wrong — `dawn build` emits `<routeId>#<kind>`, not the route name
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx:32-40,62-66
- **Type:** error
- **Severity:** important
- **Description:** Sample maps `"hello"` → entry path. Then "Each entry binds an `assistant_id` (left side) to a route entry export (right side)." The actual `dawn build` output keys assistants as `${route.id}#${route.kind}` (packages/cli/src/commands/build.ts:119-121), e.g. `/hello/[tenant]#agent`. Troubleshooting says "the `langgraph.json` entry doesn't match what Dawn discovered. Run `dawn routes` to see the exact pathnames" — but `dawn routes` prints `<pathname> -> <entryFile>` (packages/cli/src/commands/routes.ts:33-35), not assistant ids. So users who copy the docs and key on a freeform name like `"hello"` will then debug-loop against `dawn routes` output that doesn't show assistant-id format either.
- **Suggested fix:** Document the real assistant-id naming `<routeId>#<kind>`. Either show that as the key in the sample, or remove the sample entirely in favor of "run `dawn build` and inspect `.dawn/build/langgraph.json`." Update the troubleshooting bullet to point at `cat .dawn/build/langgraph.json` (or `dawn verify --json`) rather than `dawn routes`.

### F-037: Deployment page Step 2 "live-server tests" claim implies dev server is identical to LangGraph Platform — true only at protocol level
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx:18-26,57-59
- **Type:** misalignment
- **Severity:** important
- **Description:** "If in-process and live-server tests both pass, the same inputs will pass on LangGraph Platform" — and the closing tip "`dawn dev` running on port 3001 is functionally identical to a deployed Dawn runtime" — overstate parity. Dev server (packages/cli/src/lib/dev/runtime-server.ts) only handles `/runs/wait` and `/runs/stream` (lines 124-135) and uses an in-process runtime registry (line 117). The deployed LangGraph Platform invokes the entry files generated by `dawn build` (built with `agent.bindTools(...)` for agent routes, build.ts:104), serialized through their Docker boundary, with platform-managed state stores. Tools that pass in dev because they share a process can fail in deploy due to serialization. F-031/F-035 amplify this — the dev-only path skips `dawn build`'s codegen entirely.
- **Suggested fix:** Soften: "`dawn dev` exposes the same protocol endpoints as the deployed runtime — `runs/wait` and `runs/stream` — so request/response shape parity is guaranteed. Process boundaries, state persistence, and tool bindings are still re-materialized by `dawn build` for production." Then keep the JSON-serializability reminder.

### F-038: Deployment page makes no reference to `defineMiddleware` / `MiddlewareRequest` — middleware is invisible end-to-end
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/deployment.mdx (overall)
- **Type:** gap
- **Severity:** important
- **Description:** Middleware (packages/sdk/src/middleware.ts; runtime usage in packages/cli/src/lib/dev/runtime-server.ts:117,257) is a per-request authorization/context primitive that ships today. Deployment is exactly the moment a developer asks "how do I gate access in production?" — but the page never mentions middleware. Compounded by F-025 (routes.mdx omits it too), middleware is a dark feature.
- **Suggested fix:** Add a brief "Per-route middleware" subsection pointing at `defineMiddleware`/`reject`/`allow` and noting that middleware runs identically in `dawn dev` and on LangGraph Platform.

### F-039: Getting Started, Routes, Tools, and Deployment all assume "no Zod schemas" while the scaffold's `state.ts` ships Zod
- **Surface:** Website (load-bearing)
- **File:** apps/web/content/docs/tools.mdx:1-3, getting-started.mdx:73, routes.mdx:64-77
- **Type:** misalignment
- **Severity:** important
- **Description:** Tools page opening: "no Zod schemas, no manual type wiring." Repeated at line 13: "No Zod schemas, no manual type declarations." Getting-started.mdx:73 echoes this. But the scaffolded `state.ts` (packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts) is `z.object({...})`, and state-discovery (packages/cli/src/lib/runtime/state-discovery.ts) requires Zod schemas to extract defaults. The "no Zod" claim applies only to *tool inputs* via TS-compiler-API extraction, but reads as if Zod is absent system-wide. Users will be confused when state needs Zod but tools don't.
- **Suggested fix:** Tighten the claim: "Tool input/output types are inferred from TypeScript source — no Zod schemas required for tools." Acknowledge that route state uses Zod (in state.mdx and a one-line note here).

Load-bearing pages findings: F-014 through F-039 (12 critical, 10 important, 4 minor).

## 3. Website supporting pages (`state.mdx`, `cli.mdx`, `dev-server.mdx`, `testing.mdx`)

_(pending — Task 4)_

## 4. Templates (`AGENTS.md`, `CLAUDE.md`)

_(pending — Task 5)_

## 5. Public package READMEs (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`)

_(pending — Task 6)_

## 6. Internal package READMEs (config-biome, config-typescript, core, devkit, langchain, langgraph, vite-plugin)

_(pending — Task 7)_

## Summary

_(pending — populated at the findings cut after Tasks 2–7)_
