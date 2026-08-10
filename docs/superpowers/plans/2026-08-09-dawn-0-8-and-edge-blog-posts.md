# Dawn 0.8 and Edge Blog Posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create two hidden, publication-ready MDX drafts in Brian Love's voice: a narrative Dawn 0.5–0.8.21 roundup and a separate technical announcement for the opt-in Hono edge target.

**Architecture:** The two posts are separate content artifacts with fixed slugs and complementary ownership: the roundup explains the framework's broader maturation, while the edge post owns Hono/workerd architecture and caveats. They share a source hierarchy, cross-link once, and pass through a final fact, voice, MDX-render, and repository verification gate together.

**Tech Stack:** MDX, Next.js blog content loader, gray-matter frontmatter, GitHub Releases, npm package metadata, pnpm, Vitest, and the repository documentation checks.

---

## File map

- Create `apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx` — release-style catch-up from 0.5.0 through the published 0.8.21 train.
- Create `apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx` — technical Hono/Cloudflare Workers target announcement.
- Do not modify blog loaders, layouts, tag registries, documentation pages, package source, or tests unless verification reveals an actual pre-existing integration defect and the user separately approves expanding scope.
- Do not add a changeset: these are draft-only `apps/web` content files, not a publishable package change.

## Authoritative references

- Approved design: `docs/superpowers/specs/2026-08-09-dawn-0-8-and-edge-blog-posts-design.md`
- Voice: `docs/marketing/author-persona.md` and the three published files under `apps/web/content/blog/`; use `2026-06-02-dawn-0-4-release.mdx` only for release-post structure because its API examples are stale.
- Release facts: public GitHub Releases and package changelogs at tagged 0.5.0–0.8.21 artifacts.
- Broad feature docs: `apps/web/content/docs/{evals,testing-agents,workspace,tools,permissions,sandbox,memory,inspector,subagents,ag-ui,deployment,upgrading}.mdx`.
- Edge facts: `apps/web/content/docs/deployment.mdx`, `packages/cli/CHANGELOG.md`, `packages/postgres-storage/CHANGELOG.md`, `packages/cli/test/{fetch-entry-purity,edge-bundle-purity,hono-node-roundtrip,workerd-lane}.test.ts`, and `packages/cli/src/lib/build/targets/{hono,edge-capabilities}.ts`.

Execute the tasks in order. The two content files are independent while drafting, but Tasks 2 and
3 each stage and commit through the shared Git index, so parallel execution in one worktree is not
safe.

### Task 1: Reconfirm the publication baseline

**Files:**
- Read: `docs/superpowers/specs/2026-08-09-dawn-0-8-and-edge-blog-posts-design.md`
- Read: `docs/marketing/author-persona.md`
- Read: `packages/*/CHANGELOG.md`
- Read: `apps/web/content/docs/*.mdx`
- Create: none

- [ ] **Step 1: Select the repository's required Node version**

Run from the repository root:

```bash
export DAWN_NODE_BIN="/Users/blove/.nvm/versions/node/v24.18.0/bin"
export PATH="$DAWN_NODE_BIN:$PATH"
node --version
```

Expected: `v24.18.0`. Re-export this path in every new shell used for the remaining tasks.

- [ ] **Step 2: Verify that 0.8.21 is still the current public release**

```bash
test "$(npm view @dawn-ai/cli version)" = "0.8.21"
gh release view '@dawn-ai/cli@0.8.21' --repo cacheplane/dawnai --json tagName,publishedAt
```

Expected: both commands succeed and the GitHub result names `@dawn-ai/cli@0.8.21`. If npm has moved beyond 0.8.21, stop: update the approved spec and re-run its review before drafting anything described as current or latest.

- [ ] **Step 3: Verify the unpublished 0.8.20 boundary**

```bash
npm view @dawn-ai/cli time --json
test -z "$(git tag --list '@dawn-ai/cli@0.8.20')"
if gh release view '@dawn-ai/cli@0.8.20' --repo cacheplane/dawnai >/dev/null 2>&1; then exit 1; fi
```

