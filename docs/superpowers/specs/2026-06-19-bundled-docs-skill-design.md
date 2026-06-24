# Bundled Docs + SKILL.md — Design

**Date:** 2026-06-19
**Status:** Approved (design), pending spec review
**Scope:** Sub-project B of the eve/flue competitive-learnings sequence (item 2).
**Branch:** `blove/bundled-docs-skill` (off `main`; independent of sub-project A).

## Goal

Make Dawn agent-authorable the way eve is: ship the Dawn documentation **inside
the installed `@dawn-ai/cli` package** as a navigable, version-matched markdown
tree, plus a discoverable `SKILL.md`, so a coding agent working in a user's Dawn
project can read the docs **locally, offline, and matched to the installed
version** — no network fetch, no version drift.

## Background

Dawn already serves agent-facing docs over HTTP (`llms.txt`, `llms-full.txt`,
`/AGENTS.md`, `/prompts/[slug]`) generated from `apps/web/content/docs/*.mdx`.
What it lacks — and what eve's `node_modules/eve/docs` + `SKILL.md` provides — is
a **local, version-matched** copy that travels with the installed framework. The
served docs can drift from whatever version a user has installed; a bundle in the
package cannot.

Findings that shape the design:

- The two packages present in every Dawn app are `@dawn-ai/cli` (devDep — the
  `dawn` binary) and `@dawn-ai/sdk` (runtime dep). **Decision: host in
  `@dawn-ai/cli`** — it's the tool agents already invoke, and it can expose a
  `dawn docs` affordance. Avoids new-package bootstrap friction (OIDC can't
  auto-create packages; the `fixed` changeset group versions every package
  together).
- The CLI registers subcommands via `registerXCommand(program, io)` modules in
  `packages/cli/src/commands/*.ts`, wired in `packages/cli/src/index.ts`
  (commander).
- `packages/cli/package.json` has `files: ["dist"]` — packaged files are an
  allowlist, so `docs` and `SKILL.md` must be added explicitly.
- Doc order/labels come from `DOCS_NAV` in
  `apps/web/app/components/docs/nav.ts`.
- Scaffolded apps ship only `workspace/AGENTS.md` (agent *memory*, injected into
  prompts) — there is **no root coding-agent `AGENTS.md`** in generated apps
  today.

## Design decisions (locked during brainstorming)

