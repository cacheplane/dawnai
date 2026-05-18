# Content Accuracy Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all user-facing Dawn website, docs, prompt, package README, changelog, template, and public-comment content back in line with the actual repo behavior as of May 18, 2026.

**Architecture:** Treat source code and tests as the authority for behavior, and treat public docs/prompts/templates as derived communication surfaces. Fix high-risk incorrect instructions first, then align terminology, generated-artifact paths, package API references, and long-lived docs guardrails.

**Tech Stack:** TypeScript, Next.js 16 App Router, MDX docs, pnpm workspaces, Commander CLI, Vitest, Node.js 22.12+.

---

## Audit Inputs

The plan is based on four audit passes:

- Website/UI generated content audit: landing copy, docs shell, generated `llms.txt`, route handlers, links, blog visibility.
- Long-form content audit: `apps/web/content/docs`, `apps/web/content/blog`, prompt bodies, AGENTS template.
- Package/API audit: package READMEs, changelogs, SDK/CLI public comments and strings.
- Local coordinator pass: package manifests, CLI command definitions, generated artifact paths, official external spot checks for model/protocol terminology.

No P0s were found. P1 issues are concentrated around docs that teach users commands or APIs that do not exist or do not behave as described.

## File Structure

Modify:
- `apps/web/content/docs/routes.mdx` - route export forms and run examples.
- `apps/web/content/docs/state.mdx` - actual state/default/dynamic segment behavior.
- `apps/web/content/docs/mental-model.mdx` - route path and middleware mental model.
- `apps/web/content/docs/cli.mdx` - command flags, output examples, typegen/build descriptions.
- `apps/web/content/docs/dev-server.mdx` - request envelopes, route_path contract, shutdown/logging claims.
- `apps/web/content/docs/deployment.mdx` - build output, middleware support, LangSmith parity language.
- `apps/web/content/docs/middleware.mdx` - global dev-runtime middleware scope.
- `apps/web/content/docs/agents.mdx` - provider and retry caveats.
- `apps/web/content/docs/retry.mdx` and `apps/web/content/docs/recipes/retry-flaky-tools.mdx` - route-level retry and streaming caveats.
- `apps/web/content/docs/tools.mdx` - generated artifact paths and tool guidance.
- `apps/web/content/docs/api.mdx` - SDK API reference drift.
- `apps/web/content/docs/faq.mdx` and `apps/web/content/docs/migrating-from-langgraph.mdx` - stale examples and broad claims.
- `apps/web/content/docs/recipes/*.mdx` - stale route_path, testing, and tool examples.
- `apps/web/content/prompts/index.ts` - agent-facing prompt bodies.
- `apps/web/content/templates/AGENTS.md` - agent-consumable repo guidance.
- `apps/web/app/llms.txt/route.ts` and `apps/web/app/llms-full.txt/route.ts` - generated agent docs.
- `apps/web/app/components/**/*.{ts,tsx}` - landing/header/footer/links/copy where stale.
- `apps/web/content/blog/*.mdx` - version claims, future-dated release content, stale APIs.
- `README.md`, `CONTRIBUTORS.md`, `SUPPORT.md`, `.github/ISSUE_TEMPLATE/config.yml` - root entrypoint commands and public links.
- `docs/brand/README.md`, `docs/brand/recording-guide.md`, `docs/brand/quickstart.tape`, `docs/brand/capture-fixture.mjs` - recording/brand workflow docs that users may follow.
- `docs/thread-handoff.md`, `docs/next-iterations-roadmap.md` - mark as internal history or update stale public claims if linked.
- `packages/*/README.md`, `packages/*/CHANGELOG.md` - package-facing copy.
- `packages/sdk/src/agent.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/route-types.ts` - public comments and missing type export decisions.
- `packages/cli/src/lib/runtime/load-run-scenarios.ts`, `packages/cli/src/lib/typegen/run-typegen.ts`, `packages/vite-plugin/src/index.ts`, template comments - public or semi-public comments/errors.
- `packages/devkit/templates/app-basic/**` - generated user-facing starter content.
- `scripts/check-docs.mjs` or new focused doc-check script - automated drift checks.