Expected: npm metadata has no 0.8.20 publication, no local 0.8.20 CLI tag is printed, and GitHub reports no release. Generated 0.8.20 changelog entries are not publishable evidence and must not enter either post.

- [ ] **Step 4: Read the voice and fact sources before writing**

Read the authoritative references above, concentrating on:

- `0.5.0`, `0.7.0`, and `0.8.0` headings in `packages/cli/CHANGELOG.md`;
- `0.8.1` through `0.8.21` across CLI, testing, memory, memory-pgvector, sandbox, inspector, AG-UI, SDK, and Postgres storage changelogs;
- the current Node 24 engine requirement rather than the stale Node 22 sentence in Deployment;
- the difference between shipped capability support, local workerd execution evidence, and an inferred host-compatible shape.

Expected: the writer can attach every planned claim to a published release, current doc, or retained test.

- [ ] **Step 5: Confirm a clean starting scope**

```bash
git status --short --branch
```

Expected: branch `blove/blog-dawn-0-8-and-edge` with no uncommitted changes. Preserve any unexpected user changes and stop before overlapping them.

### Task 2: Draft the Dawn 0.8 roundup

**Files:**
- Create: `apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx`
- Reference: `docs/superpowers/specs/2026-08-09-dawn-0-8-and-edge-blog-posts-design.md`
- Reference: `docs/marketing/author-persona.md`

- [ ] **Step 1: Confirm the target file does not already exist**

```bash
test ! -e apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx
```

Expected: exit 0. If it exists, read and preserve it; do not overwrite another writer's draft.

- [ ] **Step 2: Create the exact frontmatter and section skeleton**

Create the file with `apply_patch` and this frontmatter:

```mdx
---
title: Dawn 0.8 — The framework around the agent
description: Evals, typed memory, safer tools, isolated execution, standard clients, and production builds from Node and Docker to an opt-in edge target.
date: 2026-08-09
tags: [typescript, agents]
type: release
version: 0.8.21
author: brian
draft: true
---
```

Use this heading sequence:

```md
## The short version
## Measure what the agent does
## Put a boundary around execution
## Make delegation explicit
## Memory you can review
## Connect a real client
## Run the runtime in production
## Upgrade deliberately
## The framework around the agent
```

Expected: the frontmatter parses as a release, automatically gains the `releases` tag, and remains hidden in production because `draft: true` is explicit.

- [ ] **Step 3: Write the opening and practical summary**

Write a short-paragraph opening that returns to the original Dawn thesis: the route tree was the beginning, and recent work filled in the application around it. Explicitly say this is a catch-up from 0.5 through the current 0.8.21 release, so the `version: 0.8.21` field cannot be mistaken for the introduction point of every feature.

Under `## The short version`, use five or six outcome-oriented bullets: measure, constrain/isolate, delegate, remember, connect, and deploy. Do not list packages or every patch.

Expected: the hook sounds like a builder reporting what changed, not a launch slogan.

- [ ] **Step 4: Write eval, safety, and delegation sections**

Cover these exact boundaries:

- Evals arrived in 0.5.0; fixture replay is deterministic by default, while `--live` and `--record` call a real model and do not belong in CI. Mention co-located evals and focused agent/tool/middleware/workspace harnesses.
- Safety is layered: a path jail and permission gate are not the same as container isolation. Explain tool allow/deny, argument constraints, approvals, Docker, and Kubernetes without calling containers microVMs or promising network enforcement that the provider cannot prove.
- Close the 0.4 preview story with the current keyed `subagents` map, parent-owned delegation policy, constraints/approval, and resumable subgraphs. Do not reuse `createSubAgent`, `subAgents`, or the old resume envelope.

Expected: each section turns the feature list into a developer outcome and includes no more than one representative code shape if code materially clarifies it.

- [ ] **Step 5: Write memory, clients, and deployment sections**

Cover these exact boundaries:

