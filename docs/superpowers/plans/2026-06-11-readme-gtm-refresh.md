# README GTM Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the root and package README files to maximize GTM developer growth via an SEO keyword pass, a consistent Star/Docs/Discussions CTA band, live docs links, and complete (no-blank) npm READMEs — without changing Dawn's "meta-framework for LangGraph" positioning.

**Architecture:** Documentation-only change. A single canonical CTA-band snippet is reused across the root and Tier-1 package READMEs. Tier-2 packages get a consistent minimal stub. All doc links repoint from raw `apps/web/content/docs/*.mdx` paths to the live `https://dawn-ai.org/docs/<slug>` site. No source code, no `package.json` changes.

**Tech Stack:** Markdown. Verification via `grep`, `git`, and the repo's existing `node scripts/check-docs.mjs` / `pnpm pack:check` gates.

---

## Reference constants (used verbatim throughout)

**Canonical CTA band** (root + Tier-1). Insert as its own block:

```md
---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawn-ai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)
```

**Tier-2 docs line** (one line, replaces the raw repo docs link):

```md
For documentation, see [dawn-ai.org/docs](https://dawn-ai.org/docs/getting-started).
```

**Doc-slug map** (raw path → live URL). All slugs verified to exist under `apps/web/content/docs/`:

| Raw path                                          | Live URL                                      |
|---------------------------------------------------|-----------------------------------------------|
| `apps/web/content/docs/getting-started.mdx`       | `https://dawn-ai.org/docs/getting-started`    |
| `apps/web/content/docs/routes.mdx`                | `https://dawn-ai.org/docs/routes`             |
| `apps/web/content/docs/tools.mdx`                 | `https://dawn-ai.org/docs/tools`              |
| `apps/web/content/docs/state.mdx`                 | `https://dawn-ai.org/docs/state`              |
| `apps/web/content/docs/cli.mdx`                   | `https://dawn-ai.org/docs/cli`                |
| `apps/web/content/docs/dev-server.mdx`            | `https://dawn-ai.org/docs/dev-server`         |
| `apps/web/content/docs/testing.mdx`               | `https://dawn-ai.org/docs/testing`            |
| `apps/web/content/docs/deployment.mdx`            | `https://dawn-ai.org/docs/deployment`         |

**Tier-1 packages:** `sdk`, `cli`, `create-dawn-app`, `langchain`
**Tier-2 packages:** `core`, `langgraph`, `devkit`, `vite-plugin`, `config-biome`, `config-typescript`, `workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`

---

## Task 1: Root README — SEO pass + live doc links + CTA band

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the tagline for SEO (keep the anchor phrase)**

Replace the current line 11:

```md
The meta-framework for LangGraph. Author agents and workflows as filesystem routes, get types and a local dev server for free, and ship to LangSmith with one command.
```

with:

```md
The TypeScript meta-framework for LangGraph. Author AI agents and workflows as filesystem routes, get end-to-end types and a local dev server for free, and deploy to LangSmith with one command.
```

- [ ] **Step 2: SEO-tune the "Why Dawn?" bold lead-ins**