Code fix required before docs can honestly promise deployment:
- `packages/cli/src/commands/build.ts` - current build output for `export default agent(...)` appears incompatible with SDK descriptors because generated entries import named `agent` and call `.bindTools()`. Fix this in Task 3 before retaining “deployable LangSmith artifacts” copy.

## Task 1: Fix Route And Runtime Contract Docs

**Files:**
- Modify: `apps/web/content/docs/routes.mdx`
- Modify: `apps/web/content/docs/state.mdx`
- Modify: `apps/web/content/docs/mental-model.mdx`
- Modify: `apps/web/content/docs/cli.mdx`
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: `apps/web/content/docs/recipes/stream-output.mdx`
- Modify: `apps/web/content/docs/recipes/dispatch-from-route.mdx`
- Modify: `apps/web/content/templates/AGENTS.md`
- Test: `packages/cli/test/run-command.test.ts`
- Test: `packages/core/test/discover-routes.test.ts`

- [ ] **Step 1: Confirm route discovery/export rules from tests**

Run:

```bash
pnpm exec vitest --run --config packages/core/vitest.config.ts packages/core/test/discover-routes.test.ts
```

Expected: PASS, and the tests confirm only branded default `agent()` exports are default-route entries while `workflow`, `graph`, and `chain` are named route exports.

- [ ] **Step 2: Replace unsupported default-export graph/chain examples**

Use this shape wherever docs show graph or chain route entries:

```ts
export const graph = builder.compile()
```

```ts
export const chain = prompt.pipe(model)
```

Do not show `export default graph` or `export default chain`.

- [ ] **Step 3: Replace concrete `dawn run '/hello/acme'` examples**

Use the actual supported parameterized route id:

```bash
echo '{"tenant":"acme"}' | dawn run '/hello/[tenant]'
```

Where docs need a file target, use the relative entry file path if supported by the resolver:

```bash
echo '{"tenant":"acme"}' | dawn run 'src/app/(public)/hello/[tenant]/index.ts'
```

- [ ] **Step 4: Correct `metadata.dawn.route_path` examples**

Change request envelopes from concrete paths to the relative entry-file path expected by runtime resolution:

```json
{
  "assistant_id": "/hello/[tenant]#agent",
  "input": { "tenant": "acme" },
  "metadata": {
    "dawn": {
      "route_path": "src/app/(public)/hello/[tenant]/index.ts"
    }
  }
}
```

- [ ] **Step 5: Rewrite state docs around observed behavior**

Document:
- `state.ts` is optional.
- Dynamic segment values are not parsed out of concrete `dawn run` path strings today.
- Workflow output is returned directly unless runtime code says otherwise.
- State defaults and reducers must be described only where verified for that route kind.

- [ ] **Step 6: Run targeted verification**

Run:

```bash
pnpm exec vitest --run --config packages/cli/vitest.config.ts packages/cli/test/run-command.test.ts
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

## Task 2: Fix Middleware, Provider, Retry, And Production Claims

**Files:**
- Modify: `apps/web/content/docs/middleware.mdx`
- Modify: `apps/web/content/docs/deployment.mdx`
- Modify: `apps/web/content/docs/dev-server.mdx`
- Modify: `apps/web/content/docs/agents.mdx`
- Modify: `apps/web/content/docs/retry.mdx`
- Modify: `apps/web/content/docs/recipes/retry-flaky-tools.mdx`
- Modify: `apps/web/content/docs/faq.mdx`
- Modify: `apps/web/content/docs/migrating-from-langgraph.mdx`
- Modify: `apps/web/app/components/landing/Ecosystem.tsx`
- Modify: `apps/web/app/components/landing/KeepTheRuntime.tsx`
- Test: `packages/cli/test/middleware.test.ts`
- Test: `packages/langchain/test/agent-adapter-retry.test.ts`

- [ ] **Step 1: Verify middleware scope**

Run:

```bash
pnpm exec vitest --run --config packages/cli/vitest.config.ts packages/cli/test/middleware.test.ts
```

Expected: PASS. Use results plus `packages/cli/src/lib/dev/middleware.ts` as authority.

- [ ] **Step 2: Narrow middleware docs**

Say middleware is currently a single global app-level file loaded by the Dawn dev runtime. Do not claim nearest route-tree middleware or identical LangSmith production execution unless code/build output supports it.

- [ ] **Step 3: Narrow provider claims**

Document the current split:
- `agent({ model })` is materialized through the current LangChain agent path and is OpenAI-backed today.
- Raw `graph` and `chain` routes can use any provider the user wires themselves.
- `KnownModelId` is autocomplete plus arbitrary string fallback, not a guarantee that Dawn has a first-party adapter for every provider.

- [ ] **Step 4: Narrow retry claims**

Document route-level retry and streaming caveats. Remove per-tool retry override claims unless an API exists. If docs mention `baseDelay`, verify both streaming and non-streaming behavior first.

- [ ] **Step 5: Soften unsupported production parity language**

Replace broad claims such as “byte-identical,” “guaranteed parity,” and “what works locally works in production” with scoped language tied to the actual `/runs/wait`, `/runs/stream`, and `assistant_id` surface.

- [ ] **Step 6: Run targeted verification**

Run:

```bash
pnpm exec vitest --run --config packages/langchain/vitest.config.ts packages/langchain/test/agent-adapter-retry.test.ts
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