- Memory defaults to SQLite, keyword recall, and candidate writes. Typed long-term memory, hybrid pgvector recall, episodes, distillation, and the local Memory Inspector should be described with their opt-in/manual boundaries. Do not call the Inspector a general production tracing console.
- Keep long-term memory separate from `@dawn-ai/postgres-storage`. The Postgres package shares checkpoints, Agent Protocol threads, and permission grants for multi-instance or ephemeral deployments; it is not the long-term-memory store. Cancellation and one-run-per-thread enforcement remain process-local even when those three durable stores use Postgres.
- AG-UI is the standard web-client bridge; current Agent Protocol examples are thread-scoped. Mention canonical interrupts/resume and tool-call correlation without reproducing the entire protocol reference.
- The Node/Docker target and `dawn start` run the Dawn runtime in production. The later fetch core made another host adapter possible. Give the Hono target two short paragraphs and link `/blog/dawn-at-the-edge` for the detail.

Expected: the roundup owns the broad product story and leaves edge architecture to the companion post.

- [ ] **Step 6: Write the upgrade section and close**

Include a pinned command such as:

```bash
pnpm add @dawn-ai/cli@0.8.21 @dawn-ai/sdk@0.8.21
pnpm exec dawn verify
```

State all of the following plainly:

- Dawn is pre-1.0.
- Public packages share one fixed version from 0.8.0 onward.
- Current Dawn requires Node 24.
- Breaking changes have shipped in 0.8.x patches, so readers should pin versions and read every intervening release note.

Link `/docs/upgrading`, then close by returning to “the framework around the agent” and a runnable scaffold or upgrade next step.

Expected: no “backward-compatible” promise and no implication that Dawn is a new runtime replacing LangGraph.js.

- [ ] **Step 7: Run targeted content assertions**

```bash
test "$(rg -c '^draft: true$' apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx)" = "1"
test "$(rg -c '^## ' apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx)" -ge "8"
wc -w apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx
if rg -n 'gpt-4o|createSubAgent|subAgents|/runs/(wait|stream)|backward-compatible|production-ready|0\.8\.20|node:22' apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx; then exit 1; fi
```

Expected: one draft flag, at least eight sections, roughly 1,500–1,900 words, and no stale or overstated matches.

- [ ] **Step 8: Review the diff and commit the roundup**

```bash
git diff --check
git diff -- apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx
git add apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx
git commit -m "docs(blog): draft Dawn 0.8 roundup"
```

Expected: one new MDX file in the commit.

### Task 3: Draft the Hono edge announcement

**Files:**
- Create: `apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx`
- Reference: `apps/web/content/docs/deployment.mdx`
- Reference: `packages/cli/src/lib/build/targets/hono.ts`
- Reference: `packages/cli/src/lib/build/targets/edge-capabilities.ts`
- Reference: `packages/cli/test/workerd-lane.test.ts`

- [ ] **Step 1: Confirm the target file does not already exist**

```bash
test ! -e apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx
```

Expected: exit 0. If it exists, read and preserve it; do not overwrite another writer's draft.

- [ ] **Step 2: Create the exact frontmatter and section skeleton**

Create the file with `apply_patch` and this frontmatter:

```mdx
---
title: Dawn at the edge — The Hono target
description: Dawn now emits a Node-free runtime entry for Cloudflare Workers. Here is the static wiring, per-request Postgres lifecycle, workerd evidence, and honest subset behind it.
date: 2026-08-09
tags: [typescript, agents, patterns]
type: post
author: brian
draft: true
---
```

Use this heading sequence:

```md
## The short version
## What Dawn builds
## Node-free on purpose
## One request, one store lifetime
## The target refuses what it cannot run
## What the tests prove
## Try it
```

Expected: the frontmatter parses as a normal post and remains hidden in production.

- [ ] **Step 3: Write the workerd-led opening and summary**

Open with the observed failure: one request worked, the second hung. Explain that a Hono wrapper looked simple once Dawn had a `(Request) => Promise<Response>` core, but workerd exposed request-owned I/O, Node-global, static-import, and storage-lifetime assumptions that a clean single-request bundle could not reveal.

Under `## The short version`, state:

- 0.8.21 adds the opt-in `hono` build target;
- Cloudflare Workers is the target host, while local real workerd is the executed proof;
- the generated/runtime graph links without `nodejs_compat`;
- stores are request-scoped and Postgres-backed;
- the target intentionally supports a subset and fails named unsupported configurations.