In the "## Why Dawn?" list, replace the four bold lead phrases only (leave each bullet's following prose unchanged):

- `**Kill the graph boilerplate.**` → `**Kill the LangGraph boilerplate.**`
- `**Real project structure.**` → `**Filesystem-routed agents.**`
- `**A local dev loop for Dawn routes.**` → `**A real local dev loop.**`
- `**Typed end to end.**` → `**Typed end to end (TypeScript).**`

- [ ] **Step 3: Repoint the "Learn more" links to the live docs site**

Replace the entire "## Learn more" list body with:

```md
- [Getting started](https://dawn-ai.org/docs/getting-started)
- [Routes](https://dawn-ai.org/docs/routes)
- [Tools](https://dawn-ai.org/docs/tools)
- [State](https://dawn-ai.org/docs/state)
- [CLI](https://dawn-ai.org/docs/cli)
- [Dev server](https://dawn-ai.org/docs/dev-server)
- [Testing](https://dawn-ai.org/docs/testing)
- [Deployment](https://dawn-ai.org/docs/deployment)
```

- [ ] **Step 4: Insert the CTA band directly above "## Learn more"**

Insert the canonical CTA band (from Reference constants) on its own lines immediately before the `## Learn more` heading. Result reads:

```md
---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawn-ai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## Learn more
```

- [ ] **Step 5: Verify the edits**

Run: `grep -c "dawn-ai.org/docs" README.md`
Expected: `9` (8 Learn-more links + 1 CTA band docs link)

Run: `grep -F "raw.githubusercontent" README.md; grep -F "apps/web/content/docs" README.md`
Expected: only the logo `raw.githubusercontent` line remains; **no** `apps/web/content/docs` matches.

Run: `grep -F "Star Dawn on GitHub" README.md`
Expected: one match.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): SEO pass, live docs links, and CTA band on root README"
```

---

## Task 2: Tier-1 — `@dawn-ai/sdk` README

**Files:**
- Modify: `packages/sdk/README.md`

- [ ] **Step 1: SEO-tune the description (line 7)**

Replace:

```md
The author-facing SDK for Dawn. Use it to declare agent routes, define request middleware, and type the runtime context, tools, and route metadata that the Dawn CLI consumes. Ships small runtime helpers (`agent()`, `defineMiddleware()`, `allow()`, `reject()`, `isDawnAgent()`) alongside the type primitives — it is the canonical entry point for authoring Dawn routes.
```

with:

```md
The author-facing TypeScript SDK for Dawn, the meta-framework for LangGraph. Use it to declare AI agent routes, define request middleware, and type the runtime context, tools, and route metadata that the Dawn CLI consumes. Ships small runtime helpers (`agent()`, `defineMiddleware()`, `allow()`, `reject()`, `isDawnAgent()`) alongside the type primitives — it is the canonical entry point for authoring Dawn routes.
```

- [ ] **Step 2: Repoint the Documentation links to the live docs site**

Replace the "## Documentation" list body:

```md
- Routes — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/routes.mdx
- Tools — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/tools.mdx
- State — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/state.mdx
- Getting started — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/getting-started.mdx
```

with:

```md
- [Routes](https://dawn-ai.org/docs/routes)
- [Tools](https://dawn-ai.org/docs/tools)
- [State](https://dawn-ai.org/docs/state)
- [Getting started](https://dawn-ai.org/docs/getting-started)
```

- [ ] **Step 3: Insert the CTA band directly above "## License"**

Insert the canonical CTA band on its own lines immediately before `## License`.

- [ ] **Step 4: Verify**

Run: `grep -F "apps/web/content/docs" packages/sdk/README.md`
Expected: no matches.

Run: `grep -F "Star Dawn on GitHub" packages/sdk/README.md`
Expected: one match.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/README.md
git commit -m "docs(sdk): SEO description, live docs links, CTA band"
```

---

## Task 3: Tier-1 — `@dawn-ai/cli` README

**Files:**
- Modify: `packages/cli/README.md`

- [ ] **Step 1: SEO-tune the description (line 7)**

Replace:

```md
The `dawn` command-line interface — local development runtime, route execution, validation and typegen, and the build step that produces LangSmith deployment artifacts. It is the primary tool for working on a Dawn app from first scaffold through deploy.
```

with:

```md
The `dawn` CLI for Dawn, the TypeScript meta-framework for LangGraph — a local development runtime, route execution, validation and typegen, and the build step that produces LangSmith deployment artifacts. It is the primary tool for working on a Dawn agent app from first scaffold through deploy.
```

- [ ] **Step 2: Repoint the Documentation links to the live docs site**

Replace the "## Documentation" list body:

```md
- CLI — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/cli.mdx
- Dev server — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/dev-server.mdx
- Deployment — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/deployment.mdx
- Getting started — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/getting-started.mdx
```

with:

```md
- [CLI](https://dawn-ai.org/docs/cli)
- [Dev server](https://dawn-ai.org/docs/dev-server)
- [Deployment](https://dawn-ai.org/docs/deployment)
- [Getting started](https://dawn-ai.org/docs/getting-started)
```

- [ ] **Step 3: Insert the CTA band directly above "## License"**

Insert the canonical CTA band on its own lines immediately before `## License`.

- [ ] **Step 4: Verify**

Run: `grep -F "apps/web/content/docs" packages/cli/README.md`
Expected: no matches.

Run: `grep -F "Star Dawn on GitHub" packages/cli/README.md`
Expected: one match.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/README.md
git commit -m "docs(cli): SEO description, live docs links, CTA band"
```

---

## Task 4: Tier-1 — `create-dawn-ai-app` README

**Files:**
- Modify: `packages/create-dawn-app/README.md`

- [ ] **Step 1: SEO-tune the description (line 7)**

Replace:

```md
Scaffold a new Dawn application from the supported starter templates. Generates a working app with Dawn's canonical `src/app` route layout, an `agent()` route, and the Dawn packages wired up for local development.
```

with:

```md
Scaffold a new Dawn app — the fastest way to start building TypeScript AI agents on LangGraph. Generates a working application from the supported starter templates with Dawn's canonical `src/app` route layout, an `agent()` route, and the Dawn packages wired up for local development.
```

- [ ] **Step 2: Repoint the "Next steps" links to the live docs site**

Replace the "## Next steps" list body:

```md
- Getting started — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/getting-started.mdx
- Routes — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/routes.mdx
- CLI — https://github.com/cacheplane/dawnai/blob/main/apps/web/content/docs/cli.mdx
```

with:

```md
- [Getting started](https://dawn-ai.org/docs/getting-started)
- [Routes](https://dawn-ai.org/docs/routes)
- [CLI](https://dawn-ai.org/docs/cli)
```

- [ ] **Step 3: Insert the CTA band directly above "## License"**

Insert the canonical CTA band on its own lines immediately before `## License`.

- [ ] **Step 4: Verify**

Run: `grep -F "apps/web/content/docs" packages/create-dawn-app/README.md`
Expected: no matches.

Run: `grep -F "Star Dawn on GitHub" packages/create-dawn-app/README.md`
Expected: one match.

- [ ] **Step 5: Commit**

```bash
git add packages/create-dawn-app/README.md
git commit -m "docs(create-dawn-app): SEO description, live docs links, CTA band"
```

---

## Task 5: Tier-1 — `@dawn-ai/langchain` README

**Files:**
- Modify: `packages/langchain/README.md`

This package currently uses the Tier-2 stub footer; promote it to a Tier-1 landing README.

- [ ] **Step 1: Replace the whole file body below the logo header**

Keep lines 1–4 (the `<p align="center">` logo block) unchanged. Replace everything from `# @dawn-ai/langchain` (line 5) to end of file with:

```md
# @dawn-ai/langchain

LangChain backend adapters for Dawn, the TypeScript meta-framework for LangGraph. Dawn uses this package to materialize `chain` routes and provider-aware `agent` routes — handling tool conversion, streaming, and retry.

`agent()` materialization resolves a LangChain chat model from the route descriptor. Dawn includes `@langchain/openai` for the default/backcompat path and lazy-loads optional provider packages when an agent selects or infers another provider.

## Optional provider integrations

Install the provider packages your agents use, as needed:

```bash
pnpm add @langchain/anthropic     # anthropic
pnpm add @langchain/google-genai  # google
pnpm add @langchain/mistralai     # mistral
pnpm add @langchain/groq          # groq
pnpm add @langchain/ollama        # ollama
pnpm add @langchain/xai           # xai
pnpm add @langchain/openrouter    # openrouter
```

## Documentation

- [Routes](https://dawn-ai.org/docs/routes)
- [Getting started](https://dawn-ai.org/docs/getting-started)

---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawn-ai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## License

MIT
```

- [ ] **Step 2: Verify**

Run: `grep -F "apps/web/content/docs" packages/langchain/README.md`
Expected: no matches.

Run: `grep -F "internal Dawn workspace package" packages/langchain/README.md`
Expected: no matches (promoted out of stub status).

Run: `grep -F "Star Dawn on GitHub" packages/langchain/README.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add packages/langchain/README.md
git commit -m "docs(langchain): promote to Tier-1 landing README with CTA band"
```

---

## Task 6: Tier-2 — repoint docs links in the 6 existing stubs

**Files:**
- Modify: `packages/core/README.md`
- Modify: `packages/langgraph/README.md`
- Modify: `packages/devkit/README.md`
- Modify: `packages/vite-plugin/README.md`
- Modify: `packages/config-biome/README.md`
- Modify: `packages/config-typescript/README.md`

Each of these six files contains the line:

```md
This is an internal Dawn workspace package. For Dawn documentation, see <https://github.com/cacheplane/dawnai/tree/main/apps/web/content/docs>.
```

- [ ] **Step 1: Replace that line in all six files**

In each of the six files, replace the line above with:

```md
This is an internal Dawn workspace package, part of [Dawn — the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai). For documentation, see [dawn-ai.org/docs](https://dawn-ai.org/docs/getting-started).
```

- [ ] **Step 2: Verify**

Run: `grep -rl "apps/web/content/docs" packages/core/README.md packages/langgraph/README.md packages/devkit/README.md packages/vite-plugin/README.md packages/config-biome/README.md packages/config-typescript/README.md`
Expected: no output (no matches in any of the six).

Run: `grep -rc "dawn-ai.org/docs" packages/core/README.md packages/langgraph/README.md packages/devkit/README.md packages/vite-plugin/README.md packages/config-biome/README.md packages/config-typescript/README.md`
Expected: each file reports `1`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/README.md packages/langgraph/README.md packages/devkit/README.md packages/vite-plugin/README.md packages/config-biome/README.md packages/config-typescript/README.md
git commit -m "docs(packages): repoint internal-stub docs links to dawn-ai.org"
```

---

## Task 7: Tier-2 — create the 5 missing (blank) package READMEs

**Files:**
- Create: `packages/workspace/README.md`
- Create: `packages/permissions/README.md`
- Create: `packages/sqlite-storage/README.md`
- Create: `packages/testing/README.md`
- Create: `packages/evals/README.md`

Each uses the same template; only the package name and the one-line purpose differ. Use the per-package purpose strings below (sourced from each package's role in the monorepo).

- [ ] **Step 1: Create `packages/workspace/README.md`**

```md
<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/workspace

Filesystem-backed workspace utilities for Dawn agents — reading, writing, and managing files in an agent's working directory.

This is an internal Dawn workspace package, part of [Dawn — the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai). For documentation, see [dawn-ai.org/docs](https://dawn-ai.org/docs/getting-started).

## License

MIT
```

- [ ] **Step 2: Create `packages/permissions/README.md`**

```md
<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/permissions

Permission and access-control primitives for Dawn agents — gating tool and resource access at runtime.

This is an internal Dawn workspace package, part of [Dawn — the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai). For documentation, see [dawn-ai.org/docs](https://dawn-ai.org/docs/getting-started).

## License

MIT
```

- [ ] **Step 3: Create `packages/sqlite-storage/README.md`**

```md
<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/sqlite-storage

SQLite-backed storage adapter for Dawn — durable persistence for agent state and runtime data.

This is an internal Dawn workspace package, part of [Dawn — the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai). For documentation, see [dawn-ai.org/docs](https://dawn-ai.org/docs/getting-started).

## License

MIT
```

- [ ] **Step 4: Create `packages/testing/README.md`**

```md
<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/testing

Testing utilities for Dawn apps — helpers for exercising routes, tools, and agent behavior in unit and scenario tests.

This is an internal Dawn workspace package, part of [Dawn — the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai). For documentation, see [dawn-ai.org/docs](https://dawn-ai.org/docs/getting-started).

## License

MIT
```

- [ ] **Step 5: Create `packages/evals/README.md`**

```md
<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/evals

Evaluation harness for Dawn agents — running and scoring agent behavior against datasets and scenarios.

This is an internal Dawn workspace package, part of [Dawn — the TypeScript meta-framework for LangGraph](https://github.com/cacheplane/dawnai). For documentation, see [dawn-ai.org/docs](https://dawn-ai.org/docs/getting-started).

## License

MIT
```

- [ ] **Step 6: Verify no published package renders blank**

Run:
```bash
for f in workspace permissions sqlite-storage testing evals; do test -s packages/$f/README.md && echo "$f OK" || echo "$f BLANK"; done
```
Expected: five `OK` lines, no `BLANK`.

- [ ] **Step 7: Confirm the one-line purpose matches each package**

Before committing, open each package's `package.json` and source `index`/entry to confirm the purpose sentence is accurate. If a description is wrong, correct that README's purpose line. (Do not invent capabilities — describe what the package actually exports.)

- [ ] **Step 8: Commit**

```bash
git add packages/workspace/README.md packages/permissions/README.md packages/sqlite-storage/README.md packages/testing/README.md packages/evals/README.md
git commit -m "docs(packages): add READMEs for previously-blank published packages"
```

---

## Task 8: Repo-wide verification gate

**Files:** none (verification only)

- [ ] **Step 1: No README points at raw docs paths anymore**

Run: `grep -rl "apps/web/content/docs" README.md packages/*/README.md`
Expected: no output.

- [ ] **Step 2: Every published package has a non-empty README**

Run:
```bash
for d in packages/*/; do test -s "$d/README.md" && echo "$d OK" || echo "$d MISSING"; done
```
Expected: all `OK`.

- [ ] **Step 3: CTA band present on root + all Tier-1 packages (exactly 5 files)**

Run: `grep -rl "Star Dawn on GitHub" README.md packages/sdk/README.md packages/cli/README.md packages/create-dawn-app/README.md packages/langchain/README.md`
Expected: all five paths listed.

- [ ] **Step 4: Run the repo's existing docs/link gate**

Run: `node scripts/check-docs.mjs`
Expected: exits 0 (passes). If it flags anything, fix the offending README and re-run.

- [ ] **Step 5: Run pack check to confirm packaged READMEs are valid**

Run: `pnpm pack:check`
Expected: passes. If it fails for an unrelated reason, note it; this plan only touches READMEs.

- [ ] **Step 6: Final commit if any fixes were made**

```bash
git add -A
git commit -m "docs: verification fixes for README GTM refresh"
```

(If no fixes were needed, skip this step.)

---

## Self-review notes

- **Spec coverage:** §1 root → Task 1. §2 Tier-1 → Tasks 2–5. §3 Tier-2 (6 stubs + 5 blanks) → Tasks 6–7. §4 CTA band → reused constant in Tasks 1–5. §5 supporting fixes → dropped per planning correction (metadata already present; root is private). Verification → Task 8.
- **No placeholders:** every README's final content is shown in full or as an exact find/replace.
- **Consistency:** the CTA band, Tier-2 docs line, and logo header are byte-identical everywhere they appear; doc URLs all use the `dawn-ai.org/docs/<slug>` form from the slug map.
- **Accuracy caveat:** Task 7 Step 7 requires confirming each new package's purpose line against its actual exports before committing — the one-liners are best-effort from package role and must be verified, not assumed.
