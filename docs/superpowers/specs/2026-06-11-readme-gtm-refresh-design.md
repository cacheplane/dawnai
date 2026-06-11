# README GTM Refresh — Design

**Date:** 2026-06-11
**Status:** Approved (design), pending implementation plan

## Goal

Update the root and package README files to maximize go-to-market (GTM)
developer growth, without changing Dawn's core positioning. Optimize the
files that act as landing pages — the root `README.md` (GitHub) and every
published package `README.md` (npmjs.com) — for discoverability and funnel
conversion.

## Decisions (locked)

- **Positioning:** Keep the existing framing — Dawn is "the meta-framework
  for LangGraph." Do **not** reframe as a standalone agent framework. This
  preserves existing LangGraph/LangSmith search surface.
- **Package treatment:** Tiered.
  - **Tier-1 (developer-facing):** full landing-page READMEs.
  - **Tier-2 (transitive/internal):** consistent minimal-but-complete stubs
    so no published package renders blank on npm.
- **Growth levers (selected):**
  - Star / Docs / Discussions **CTA band**.
  - **SEO keyword pass** on headers and first paragraphs.
- **Growth levers (explicitly excluded):** npm version/download badges,
  time-to-wow quickstart restructuring.
- **Approach:** Polish in place. Preserve the hero gif, the "Without /
  With Dawn" comparison, and the quickstart in the root README.

## Current-state findings

- Root `README.md` leads with "The meta-framework for LangGraph." Good
  bones: hero gif, "Without / With Dawn" code comparison, quickstart,
  "Learn more" link list.
- "Learn more" links point at raw repo paths
  (`apps/web/content/docs/*.mdx`) instead of the live docs site.
- **5 published packages render blank on npm** (no README file):
  `@dawn-ai/workspace`, `@dawn-ai/permissions`, `@dawn-ai/sqlite-storage`,
  `@dawn-ai/testing`, `@dawn-ai/evals`.
- 6 more public packages have bare "internal package" stubs: `core`,
  `langgraph`, `devkit`, `vite-plugin`, `config-biome`, `config-typescript`.
- All 15 packages are `private: false` (published).
- Docs site: `https://dawnai.org/docs/...`. Community: GitHub Discussions
  (`https://github.com/cacheplane/dawnai/discussions`). No Discord/X.
- **Correction (verified during planning):** every published package's
  `package.json` already carries `repository`, `homepage`, and `bugs`, so
  npm sidebar links already render. The root `package.json` lacks them but
  is `private: true` (never published) — adding them has no npm GTM effect.
  The §5 package-metadata work item is therefore dropped.

## Package tiers

**Tier-1 (full landing READMEs):**

- `@dawn-ai/sdk`
- `@dawn-ai/cli`
- `create-dawn-ai-app`
- `@dawn-ai/langchain`

**Tier-2 (minimal-but-complete stubs):**

- `@dawn-ai/core`
- `@dawn-ai/langgraph`
- `@dawn-ai/devkit`
- `@dawn-ai/vite-plugin`
- `@dawn-ai/config-biome`
- `@dawn-ai/config-typescript`
- `@dawn-ai/workspace`  *(currently blank)*
- `@dawn-ai/permissions`  *(currently blank)*
- `@dawn-ai/sqlite-storage`  *(currently blank)*
- `@dawn-ai/testing`  *(currently blank)*
- `@dawn-ai/evals`  *(currently blank)*

## Work items

### 1. Root README

- **SEO keyword pass.** Weave high-intent terms into the H1 area, tagline,
  and the "Why Dawn?" section headers without changing positioning.
  Target terms: "TypeScript framework for LangGraph agents,"
  "filesystem-routed agents," "deploy agents to LangSmith." Keep
  "meta-framework for LangGraph" as the anchor line.
- **CTA band.** Insert the shared CTA band (see §4) just above "Learn
  more": Star on GitHub · Docs at dawnai.org · Ask in GitHub Discussions.
- **Learn more links.** Repoint the 8 doc links from
  `apps/web/content/docs/*.mdx` to `https://dawnai.org/docs/*`.
- **Preserve** the hero gif, "Without / With Dawn," and quickstart
  structurally.

### 2. Tier-1 package READMEs

Each Tier-1 README includes:

- Logo header (existing convention).
- SEO-tuned one-line description.
- Install section.
- One minimal, copy-paste example.
- Shared CTA band (§4).
- Doc links pointing to `https://dawnai.org/docs/*`.

Notes per package:

- `cli`, `sdk` — already close; primarily add SEO tuning + CTA band +
  fix doc links to dawnai.org.
- `create-dawn-ai-app`, `langchain` — flesh out to the full template.

### 3. Tier-2 package READMEs

Consistent template for all 11 (creating the 5 missing ones):

- Logo header.
- Package name (`# @dawn-ai/<name>`).
- 1–2 sentence purpose statement.
- "This is an internal Dawn workspace package" note.
- Link to docs: `https://dawnai.org/docs/getting-started` (live site, not the repo docs tree).
- License.

Outcome: no published package renders blank on npm.

### 4. Shared CTA band

Author once as canonical markdown, reuse verbatim:

- Root + Tier-1: full band — ⭐ Star on GitHub · 📚 Docs · 💬 Discussions.
- Tier-2: docs link only (not the full band), to keep stubs minimal.

Wording/emoji as sketched in brainstorming and approved by the user.

### 5. Supporting fixes — DROPPED

Verified during planning: all published packages already carry
`repository`, `homepage`, and `bugs`. The root `package.json` is
`private: true` and never published, so no metadata change is needed.
This work item is removed from the plan.

## Out of scope

- npm version/download badges.
- Restructuring the quickstart or time-to-wow flow.
- Any change to Dawn's positioning.
- Example app READMEs (`examples/**`).

## Success criteria

- No published package renders a blank README on npm.
- Root + Tier-1 READMEs carry a consistent CTA band funneling to GitHub
  stars, dawnai.org docs, and Discussions.
- Doc links resolve to the live docs site, not raw repo paths.
- High-intent SEO terms appear in root + Tier-1 headers/first paragraphs.