Expected: the opening is technically specific and does not claim a live Cloudflare deployment.

- [ ] **Step 4: Show the supported build workflow and artifacts**

Use this configuration so readers see that naming targets replaces the defaults:

```ts title="dawn.config.ts"
import { config } from "@dawn-ai/cli"

export default config({
  build: { targets: ["node", "langsmith", "hono"] },
})
```

Explain the four outputs in a compact table:

- `.dawn/build/modules.edge.mjs` — static route/tool/state/middleware manifest;
- `.dawn/build/stores.mjs` — per-request Neon WebSocket pool and Postgres stores;
- `.dawn/build/app.mjs` — default-exported Hono app forwarding to Dawn's fetch handler;
- root `wrangler.toml` — generated only when absent and never overwritten.

State that Dawn emits analyzable source and Wrangler creates the final edge bundle. Rebuild when route, tool, model, provider, middleware, or inlined config inputs change. Secrets belong in bindings, not `dawn.config.ts`.

Expected: no claim that Dawn itself produces a final universal edge bundle.

- [ ] **Step 5: Explain Node-free linking and static provider wiring**

Explain, in this order:

1. the generated edge/runtime graph is tested for zero `node:` specifiers and Dawn-owned bare Node globals;
2. `readRuntimeEnv` and seeded bindings replace assumptions about `process.env`;
3. model providers are emitted as a literal static import switch so an unresolved provider fails the build;
4. arbitrary user route/tool imports are not statically policed by Dawn and may still fail when Wrangler bundles them.

Say `nodejs_compat` is deliberately absent from the generated scaffold. Do not say “Dawn is Node-free.”

- [ ] **Step 6: Explain the request-scoped storage lifecycle**

Tell the alternating-hang story precisely: a module-scoped Neon WebSocket pool can return a client owned by a completed workerd request, causing the next request to hang until cancellation. The generated target therefore creates one pool per request, shares it across the three Postgres stores, and disposes it only after both the response body and any request-started run settle.

Also state:

- migrations run once per isolate, with advisory locks converging concurrent instances;
- the verified path uses `@neondatabase/serverless`'s WebSocket `Pool` against local Postgres through a local proxy, not the `neon()` HTTP function or raw TCP `pg`;
- Neon Cloud and Hyperdrive were not exercised;
- the shared Postgres stores cover checkpoints, threads, and permissions, not long-term memory.

Expected: no “once globally,” “close when fetch returns,” “any Postgres URL from Workers,” or Neon Cloud claim.

- [ ] **Step 7: Explain the capability and evidence boundaries**

Use a compact table or two short lists to distinguish:

- build-supported shapes from workerd-executed behavior;
- named `DAWN_E1005` rejections: sandbox, filesystem/shell backends, a workspace directory, route skills, typed long-term memory, and custom live store instances;
- `memory.md` and `plan.md`, whose filesystem-backed markers remain inactive rather than becoming supported edge capabilities.

Name the gated `edge-workerd` CI lane. Its retained proof is the emitted OpenAI fixture, `/healthz`, four sequential AG-UI turns, conversation reload, and Postgres rows checked out of band. Explicitly list major unverified areas: live Cloudflare deployment/upload limits, Agent Protocol/tools/subagents/HITL inside workerd, other providers, production connection/subrequest limits, WAN latency, cross-isolate cold starts, startup CPU/bundle enforcement, Hyperdrive, Neon Cloud, Vercel, Deno, and Bun.

Expected: “not gated” never becomes “verified.”

- [ ] **Step 8: Write the practical CTA**

Use these install/build steps, keeping the Dawn packages pinned:

```bash
pnpm add @dawn-ai/cli@0.8.21 @dawn-ai/postgres-storage@0.8.21 @neondatabase/serverless hono
pnpm exec dawn check
pnpm exec dawn build --clean
wrangler secret put DATABASE_URL
wrangler deploy
```

Link `/docs/deployment`, `/docs/configuration#postgres-backend`, and the companion roundup at `/blog/dawn-0-8-framework-around-the-agent`. Invite real-workload feedback without calling the target production-proven.