## Task 3: Fix Generated Artifact And Build Output Documentation

**Files:**
- Modify: `apps/web/content/docs/tools.mdx`
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `apps/web/content/docs/cli.mdx`
- Modify: `apps/web/content/docs/deployment.mdx`
- Modify: `apps/web/content/docs/migrating-from-langgraph.mdx`
- Modify: `apps/web/content/templates/AGENTS.md`
- Modify: `apps/web/app/llms.txt/route.ts`
- Modify: `packages/sdk/src/route-types.ts`
- Modify: `packages/cli/src/lib/typegen/run-typegen.ts`
- Test: `packages/cli/test/run-typegen.test.ts`

- [ ] **Step 1: Verify artifact paths**

Run:

```bash
pnpm exec vitest --run --config packages/cli/vitest.config.ts packages/cli/test/run-typegen.test.ts
```

Expected: PASS and confirms `.dawn/dawn.generated.d.ts`, `.dawn/routes/<routeSlug>/tools.json`, and `.dawn/routes/<routeSlug>/state.json`.

- [ ] **Step 2: Standardize all generated type references**

Use:

```text
.dawn/dawn.generated.d.ts
.dawn/routes/<routeSlug>/tools.json
.dawn/routes/<routeSlug>/state.json
```

Remove references to root `dawn.generated.d.ts` and `.dawn/generated/route-tools.d.ts` unless code is changed to actually emit them.

- [ ] **Step 3: Correct `langgraph.json` examples**

Use `:graph` for generated build entries:

```json
{
  "graphs": {
    "/hello/[tenant]#agent": "./.dawn/build/hello-tenant.ts:graph"
  },
  "dependencies": ["."],
  "env": ".env",
  "node_version": "22"
}
```

- [ ] **Step 4: Correct merge-order language**

State that user `langgraph.json` is read first and generated `graphs`, `dependencies`, `env`, and `node_version` override those keys.

- [ ] **Step 5: Fix `dawn build` agent output for canonical SDK agents**

Write a failing build test proving generated entries work for the canonical starter route:

```ts
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are helpful.",
})
```

Then fix `packages/cli/src/commands/build.ts` so generated artifacts do not import a nonexistent named `agent` from the route module and do not call `.bindTools()` on a plain SDK descriptor. After this passes, keep deployment docs that promise `dawn build` emits deployable artifacts. If this code fix is intentionally deferred, the same PR must narrow deployment docs so they do not promise unsupported agent build output.

Run after implementation:

```bash
pnpm exec vitest --run --config packages/cli/vitest.config.ts packages/cli/test/deployment-config.test.ts
pnpm exec vitest --run --config packages/create-dawn-app/vitest.config.ts
```

Expected: PASS. If code is not fixed in this task, docs must explicitly avoid promising deployability for unsupported route shapes.

## Task 4: Regenerate API Reference And Package API Docs

