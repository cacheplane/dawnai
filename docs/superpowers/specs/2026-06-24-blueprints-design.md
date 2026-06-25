# Blueprints (`dawn add`) — Design

**Date:** 2026-06-24
**Status:** Approved (design), pending spec review
**Scope:** Sub-project C of the eve/flue competitive-learnings sequence (item 1).
**Branch:** `blove/blueprints` (off `main`; includes A and B).

## Goal

Give Dawn flue's highest-leverage distribution idea: **integration blueprints** —
Markdown guides, served from `dawnai.org`, that a coding agent applies to a
user's Dawn project to wire in an external system. `dawn add <name>` fetches the
guide and prints it for the agent to execute. v1 ships the mechanism + four real
exemplar blueprints; the catalog grows later without a CLI release.

## What a blueprint is (and isn't)

A blueprint is a Markdown implementation guide for an AI coding agent — **not** an
npm package or a runtime abstraction. The CLI fetches and prints the guide; the
coding agent edits the user's project. This mirrors flue's model and Dawn's own
`content/prompts/` (paste-into-your-agent) precedent, but for *integrations*
rather than framework patterns (which already live in `docs/recipes/`).

## Addressing & identity (research-driven)

A deep survey of seven analogous systems (context-hub, shadcn, astro add,
create-astro, degit, the MCP registry, flue) found that **six of seven address
items by a flat name and treat category as frontmatter/structure-only metadata —
never as part of the address.** flue is the lone outlier (`flue add <kind>
<name>`). Dawn follows the majority:

- **Address is the flat name:** `dawn add opentelemetry` (no `kind` segment).
- **Identity = the filename.** Names are unique across the whole catalog.
- **Category = the directory** (`observability/`, `retrieval/`, `deploy/`),
  derived for `dawn add` listing/grouping only — never in the address or URL.
- The one case where flue's kind-in-address earns its keep is cross-category
  **name collisions** (a `postgres` that is both a database and a sandbox). Our
  catalog has none, so a flat name is safe. If a collision ever arises, the
  escape hatch is a `@scope/name` namespace (shadcn/MCP style), not a kind
  segment.

## File layout & frontmatter

```
apps/web/content/blueprints/
  observability/
    opentelemetry.md     → dawn add opentelemetry → https://dawnai.org/blueprints/opentelemetry.md
  retrieval/
    pgvector.md          → dawn add pgvector
    pinecone.md          → dawn add pinecone
  deploy/
    docker.md            → dawn add docker
```

Allowed categories (v1): `observability`, `retrieval`, `deploy`.

Frontmatter (YAML). `name` derives from the filename and `category` from the
directory — neither is declared. Only `description` is required:

```yaml
---
description: Add OpenTelemetry tracing to a Dawn app.   # required — LLM-oriented; feeds the listing
website: https://opentelemetry.io                        # optional — provider homepage
version: 1                                               # optional (default 1) — reserved for upgrades
tags: [tracing, otel]                                    # optional — filtering
source: official                                         # optional — official | maintainer | community
---
```

`source` is a trust level (context-hub convention), not a URL. All v1 exemplars
are `official`. `version` + the file marker are the only upgrade seams kept;
**there is no `## Upgrade Guide` / cumulative-diff machinery in v1** (deferred).

## Body template (canonical guide structure)

Each blueprint body is an agent-facing guide. Core sections are expected;
situational ones vary by integration (validation is light — see below).

1. `# Add <X> to your Dawn app` — title *(core)*
2. **Role + intent** — "You are an AI coding agent adding X… It does Y; it does
   **not** Z." (scope boundary) *(core)*
3. **Prerequisites / when not to apply** — hard stop conditions *(core)*
4. **Inspect the project** — detect package manager; find `appDir` from
   `dawn.config.ts`; read `AGENTS.md`; check for an existing install (the
   marker); learn env/secret conventions *(core — makes it adaptive)*
5. **Install dependencies** — pinned; reuse if present; ask before consequential
   *(core)*
6. **Create the file(s)** — complete ready-to-write code; the primary generated
   file's first line is the marker `// dawn-blueprint: <name>@<version>`;
   Dawn-specific placement (`<appDir>/<route>/tools/<x>.ts`, `src/lib/<x>.ts`,
   root `Dockerfile`) *(core)*
7. **Wire into your app** — attach the tool to a route / add instrumentation to
   the entry / add the build step *(situational)*
8. **Configure environment** — env vars; never hardcode; follow project
   conventions; update `.env.example` *(situational)*
9. **Verify** — concrete steps (`dawn verify` / `dawn build` / `dawn dev` + an
   integration-specific check) *(core)*
10. **Updating an existing install** — one paragraph: compare against this guide,
    preserve customizations, re-stamp the marker (the seam for a future
    `dawn update`) *(core)*

The **marker** drops kind, matching identity: `// dawn-blueprint:
opentelemetry@1` (comment syntax matches the primary file's language; a blueprint
whose primary artifact has no natural comment line — rare — may omit it and rely
on comparison for updates).

## Delivery: served, not bundled

`dawn add` **fetches over the network** from `dawnai.org`, like every comparable
tool (`npx shadcn add`, `astro add`, `flue add`). This is deliberately different
from sub-project B (which *bundles* version-matched docs in the CLI): a blueprint
is "apply the current best guide," so **freshness beats version-match**, and a
blueprint can be added or fixed without a CLI release. The base URL is
`https://dawnai.org` by default, overridable via `DAWN_BLUEPRINTS_URL` (for tests
and self-hosting).