- [ ] **Step 9: Run targeted edge-claim assertions**

```bash
test "$(rg -c '^draft: true$' apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx)" = "1"
test "$(rg -c '^## ' apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx)" -ge "7"
wc -w apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx
rg -n 'local workerd|once per isolate|per-request|nodejs_compat|not.*Cloudflare|did not.*Cloudflare' apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx
if rg -n 'production-ready on Cloudflare|production-proven on Cloudflare|deployed to (a )?live Cloudflare|Dawn is Node-free|migrations run once globally|stores close when fetch|any Postgres URL|0\.8\.20' apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx; then exit 1; fi
```

Expected: one draft flag, at least seven sections, roughly 1,300–1,700 words, explicit evidence/boundary language, and no prohibited claims.

- [ ] **Step 10: Review the diff and commit the edge post**

```bash
git diff --check
git diff -- apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx
git add apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx
git commit -m "docs(blog): draft Hono edge announcement"
```

Expected: one new MDX file in the commit.

### Task 4: Integrate, fact-check, and voice-check both drafts

**Files:**
- Modify: `apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx`
- Modify: `apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx`
- Reference: all authoritative sources listed above

- [ ] **Step 1: Verify the cross-links and docs routes**

```bash
rg -n '/blog/dawn-at-the-edge' apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx
rg -n '/blog/dawn-0-8-framework-around-the-agent' apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx
for slug in evals testing-agents workspace tools permissions sandbox memory inspector subagents ag-ui deployment upgrading configuration; do test -f "apps/web/app/docs/$slug/page.tsx"; done
```

Expected: one purposeful companion link in each post and every internal docs route exists.

- [ ] **Step 2: Run a published-release fact pass**

For every version number and feature claim in the roundup, locate the corresponding public release/tag and package changelog entry. For every edge implementation/evidence claim, locate the corresponding current source, retained test, or Deployment section. Remove a claim if it can be supported only by an approved design document, an unpublished 0.8.20 section, or an unreleased changeset on `main`.

Use these checks as guardrails:

```bash
if rg -n '0\.8\.20|gpt-4o|createSubAgent|subAgents|/runs/(wait|stream)|byte-identical|without translation|speaks .* natively|auto-bound|auto-registered' apps/web/content/blog/2026-08-09-*.mdx; then exit 1; fi
rg -n 'Node 24|pre-1\.0|local workerd|draft: true' apps/web/content/blog/2026-08-09-*.mdx
```

Expected: no stale phrases or APIs; the required stability, runtime, and evidence boundaries are present.

- [ ] **Step 3: Run a voice and duplication pass**

Read both posts straight through against `docs/marketing/author-persona.md`. Enforce:

- practical builder-to-builder posture;
- short opening paragraphs followed by medium-detail explanation;
- first person only for earned judgment or observed implementation lessons;
- one representative example per idea;
- ordinary words before abstractions;
- no stacked manifesto fragments, marketing superlatives, or generic engagement CTA.

Then compare the posts side by side. The roundup may summarize the Hono target in two short paragraphs; all artifact, pool-lifecycle, capability-gate, and workerd-evidence detail belongs only in the edge post.

Expected: either post stands alone, and reading both does not repeat an entire section.

- [ ] **Step 4: Request independent fact and voice reviews in parallel**

Use `@superpowers:dispatching-parallel-agents` to send read-only, context-isolated reviews:

- Reviewer A receives both file paths plus the public-release and edge source hierarchy. Ask it to return only unsupported, misleading, stale, or mis-versioned claims with citations.
- Reviewer B receives both file paths, `docs/marketing/author-persona.md`, and the existing published blog file paths. Ask it to flag voice drift, parody, duplicated sections, or a CTA that does not sound like Brian.

Apply feedback with `@superpowers:receiving-code-review`: verify every suggestion against the repository before changing prose. Re-run the relevant checks from Steps 1–3.

Expected: no unresolved factual blockers or material voice drift.

- [ ] **Step 5: Commit integration edits**

```bash
git diff --check
git add apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx
git diff --cached --stat
git commit -m "docs(blog): polish Dawn 0.8 release drafts"
```

