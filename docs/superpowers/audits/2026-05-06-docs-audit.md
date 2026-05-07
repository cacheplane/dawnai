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

_(pending — Task 3)_

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