> **Decision (ratified):** served-vs-bundled was reviewed explicitly. Serving is
> the deliberate counterpart to sub-project B's bundling: docs are tightly
> coupled to the installed version (bundle, like eve), blueprints are loosely
> coupled and benefit from freshness + release-free growth (serve, like flue).

## Components

### 1. Blueprint content (`apps/web/content/blueprints/<category>/<name>.md`)
Four exemplars across three categories and three integration *shapes*:
- `retrieval/pgvector.md` — adds a pgvector-backed retrieval **tool**
  (`tools/<x>.ts`). The most Dawn-native shape.
- `retrieval/pinecone.md` — a Pinecone retrieval **tool**. Proves two blueprints
  in one category (listing/grouping; category ≠ identity).
- `observability/opentelemetry.md` — **instruments** the app (a `src/lib` module
  + entry wiring). A cross-cutting shape.
- `deploy/docker.md` — a root `Dockerfile` (+ `.dockerignore`) **artifact** for
  self-hosting. A deploy shape.

### 2. Serving routes (`apps/web`)
- `app/blueprints/[name]/route.ts` — resolves `<name>` to its
  `content/blueprints/<category>/<name>.md`, strips frontmatter, returns the body
  as `text/markdown`. 404 with a short JSON/text error if unknown.
- `app/blueprints/index.json/route.ts` — scans the content tree at request time
  (like the existing `llms-full.txt` route) and returns the catalog:
  `[{ name, category, description, website, version, tags, source, url }]`. No
  generated file to keep in sync.

### 3. `dawn add` command (`packages/cli/src/commands/add.ts`)
`registerAddCommand(program, io)` + `runAddCommand(args, io)`, wired in
`src/index.ts`. Behavior:
- `dawn add <name>` → GET `<base>/blueprints/<name>.md`; on 200, print a short
  header (`# Apply this Dawn blueprint: <name>` + a one-line "hand this to your
  coding agent" note) then the guide body to **stdout**. On 404, fetch the index
  and print `Unknown blueprint "<name>"` + the available list to stderr; exit
  nonzero (`CliError`).
- `dawn add <url>` → if the arg is an absolute URL, fetch and print it verbatim
  (ad-hoc / third-party blueprints).
- `dawn add` (no arg) → fetch the index and print the catalog grouped by
  category, each line `  <name> — <description>`.
- Base URL from `DAWN_BLUEPRINTS_URL` else `https://dawnai.org`. Uses global
  `fetch` (Node ≥ 22). Network/HTTP errors surface as `CliError` with a clear
  message. Output via the existing `CommandIo` (`io.stdout`/`io.stderr`,
  `writeLine`).

### 4. Validator (`scripts/check-blueprints.mjs`, run in CI alongside check-docs)
- Every `content/blueprints/*/*.md`: directory ∈ allowed categories; filename
  (name) unique across all categories; `description` present and non-empty;
  `version` (if present) a positive integer; `source` (if present) ∈
  {official, maintainer, community}; `website` (if present) parses as a URL;
  `tags` (if present) an array. Body must contain an `# H1`.
- **Light on prose:** it does not police situational sections — only frontmatter,
  naming/category rules, and the H1.
- Add the script to the CI `validate`/docs gate.

### 5. Docs (`apps/web/content/docs/blueprints.mdx` + nav)
A docs page covering `dawn add` usage and the blueprint authoring conventions
(frontmatter, layout, body template, marker). Because it lives under
`content/docs`, it automatically ships in the bundled CLI docs (sub-project B)
and `llms-full.txt`. Add it to `DOCS_NAV`.

## Testing

- **CLI (`packages/cli/test/add-command.test.ts`)**: inject `DAWN_BLUEPRINTS_URL`
  pointed at a tiny in-test fixture server (or a fetch stub): `dawn add <name>`
  prints the guide body; `dawn add` (no arg) prints the grouped catalog;
  unknown name → `CliError` + lists available; absolute-URL arg fetches verbatim;
  network error → `CliError`.
- **Validator (`scripts/`/colocated test)**: a fixture blueprint with a missing
  `description`, a bad `source`, a duplicate name, and a bad category each fail;
  a well-formed one passes.
- **Routes (`apps/web`)**: `/blueprints/<name>.md` returns the body with
  frontmatter stripped; `/blueprints/index.json` returns the catalog with derived
  `name`/`category`; unknown name 404s.
- The four shipped blueprints pass the validator (and a test asserts the catalog
  has 4 entries across 3 categories).

## Out of scope (YAGNI / deferred)

- Cumulative `## Upgrade Guide` diffs and a `dawn update <name>` command (the
  `version` field + marker are reserved seams; the mechanism is deferred).
- `@scope/name` third-party namespacing (escape hatch noted; not built).
- A human-browsable `/blueprints` HTML gallery page (only the `.md` + `index.json`
  machine endpoints in v1).
- Channel/sandbox blueprints — they need Dawn primitives that don't exist yet.
- Bundling blueprints into the CLI (deliberately served; see Delivery).

## Risks

- **Network dependency:** `dawn add` requires connectivity. Mitigated by clear
  error messages and the `DAWN_BLUEPRINTS_URL` override; consistent with every
  comparable tool.
- **Content/CLI version skew:** a served guide may reference a CLI feature a user
  hasn't upgraded to. Mitigated by `version` frontmatter and guides that prefer
  inspecting the project over assuming a version; full upgrade safety is the
  deferred `dawn update` work.
- **Catalog drift / quality:** the `check-blueprints.mjs` gate enforces structure;
  prose quality is a review concern, as with docs.