**Files:**
- Modify: `apps/web/content/docs/api.mdx`
- Modify: `packages/sdk/README.md`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/agent.ts`
- Modify: `packages/sdk/src/known-model-ids.ts`
- Modify: `packages/cli/README.md`
- Modify: `packages/create-dawn-app/README.md`
- Modify: `packages/langchain/README.md`
- Modify: `packages/langgraph/README.md`
- Modify: `packages/vite-plugin/README.md`
- Test: `packages/sdk/test/agent-config.test.ts`
- Test: `packages/sdk/test/known-model-ids.test.ts`

- [ ] **Step 1: Verify SDK public surface**

Run:

```bash
pnpm exec vitest --run --config packages/sdk/vitest.config.ts packages/sdk/test/agent-config.test.ts packages/sdk/test/known-model-ids.test.ts
```

Expected: PASS.

- [ ] **Step 2: Document current `AgentConfig` and `DawnAgent` shape**

The API reference must include:

```ts
export interface AgentConfig {
  readonly description?: string
  readonly model: KnownModelId
  readonly reasoning?: ReasoningConfig
  readonly retry?: RetryConfig
  readonly subagents?: readonly DawnAgent[]
  readonly systemPrompt: string
}
```

If `ReasoningConfig` is intended to be public, export it from `packages/sdk/src/index.ts`. If it remains indirectly public only, say that explicitly.

- [ ] **Step 3: Correct model-id wording**

Say `KnownModelId` provides autocomplete for listed OpenAI/Google IDs plus an arbitrary string fallback. Do not imply every listed ID is handled by every Dawn route kind.

External spot-check sources:
- OpenAI model and reasoning docs: `https://platform.openai.com/docs/models`, `https://platform.openai.com/docs/api-reference/responses-streaming/response/reasoning`
- Google Gemini model docs: `https://ai.google.dev/gemini-api/docs/models`

- [ ] **Step 4: Update package READMEs**

For each published package, choose one:
- Document the exported API enough for users.
- Mark it explicitly as internal/unsupported despite being published.

Minimum updates:
- `@dawn-ai/cli`: explain actual `verify`, `build`, and command flags.
- `create-dawn-ai-app`: document required target directory plus `--template`, `--mode`, and `--dist-tag` if public.
- `@dawn-ai/sdk`: include `reasoning`, `description`, `subagents`, maps, middleware result types, `BackendAdapter`, and `@dawn-ai/sdk/testing`.

- [ ] **Step 5: Run verification**

Run:

```bash
pnpm --filter @dawn-ai/sdk typecheck
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

## Task 5: Rewrite Public Prompts And Agent-Consumable Content

**Files:**
- Modify: `apps/web/content/prompts/index.ts`
- Modify: `apps/web/content/templates/AGENTS.md`
- Modify: `apps/web/app/llms.txt/route.ts`
- Modify: `apps/web/app/llms-full.txt/route.ts`
- Modify: `apps/web/app/prompts/[slug]/route.ts` only if response semantics need metadata/status.
- Test: `scripts/check-docs.mjs`
- Test: add or modify tests for prompt content if available.

- [ ] **Step 1: Rewrite scaffold prompt**

Use actual package command:

```bash
pnpm create dawn-ai-app my-agent
```

or:

```bash
npx create-dawn-ai-app my-agent
```

Do not use `npx create-dawn-app`.

- [ ] **Step 2: Rewrite route/tool/test prompts**

Remove stale content:
- `dawn test --url`
- `describe` / `test` style scenario examples if actual scenario files default-export arrays.
- `expected` if actual key is `expect`.
- `tools` mocks unless implemented.
- concrete `dawn run '/hello/acme'`
- nonexistent APIs such as `defineConfig`, `createSubAgent`, `subAgents`, `ctx.run`

- [ ] **Step 3: Fix AGENTS template**

Align with:
- named `workflow`, `graph`, `chain` exports.
- default branded `agent()` export.
- global middleware only.
- `.dawn/dawn.generated.d.ts` and `.dawn/routes/<routeSlug>/*.json`.
- canonical domain `https://dawnai.org`.

- [ ] **Step 4: Fix `llms-full.txt` claim**

Either derive docs from `DOCS_NAV` so the full file really contains all docs pages, or change the line to “selected Dawn documentation pages.”

- [ ] **Step 5: Add prompt/content checks**

Extend `scripts/check-docs.mjs` or add a focused script that fails on known-invalid strings:

```js
const forbidden = [
  "npx create-dawn-app",
  "dawn test --url",
  "createSubAgent",
  "subAgents",
  "ctx.run(",
  ".dawn/generated/route-tools.d.ts",
]
```

Run:

```bash
pnpm --filter @dawn-ai/cli build
node scripts/check-docs.mjs
```

Expected: docs completeness check passes after CLI dist exists.

## Task 6: Fix Website UI Copy, Links, Domains, And Blog Visibility

**Files:**
- Modify: `apps/web/app/components/HeaderInner.tsx`
- Modify: `apps/web/app/components/landing/Hero.tsx`
- Modify: `apps/web/app/components/landing/Quickstart.tsx`
- Modify: `apps/web/app/components/landing/FeatureDevLoop.tsx`
- Modify: `apps/web/app/components/landing/DevLoopAnimation.tsx`
- Modify: `apps/web/app/components/Footer.tsx`
- Modify: `apps/web/app/components/docs/PageActions.tsx`
- Modify: `apps/web/app/api/markdown/[...slug]/route.ts`
- Modify: `apps/web/app/not-found.tsx`
- Modify: `apps/web/app/components/MobileMenu.tsx`
- Modify: `apps/web/app/components/blog/post-index.ts`
- Modify: `apps/web/app/components/blog/post-index.test.ts`
- Modify: `apps/web/app/blog/rss.xml/route.ts` if RSS does not derive from the shared filtered post loader.
- Modify: `apps/web/app/sitemap.ts` if sitemap does not derive from the shared filtered post loader.
- Modify: `apps/web/app/llms.txt/route.ts` if llms output does not derive from the shared filtered post loader.
- Modify: `apps/web/content/blog/2026-05-12-why-we-built-dawn.mdx`
- Modify: `apps/web/content/blog/2026-05-19-app-router-for-ai-agents.mdx`
- Modify: `apps/web/content/blog/2026-06-02-dawn-0-4-release.mdx`
- Test: `apps/web/app/components/blog/post-index.test.ts`
- Test: `apps/web/app/components/blog/rss-feed.test.ts`

- [ ] **Step 1: Standardize canonical domain**

Use `https://dawnai.org` everywhere unless there is an intentional redirect strategy. Replace remaining `https://dawn-ai.org` and `https://dawnai.dev` references or document why they remain.

- [ ] **Step 2: Fix install CTAs**

Use:

```bash
pnpm create dawn-ai-app my-agent
```

Every visible command must include the required target directory.

- [ ] **Step 3: Fix broken `/brand` links**

Either add `apps/web/app/brand/page.tsx` or change UI links to existing assets such as `/brand/assets.json` and `/brand/dawn-ai-brand-assets.zip`.

- [ ] **Step 4: Add markdown route fallback for recipe index**

For `/api/markdown/docs/recipes`, fall back from `recipes.mdx` to `recipes/index.mdx`.

- [ ] **Step 5: Filter or draft future-dated blog posts**

As of May 18, 2026:
- `2026-05-19-app-router-for-ai-agents.mdx` is future-dated.
- `2026-06-02-dawn-0-4-release.mdx` is future-dated and refers to unreleased `0.4.0` content.

Put the filter in the shared post-loading/indexing layer so blog index pages, tag pages, RSS, sitemap, and `llms.txt` cannot diverge. Either add `draft: true` support and filter drafts/future posts from every public derived output, or remove future posts from public content until their release date.

- [ ] **Step 6: Run website tests**

Run:

```bash
pnpm exec vitest --run --config apps/web/vitest.config.ts apps/web/app/components/blog/post-index.test.ts apps/web/app/components/blog/rss-feed.test.ts
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS, with tests proving future-dated posts are excluded from the shared post index and any derived surfaces that have direct tests.

## Task 7: Fix Root Docs, Examples, Brand Docs, And Internal History

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CONTRIBUTORS.md`
- Modify: `SUPPORT.md`
- Modify: `.github/ISSUE_TEMPLATE/config.yml`
- Modify: `examples/README.md`
- Modify: `examples/chat/README.md`
- Modify: `examples/chat/web/README.md`
- Modify: `docs/brand/README.md`
- Modify: `docs/brand/recording-guide.md`
- Modify: `docs/brand/quickstart.tape`
- Modify: `docs/brand/capture-fixture.mjs`
- Modify: `docs/thread-handoff.md`
- Modify: `docs/next-iterations-roadmap.md`
- Test: root docs checks and package docs checks from Task 9.

- [ ] **Step 1: Fix root quickstart commands**

Replace invalid route-directory invocations such as:

```bash
pnpm exec dawn run "src/app/(public)/hello/[tenant]"
```

with supported route IDs:

```bash
echo '{"tenant":"acme"}' | pnpm exec dawn run '/hello/[tenant]'
```

Use this in `README.md`, `CONTRIBUTORS.md`, brand recording docs, and any public example docs.

- [ ] **Step 2: Standardize public domains**

Replace public `https://dawn-ai.org` and `https://dawnai.dev` links with:

```text
https://dawnai.org
```

Also update `.github/ISSUE_TEMPLATE/config.yml` if present. Keep any alternate domains only if there is a documented redirect strategy and an explicit allowlist in the drift checker.

- [ ] **Step 3: Update example docs**

Fix `examples/chat/README.md` so it reflects the current tree:
- subagents are present, not deferred.
- the workspace is not a security sandbox unless the runtime enforces that.
- command examples match actual package scripts and `dawn run` route targets.
- capability docs for `AGENTS.md`, `plan.md`, skills, and subagents are either accurate or linked to the eventual docs.

- [ ] **Step 4: Update or archive brand recording docs**

Review `docs/brand/recording-guide.md` and related scripts for stale references:
- nonexistent `hero.mp4`
- invalid `dawn run` route targets
- route-local middleware
- streaming behavior that does not match current CLI/runtime

Either rewrite the guide against current commands or mark it as internal historical capture guidance.

- [ ] **Step 5: Mark internal-history docs clearly**

If `docs/thread-handoff.md` and `docs/next-iterations-roadmap.md` are retained, add a clear internal-history header so stale roadmap or scaffold claims are not treated as current product documentation.

- [ ] **Step 6: Verify root/example docs**

Run:

```bash
rg -n --glob '!docs/superpowers/**' "dawn-ai\\.org|dawnai\\.dev|npx create-dawn-app|dawn test --url|createSubAgent|subAgents|ctx\\.run\\(" README.md CONTRIBUTING.md CONTRIBUTORS.md SUPPORT.md .github docs examples packages apps/web
```

Expected: no matches except deliberate allowlisted historical mentions.

## Task 8: Fix Package Changelogs, Public Comments, And Template Copy

**Files:**
- Modify: `packages/*/CHANGELOG.md`
- Modify: `packages/create-dawn-app/README.md`
- Modify: `packages/devkit/templates/app-basic/package.json.template`
- Modify: `packages/devkit/templates/app-basic/src/app/(public)/hello/[tenant]/state.ts`
- Modify: `packages/cli/src/lib/runtime/load-run-scenarios.ts`
- Modify: `packages/cli/src/lib/typegen/run-typegen.ts`
- Modify: `packages/vite-plugin/src/index.ts`
- Modify: `packages/sdk/src/agent.ts`
- Test: `packages/create-dawn-app/test/create-app.test.ts`
- Test: `packages/devkit/test/generated-app.test.ts`
- Test: `packages/cli/test/test-command.test.ts`

- [ ] **Step 1: Correct package/bin naming**

Use `create-dawn-ai-app` for the package/bin, and use `pnpm create dawn-ai-app` only where describing the package-manager shorthand.

- [ ] **Step 2: Fix changelog inaccuracies**

Update stale claims:
- `baseDelayMs` vs `baseDelay`.
- `@dawn-ai/cli/testing` only re-exporting helper functions unless type exports are added.
- `.dawn/routes/<id>` should be `.dawn/routes/<routeSlug>`.
- “LangGraph Platform” vs “LangSmith” terminology should be intentional and consistent.

- [ ] **Step 3: Fix public comments/errors**

Update:
- `packages/sdk/src/route-types.ts` generated path comments.
- `packages/sdk/src/agent.ts` reasoning comment to avoid unverified “silently ignore” behavior.
- `packages/cli/src/lib/runtime/load-run-scenarios.ts` error/type omissions for `agent` and `chain`.
- `packages/cli/src/lib/typegen/run-typegen.ts` planning-only comments now that skills/subagents exist.
- `packages/vite-plugin/src/index.ts` history-narration comment.

- [ ] **Step 4: Fix starter template docs/scripts**

Either:
- Add a real `build` script that runs `dawn build`, or
- Update `packages/create-dawn-app/README.md` to say the generated app has `check`, `dev`, `typecheck`, and whatever scripts the template actually includes.

- [ ] **Step 5: Run targeted package tests**

Run:

```bash
pnpm exec vitest --run --config packages/create-dawn-app/vitest.config.ts
pnpm exec vitest --run --config packages/devkit/vitest.config.ts
pnpm exec vitest --run --config packages/cli/vitest.config.ts packages/cli/test/test-command.test.ts
```

Expected: PASS.

## Task 9: Add Drift Guards For Future Accuracy

**Files:**
- Modify: `scripts/check-docs.mjs`
- Optionally create: `scripts/check-content-drift.mjs`
- Modify: `package.json`
- Add tests if script logic becomes non-trivial.

- [ ] **Step 1: Build CLI before docs check in CI or make check script source-driven**

Current `node scripts/check-docs.mjs` fails if `packages/cli/dist/index.js` is missing. Either make CI run:

```bash
pnpm --filter @dawn-ai/cli build
node scripts/check-docs.mjs
```

or rewrite the check to import TypeScript source through `tsx`.

- [ ] **Step 2: Add forbidden stale-string checks**

Fail on strings known to be wrong unless explicitly allowlisted. The checker must exclude internal planning/history paths such as `docs/superpowers/**`, or support a concrete allowlist file with comments explaining each exception.

```text
npx create-dawn-app
dawn test --url
createSubAgent
subAgents
ctx.run(
.dawn/generated/route-tools.d.ts
.dawn/generated/route-state.d.ts
https://dawn-ai.org
https://dawnai.dev
export default graph
export default chain
defineConfig
```

Also add pattern checks for invalid route targets and stale generated-type references:

```text
dawn run "src/app/(public)/hello/[tenant]"
dawn run 'src/app/(public)/hello/[tenant]'
dawn run "/hello/acme"
dawn run '/hello/acme'
"route_path": "/
route_path: "/
`dawn.generated.d.ts` at the app root
.dawn/generated/
```

The intent is not to ban all mentions of `dawn.generated.d.ts`; it is to require `.dawn/dawn.generated.d.ts` when documenting the actual emitted file.

- [ ] **Step 3: Add generated artifact path checks**

Require user-facing docs to mention:

```text
.dawn/dawn.generated.d.ts
.dawn/routes/<routeSlug>/tools.json
.dawn/routes/<routeSlug>/state.json
```

- [ ] **Step 4: Add CLI option coverage**

Keep the current Commander-derived command/option coverage, but ensure `dawn dev` is not described as supporting `--cwd`.

- [ ] **Step 5: Add future-post check**

Fail production build/content check when a post date is after the current build date and the post is not explicitly marked as draft or scheduled.

- [ ] **Step 6: Run full validation**

Run:

```bash
pnpm lint
pnpm build
pnpm typecheck
pnpm test
node scripts/check-docs.mjs
```

Expected: all pass. If runtime-heavy harness checks are part of final CI, also run:

```bash
pnpm pack:check
pnpm verify:harness:self-test
pnpm verify:harness
```

Expected: all pass.

## Execution Order

1. Task 1: route/runtime contract docs.
2. Task 3: generated artifacts/build docs, because many pages depend on this terminology.
3. Task 2: provider/middleware/retry/production caveats.
4. Task 4: API/package docs.
5. Task 5: prompts and agent-consumable content.
6. Task 6: website UI/link/blog cleanup.
7. Task 7: root docs, examples, brand docs, and internal-history cleanup.
8. Task 8: package changelog/comments/template cleanup.
9. Task 9: drift guards and full validation.

Commit after each task or pair of tightly related tasks.

## Open Decisions

- Should future-dated blog posts be supported as scheduled drafts, or should future content live outside `apps/web/content/blog` until publication?
- Should middleware production support be implemented, or documented as dev-runtime only?
- Should `ReasoningConfig` be exported from `@dawn-ai/sdk` root since `AgentConfig` exposes it?
- Should published adapter packages with thin READMEs be treated as public API, or explicitly marked internal/unsupported?
