# Mental Model Page — Design

**Date:** 2026-05-10
**Status:** Approved
**Scope:** apps/web — new `/docs/mental-model` page (Phase A.1 of the docs content pass)

## Problem

Readers landing on the docs go straight from the marketing language on the landing page into a tutorial (`Getting Started`). Per-concept pages (Routes, Tools, State, Middleware, Retry, Agents) cover their pieces well but assume the reader already has a mental model of how the pieces fit together. There's no page that says, in one read, *what Dawn is, what it does, what it doesn't do, and where each piece sits*.

This is the missing-middle layer. Phases A.2 (API Reference), A.3 (Recipes), and A.4 (FAQ) all benefit from being able to point at this page for "the model".

## Goals

- One new page at `/docs/mental-model`. Sits in the "Get Started" sidebar group, immediately after "Getting Started".
- Reads as a single sitting (~180–220 lines).
- Tone matches the author's existing voice — short, declarative, no hedge words, definition-by-contrast, `tl;dr` up top.
- Establishes the vocabulary other pages use: *route*, *route entry*, *tool*, *state*, *middleware*, *agent / workflow / graph / chain*.
- Closes with three numbered "next reads" so the page is a working router into the rest of the docs.

## Non-goals

- Not an API reference. No type signatures or full prop tables — those land in Phase A.2.
- Not a tutorial. No "now run this command" steps — those live in Getting Started.
- Not changing any other docs page.
- Not building a diagram component. The runtime flow is rendered as a fenced `text` code block (ASCII), not SVG.
- Not adding `mental-model.mdx` to the search index manually — `search-index.ts` reads from `DOCS_NAV`, so adding the entry there is enough.

## Approach

### Page outline

The page is one MDX file at `apps/web/content/docs/mental-model.mdx` with this section list:

1. **Lede** — 4–6 lines. What Dawn is. What it isn't. Why it exists. Closes with the one-liner: "Dawn writes those conventions once. You write the agent."
2. **`## tl;dr`** — six-bullet list, parallel structure, names every primitive (route, route entry, tool, state, middleware, runtime split).
3. **`## The pieces`** — five short paragraphs. One per primitive: Routes / Route entries / Tools / State / Middleware. Each paragraph is one sentence of definition, one sentence of where it lives on disk, one sentence of where it links into the rest. No code blocks here.
4. **`## The runtime`** — ASCII flow diagram of `dawn run "/hello/acme"` followed by a numbered list explaining each arrow.
5. **`## Build vs runtime`** — two short paragraphs.
   - Build: `dawn build` / `dawn typegen` produce the type registry, route registry, and tool schemas.
   - Runtime: `dawn dev` / `dawn run` execute. State init → middleware → route entry → tools → output.
6. **`## Where Dawn ends and LangGraph begins`** — two-column markdown table.
   - **Dawn owns:** routing, type inference, dev tooling, deployment protocol adapter
   - **LangGraph owns:** the graph runtime, persistence, Platform deployment
   - Closing line: "Dawn deletes the boilerplate. Not your stack."
7. **`## What to read next`** — three numbered options:
   1. "I want to build now" → Getting Started
   2. "I want to understand a piece" → Concepts > {Routes, Agents, Tools, State, Middleware, Retry}
   3. "I want the API surface" → API Reference *(forward link, expected next)*
8. **`## Related`** — bulleted cross-links to Routes, Agents, Tools, Dev Server.

### Voice rules

The page is written to match the author's existing blog voice. Concretely:

- Short, declarative sentences. One per line where it earns the rhythm.
- **Definition by contrast.** "X is not Y. It is Z." Use sparingly; one or two times in the lede, once in the boundary section.
- **Negation-then-affirm.** "Not because A. Not because B. It exists because C." Reserved for the lede.
- No hedge words: drop "you can", "you should", "you might". Use imperatives or declaratives.
- No marketing language: no "blazingly fast", no "instant", no "magical".
- Active voice. Verbs over adjectives.
- One bolded one-liner per major section as a turning point. No more than three across the page.
- First-person ("I think", "For me") only if it earns its place in the section. Default is third-person framing.

### Sidebar update

`apps/web/app/components/docs/nav.ts` gets one new entry:

```ts
{
  label: "Get Started",
  items: [
    { label: "Getting Started", href: "/docs/getting-started" },
    { label: "Mental Model", href: "/docs/mental-model" },   // NEW
  ],
},
```

### Route page

A new `apps/web/app/docs/mental-model/page.tsx` mirroring the existing pattern (see `apps/web/app/docs/agents/page.tsx`):

```tsx
import type { Metadata } from "next"
import Content from "../../../content/docs/mental-model.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Mental Model" }

export default function Page() {
  return <DocsPage href="/docs/mental-model" Content={Content} />
}
```

### Search index

`search-index.ts` reads MDX at module init based on `DOCS_NAV` entries. Adding the nav entry causes the index to pick up the new page without code changes.

## Architecture

```
apps/web/
├── app/
│   ├── docs/
│   │   └── mental-model/
│   │       └── page.tsx              # NEW
│   └── components/docs/
│       └── nav.ts                    # MODIFIED — add Mental Model to Get Started
└── content/docs/
    └── mental-model.mdx              # NEW
```

Three files. ~200 lines of new content, ~3 lines of nav change.

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes.
- **Manual smoke:**
  - Visit `/docs/mental-model`. Page renders end-to-end with the planned section list.
  - Sidebar shows "Mental Model" under "Get Started".
  - All cross-links point to existing pages (Routes, Agents, Tools, State, Middleware, Retry, Dev Server, Getting Started). No 404s.

## Migration risk

None. Pure additive change. No URL rewrites; no edits to existing pages.

## Open items deferred to plan

- Whether to add a `promptSlug` for "explain mental model" — skip for now; not part of the established prompt set.
- Whether the "What to read next" section's link to the (future) API Reference page should be live now (404) or omitted until Phase A.2 lands. Default: **omit until A.2** — broken links are worse than a missing forward reference.
