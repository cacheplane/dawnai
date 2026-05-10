# Docs Content Pass — Phase B (Restructure + Polish)

**Date:** 2026-05-10
**Status:** Approved
**Scope:** apps/web — docs sidebar restructure, Agents page extraction, Routes trim, page-structure consistency

## Problem

The docs cover the Dawn surface area but the structure has accumulated friction:

- `routes.mdx` is overloaded: it contains explainers for Agents, Tools, State, and Middleware that duplicate (and drift from) the dedicated pages
- `Agents` is the default scaffolded export but has no dedicated page; it lives as a section inside `routes.mdx`
- Sidebar labels are misleading: `Workflow` groups Testing / Dev Server / Deployment, which are tooling, not workflow
- `Core Concepts` is verbose for a label
- Page structure is inconsistent: middleware has structured API reference; routes doesn't; testing mixes tutorial and reference

Phases A (fill missing pages) and C (LangGraph migration walkthrough) build on this restructure; Phase B is foundational and ships first.

## Goals

1. **Sidebar restructure.** Rename: `Start → Get Started`, `Core Concepts → Concepts`, `Workflow → Tooling`. Add an `Agents` entry under Concepts. Reorder Tooling so Dev Server comes first (matches the typical reading order: dev → test → deploy).
2. **Agents gets its own page.** Extract from `routes.mdx`; expand to cover the agent shape, tool auto-binding, retry config, and when to pick agent vs workflow vs graph vs chain.
3. **Trim `routes.mdx`.** Drop the dedicated Agents/Tools/State/Middleware mini-explainers; keep references to the dedicated pages instead. The page becomes a focused "what is a route, how do you write one, how do you call it" reference.
4. **Page structure consistency.** Every page follows: Lede → Canonical examples → Reference → Related.
5. **Tone polish.** Active voice, declarative, code-first, no forward references.

## Non-goals

- Phase A scope: no new mental-model page, no API reference page, no recipes/FAQ — those land in their own brainstorm + spec.
- Phase C scope: no migration walkthrough.
- No design changes — this is purely content + nav.
- Not changing the existing docs page count beyond adding `agents.mdx`.

## Approach

### B.1 — Sidebar restructure

Edit `apps/web/app/components/docs/nav.ts`:

```ts
export const DOCS_NAV: readonly DocsNavSection[] = [
  {
    label: "Get Started",
    items: [{ label: "Getting Started", href: "/docs/getting-started" }],
  },
  {
    label: "Concepts",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Agents", href: "/docs/agents" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Middleware", href: "/docs/middleware" },
      { label: "Retry", href: "/docs/retry" },
    ],
  },
  {
    label: "Tooling",
    items: [
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Testing", href: "/docs/testing" },
      { label: "Deployment", href: "/docs/deployment" },
    ],
  },
  {
    label: "Reference",
    items: [{ label: "CLI", href: "/docs/cli" }],
  },
]
```

The `DOCS_PAGES` flat list and `breadcrumbsFor` / `siblingsFor` helpers continue to work without changes — they iterate `DOCS_NAV`.

### B.2 — New `apps/web/content/docs/agents.mdx`

Outline:

```
# Agents

Lede: what an agent is — the default scaffold export, an LLM-driven route
that picks tools at runtime. Distinct from workflow/graph/chain.

## A minimal agent
  - Code example: agent({ model, systemPrompt })
  - Tool auto-binding from sibling tools/

## When to pick an agent
  - Comparison: agent (LLM picks tools) vs workflow (deterministic async)
    vs graph (LangGraph DSL) vs chain (LCEL)
  - One-line guidance for each

## Tool auto-binding
  - Tools in tools/ are auto-registered; the agent can call them
  - Type inference happens via dawn build / typegen

## Retry
  - retry: { maxAttempts, baseDelay } at the agent config level
  - Reference: link to /docs/retry

## Streaming
  - Default behavior: tool results stream
  - Pointer to dev-server.mdx for /runs/stream

## Related
  - Routes, Tools, State, Retry
```

Target: 90–120 lines, matching peer-page density.

### B.3 — New `apps/web/app/docs/agents/page.tsx`

Mirrors the existing pattern:

```tsx
import type { Metadata } from "next"
import Content from "../../../content/docs/agents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Agents" }

export default function Page() {
  return <DocsPage href="/docs/agents" Content={Content} />
}
```

(No `promptSlug` — agents prompt doesn't exist yet; we can add later.)

### B.4 — Trim `routes.mdx`

Final shape:

```
# Routes

Lede: routes are folders. The path is the agent endpoint.

## Route entry — the index.ts file
  - One of: agent, workflow, graph, chain
  - Type signatures (1-line each, link to the dedicated page)

## Pathname rules
  - Route groups, dynamic segments, catch-all (already covered)

## Running a route
  - dawn run, dawn dev, programmatic dispatch

## Related
  - Agents, Tools, State, Middleware
```

Removes ~40 lines of duplicated Agents/Tools/State/Middleware content. Each removed section is replaced by a one-line reference + link.

### B.5 — Page-structure consistency

Each page (10 existing + 1 new = 11 total) gets a pass to ensure:

1. **Lede** — 1–2 paragraphs at the top, no headings, explains what + why
2. **Canonical examples** — H2 sections starting with concrete code
3. **Reference / API** — H2 or H3 sections for type signatures (where applicable)
4. **Related** — final H2 with links to neighboring concept pages

Pages already mostly conform. The pass tightens lede paragraphs, removes forward references ("we'll cover this later"), and ensures every page has a Related section (currently only some do).

### Search index

`apps/web/app/components/docs/search-index.ts` reads MDX files from disk based on `DOCS_NAV` entries. Adding an Agents entry to `DOCS_NAV` causes the index to pick it up automatically — no code change needed.

## Architecture

```
apps/web/
├── app/
│   ├── docs/
│   │   └── agents/
│   │       └── page.tsx              # NEW
│   └── components/docs/
│       └── nav.ts                    # MODIFIED — relabel + add agents
└── content/docs/
    ├── agents.mdx                    # NEW
    ├── routes.mdx                    # MODIFIED — trim duplicates
    ├── getting-started.mdx           # POLISH (light)
    ├── tools.mdx                     # POLISH (light)
    ├── state.mdx                     # POLISH (light)
    ├── middleware.mdx                # POLISH (light)
    ├── retry.mdx                     # POLISH (light)
    ├── testing.mdx                   # POLISH (light)
    ├── dev-server.mdx                # POLISH (light)
    ├── deployment.mdx                # POLISH (light)
    └── cli.mdx                       # POLISH (light)
```

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes
- **Routes existence:** `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/docs/agents` returns 200
- **Sidebar smoke:** the new sidebar groups render with the relabeled section titles in the right order
- **Search smoke:** typing "agent" in the docs search returns the new Agents page

## Migration risk

Low.

- No URL changes for existing pages — only label renames in the sidebar
- The new Agents page is additive; no redirect needed
- Search index auto-rebuilds from `DOCS_NAV`
- Removed content from `routes.mdx` is preserved in `agents.mdx` (extracted)

The biggest concrete risk is the polish pass introducing inconsistencies if done unevenly. Mitigation: one subagent does all the polish in one pass following an explicit checklist.

## Open items deferred to plan

- Whether to add a `promptSlug` for agents (e.g., `add-an-agent`). Plan can include this if `apps/web/content/prompts/index.ts` allows easy addition; otherwise defer.
- Whether to update the landing's `<DocsSidebar>` reference cards to mention Agents. Out of scope for content pass.