1. **Delivery:** bundle in the installed `@dawn-ai/cli` package (eve's model).
2. **Form:** a navigable tree — one `.md` per topic + a `README.md` index —
   generated from the existing MDX pages.
3. **Discovery (all three):** a `dawn docs` command, a package `SKILL.md`, and a
   scaffolded root `AGENTS.md` pointer in new apps.
4. **Generation:** generate-on-build from `apps/web/content/docs`, gitignored,
   with `pnpm pack:check` extended to assert the tree ships in the tarball.

## Architecture & data flow

```
apps/web/content/docs/*.mdx ──(scripts/generate-cli-docs.mjs)──▶ packages/cli/docs/  (gitignored, packed)
  + apps/web/app/components/docs/nav.ts (order)                   ├── README.md   (index, DOCS_NAV order)
                                                                  ├── getting-started.md, routes.md, tools.md, …
                                                                  └── recipes/*.md
packages/cli/SKILL.md  (committed pointer) ─────────────────────▶ "read docs/README.md — it matches your installed version"
dawn docs [topic] ──▶ resolves <cli>/docs from its own module path; lists or cats a topic
create-dawn-app templates ──▶ root AGENTS.md with the bundled-docs pointer
```

Version-matching is automatic: the tree is regenerated on every CLI build and
shipped with that version's tarball; a consumer's `node_modules/@dawn-ai/cli/docs`
always matches their installed CLI.

## Components

### 1. Generator — `scripts/generate-cli-docs.mjs`

A repo-level Node script (run as part of the CLI build, not inside `tsc`).

- **Input:** globs `apps/web/content/docs/**/*.mdx`; reads topic order and labels
  from `apps/web/app/components/docs/nav.ts` by extracting `href: "/docs/<slug>"`
  entries via regex (no TS import — avoids making `apps/web` a build dependency of
  the CLI).
- **Output (gitignored):** `packages/cli/docs/<slug>.md` per page,
  `packages/cli/docs/recipes/<slug>.md` for the recipes subtree, and
  `packages/cli/docs/README.md` — an index grouped by `DOCS_NAV` section, each
  entry linking the topic file with its frontmatter `description`, prefixed by a
  short header ("Version-matched Dawn reference for coding agents. Run
  `dawn docs <topic>` or open these files directly.").
- **Transform (v1, deliberately minimal):** strip YAML frontmatter (promote
  `title` to a leading `# H1`); drop `import`/`export` lines; drop pure-nav
  self-closing components (`<RelatedCards … />`). Leave all other content
  verbatim, including fenced code blocks and any remaining inline components —
  this matches what `llms-full.txt` already ships and what agents already
  tolerate. Richer MDX→markdown cleanup (e.g. `<Callout>`→blockquote,
  `<Tabs>`/`<Steps>` flattening) is an explicit follow-up, not v1.
- **Coverage:** every source `.mdx` page produces exactly one output `.md`
  (parity is asserted in tests).

### 2. `packages/cli/SKILL.md` (committed, hand-authored)

Skill-format file modeled on eve's:

```md
---
name: dawn
description: Build AI agents and workflows with the Dawn framework — the TypeScript meta-framework for LangGraph. Use when creating, editing, or debugging a Dawn app (routes, tools, state, agents, workflows, testing, deployment).
---

# Dawn

Dawn is the TypeScript meta-framework for LangGraph. Agents and workflows are
file-system routes under `src/app/`.

## Source of truth

The complete, version-matched Dawn documentation ships inside this package at
`docs/`. Always read the bundled docs — they match the installed version exactly.

- Start with `docs/README.md` (the index and recommended reading order).
- Or run `dawn docs` to list topics and `dawn docs <topic>` to read one.

Do not rely on this file's prose for API detail; read the bundled docs first.
```

### 3. `dawn docs` command — `packages/cli/src/commands/docs.ts`

`registerDocsCommand(program, io)`, wired into `src/index.ts` next to the other
`register*` calls.

- `dawn docs` → resolve the docs directory from the command module's own location
  (`new URL("../../docs", import.meta.url)` from the built `dist`, falling back as
  needed so it resolves to `<cli-package>/docs`), print that absolute path, and
  list available topics (derived from the files in `docs/`, in `README.md` order).
- `dawn docs <topic>` → print the contents of `docs/<topic>.md` to stdout (so an
  agent can read it directly). `<topic>` accepts the slug (`tools`) and tolerates
  a `.md` suffix.
- **Errors:** unknown `<topic>` → write a friendly message listing available
  topics to stderr and exit nonzero. Missing `docs/` dir (e.g. running from source
  before generation) → message hinting to build the CLI; exit nonzero.
- Output goes through the existing `io` abstraction the other commands use.

### 4. Scaffolded root `AGENTS.md`

Add a **thin** `AGENTS.md` to `packages/devkit/templates/app-basic/` and
`packages/devkit/templates/app-research/` (the dirs `create-dawn-app` copies). It
contains a short coding-agent preamble, a handful of the most load-bearing Dawn
rules (route = folder with `index.ts` exporting one of `agent`/`workflow`/`graph`/
`chain`; tools co-located in `tools/`; never edit `.dawn/dawn.generated.d.ts`),
and a pointer:

> **Full, version-matched reference:** run `dawn docs` to list topics or
> `dawn docs <topic>` to read one (e.g. `dawn docs tools`). The same docs are at
> `node_modules/@dawn-ai/cli/docs/` — start with `docs/README.md`.

It intentionally does **not** duplicate the full convention reference (which now
lives in the bundle), keeping drift low.

### 5. Packaging & verification

- `packages/cli/package.json`: `files` += `"docs"`, `"SKILL.md"`.
- Wire generation into the CLI build so both `pnpm build` and publish produce the
  tree before packing — e.g. a `prebuild`/`prepack` step (`node
  ../../scripts/generate-cli-docs.mjs`) ahead of `tsc -b`. The exact hook is
  pinned in the plan; the contract is "docs exist before pack/publish."
- `.gitignore`: add `packages/cli/docs/`.
- Extend `scripts/pack-check.mjs` to assert the `@dawn-ai/cli` tarball contains
  `SKILL.md`, `docs/README.md`, and a sample of topic files
  (e.g. `docs/getting-started.md`, `docs/tools.md`).

## Testing

- **Unit (generator):** feed a sample MDX string (frontmatter + a `<Callout>` +
  `<RelatedCards … />` + a fenced code block) and assert: frontmatter stripped,
  `title` promoted to `# H1`, `import`/`export`/`<RelatedCards>` removed, code
  fence preserved verbatim.
- **Unit (coverage parity):** the generator emits exactly one `.md` per source
  `.mdx` page, and a `README.md` index that references every topic.
- **Integration (`dawn docs`):** lists topics; `dawn docs tools` prints the tools
  doc; resolves the docs path from the package location; unknown topic exits
  nonzero with the topic list.
- **Pack:** the extended `pack:check` assertion (above).

## Out of scope (YAGNI)

- Task-specific prompts and the AGENTS.md *template* are not bundled in v1 (doc
  pages are the core).
- No rich MDX-component→markdown conversion beyond the minimal strip.
- No relocation of the canonical docs out of `apps/web` — the generator reaching
  into `apps/web/content/docs` is an accepted v1 coupling; extracting a shared
  docs-content source is a noted follow-up.
- No publishing `SKILL.md` to an external skills marketplace — it ships in the
  package; installing it as an agent skill is the user's choice.

## Risks

- **`apps/web` coupling:** the CLI build reads from a sibling app's source. The
  generator uses only static `.mdx`/`.ts` files (no build of `apps/web` needed),
  and `pack:check` guarantees output is present, but the coupling is real and
  noted for a future shared-content extraction.
- **Generation not running before publish:** mitigated by wiring it into the CLI
  build hook AND the `pack:check` assertion (CI fails if docs are absent).
- **Doc drift while on this branch:** B branched off `main` without sub-project
  A's doc edits; once both land, the generator simply re-reads the merged docs —
  no special handling needed.