Expected: commit succeeds if review changed either file. If the reviews required no changes, skip the empty commit.

### Task 5: Verify parsing, rendering, and repository gates

**Files:**
- Verify: `apps/web/content/blog/2026-08-09-dawn-0-8-framework-around-the-agent.mdx`
- Verify: `apps/web/content/blog/2026-08-09-dawn-at-the-edge.mdx`
- Test: `apps/web/app/components/blog/post-index.test.ts`
- Test: `apps/web/app/components/blog/rss-feed.test.ts`

- [ ] **Step 1: Install the locked workspace dependencies under Node 24**

```bash
export DAWN_NODE_BIN="/Users/blove/.nvm/versions/node/v24.18.0/bin"
export PATH="$DAWN_NODE_BIN:$PATH"
pnpm install --frozen-lockfile
```

Expected: installation succeeds without changing `pnpm-lock.yaml`.

- [ ] **Step 2: Run targeted blog tests and web typechecking**

```bash
pnpm --filter @dawn-ai/web exec vitest run app/components/blog/post-index.test.ts app/components/blog/rss-feed.test.ts
pnpm --filter @dawn-ai/web typecheck
```

Expected: both Vitest files pass and TypeScript exits 0.

- [ ] **Step 3: Run documentation and diff checks**

```bash
node scripts/check-docs.mjs
git diff --check origin/main...HEAD
```

Expected: the documentation check and branch-wide whitespace check exit 0.

- [ ] **Step 4: Render both hidden drafts in the development server**

Start the site in a long-lived terminal:

```bash
pnpm --filter @dawn-ai/web exec next dev --hostname 127.0.0.1 --port 4173
```

From another terminal:

```bash
curl -fsS http://127.0.0.1:4173/blog/dawn-0-8-framework-around-the-agent | rg -q 'The framework around the agent'
curl -fsS http://127.0.0.1:4173/blog/dawn-at-the-edge | rg -q 'The Hono target'
```

Expected: both requests return 200 and contain their titles. A production build is not enough for this assertion because production intentionally filters `draft: true` posts.

- [ ] **Step 5: Inspect both rendered posts visually**

Use `@browser:control-in-app-browser` to open both local URLs and verify:

- title, description, author, date, release badge/version, and tags render correctly;
- headings populate the table of contents;
- code blocks and the artifact/capability table fit at desktop and mobile widths;
- companion and documentation links resolve;
- no raw MDX, clipped content, or horizontal overflow appears.

Expected: both drafts are readable at desktop and mobile widths. Fix any content-level rendering issue with `apply_patch`, re-run Steps 2–5, and commit the fix.

- [ ] **Step 6: Stop the development server**

Send `Ctrl-C` to the long-lived Next.js development-server session, wait for it to exit, and verify
the port is closed:

```bash
if curl -fsS http://127.0.0.1:4173/ >/dev/null 2>&1; then exit 1; fi
```

Expected: the check exits 0 because nothing is listening on port 4173. Do not run the production
build while `next dev` is writing the same `.next` tree.

- [ ] **Step 7: Run the repository Definition of Done**

```bash
pnpm ci:validate
```

Expected: the full lint → build-cache → build → typecheck → test → docs → pack → harness lane exits 0. Do not substitute targeted checks for this final gate.

- [ ] **Step 8: Verify the final scope and draft state**

```bash
git status --short --branch
git log --oneline --decorate -6
git show --stat --oneline HEAD
test "$(rg -l '^draft: true$' apps/web/content/blog/2026-08-09-*.mdx | wc -l | tr -d ' ')" = "2"
git diff --check origin/main...HEAD
```

Expected: only the approved spec, implementation plan, and two blog drafts differ from `origin/main`; both posts remain drafts; no changeset or unrelated file is present; all commits are on `blove/blog-dawn-0-8-and-edge`.

## Completion boundary

Completion means both draft files exist, pass fact and voice review, render correctly in development, and pass the repository gates while retaining `draft: true`. It does **not** include publishing, changing the post dates, removing draft flags, deploying the site, or opening a pull request.
