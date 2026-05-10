# Recipes — Design

**Date:** 2026-05-10
**Status:** Approved
**Scope:** apps/web — new `/docs/recipes` section (Phase A.3 of the docs content pass)

## Problem

The conceptual docs (Routes, Agents, Tools, State, Middleware, Retry) explain *what each piece is*. The API Reference (Phase A.2) lists *what's exported*. Neither answers the question a reader has when they sit down to extend their own project: *"How do I do X?"*

Today, that question gets answered by stitching together two or three concept pages. Recipes collapse that into one page per task — copy-paste code, the gotcha, a link back to the deeper concept page if needed.

## Goals

- A new top-level sidebar group "Recipes" between Tooling and Reference.
- Six initial recipe pages, each ~60–120 lines, single sitting.
- One overview page at `/docs/recipes` that lists all recipes with a one-line description each.
- Tone matches the established blog voice: short, declarative, code-first. Recipe lede is literally the user's goal restated.
- Every recipe ends with a Related section linking to the conceptual page(s) it builds on.

## Non-goals

- Not a tutorial sequence — recipes are independent, not ordered.
- Not exhaustive — six is the seed set; more can land later as the surface grows.
- Not changing existing pages (no edits to Tools, State, Middleware, Retry, Dev Server, Deployment).
- Not adding a card-grid component — index uses a bulleted list.
- Not adding a search-index entry per recipe manually — `search-index.ts` reads from `DOCS_NAV`, so adding entries there is sufficient.

## Approach

### Recipe set

Six recipes, chosen to cover the highest-frequency "how do I…" questions without overlapping deployment.mdx or testing.mdx:

1. **`add-a-tool`** — author a tool: `tools/X.ts`, default-exported async fn, type inference at build, calling it from a route.
2. **`typed-state`** — declare `state.ts`, capture dynamic segments (`[tenant]`), read state in tools via `RuntimeContext`.
3. **`auth-middleware`** — `middleware.ts` short-circuit pattern, reading headers, mutating state, nearest-ancestor wins.
4. **`stream-output`** — call `/runs/stream` from a route, the SSE frame shape, when to use it vs `/runs/wait`.
5. **`retry-flaky-tools`** — `retry: { maxAttempts, baseDelay }` at agent vs tool scope, what gets retried, link to retry concept page.
6. **`dispatch-from-route`** — programmatic dispatch via `ctx.dispatch('/path', state)` to call one route from inside another.

### Per-recipe structure

Every recipe MDX file follows this shape:

```
# <Recipe title>

<Goal: 1–2 sentences. "You want X. Here's how.">

## The code

<Single fenced code block — the canonical, copy-paste solution.>

## Notes

<2–4 bullets. The gotchas: scope rules, build-time vs runtime, common
mistakes. No conceptual deep dives.>

## Related

- [<Concept page>](/docs/<concept>) — one-line why
- [<Other concept page>](/docs/<concept>) — one-line why
```

Target: 60–120 lines per recipe. The tone rules from the Mental Model spec apply (short declarative sentences, no hedge words, definition by contrast where it earns its place).

### Overview page (`/docs/recipes`)

One page, ~40 lines:

```
# Recipes

<Lede: 2–3 sentences. What recipes are, how they relate to concept pages.>

## Available recipes

- [Add a tool](/docs/recipes/add-a-tool) — author a tool, get type-safe access from a route
- [Typed state](/docs/recipes/typed-state) — declare state shapes, capture dynamic segments
- [Auth middleware](/docs/recipes/auth-middleware) — short-circuit unauthorized requests
- [Stream output](/docs/recipes/stream-output) — incremental responses via /runs/stream
- [Retry flaky tools](/docs/recipes/retry-flaky-tools) — recover from transient failures
- [Dispatch from a route](/docs/recipes/dispatch-from-route) — call one route from another

## Related

- [Mental Model](/docs/mental-model) — the framework's shape
- [API Reference](/docs/api) — type signatures
```

### Routing

Static pages — one `page.tsx` per recipe. Cleaner than a dynamic `[slug]` route, makes per-page `Metadata` straightforward, matches the rest of the docs.

```
apps/web/app/docs/recipes/
├── page.tsx                       # NEW — overview
├── add-a-tool/page.tsx            # NEW
├── typed-state/page.tsx           # NEW
├── auth-middleware/page.tsx       # NEW
├── stream-output/page.tsx         # NEW
├── retry-flaky-tools/page.tsx     # NEW
└── dispatch-from-route/page.tsx   # NEW
```

Each page is the standard 9-line shim:

```tsx
import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/<slug>.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"

export const metadata: Metadata = { title: "<Recipe title>" }

export default function Page() {
  return <DocsPage href="/docs/recipes/<slug>" Content={Content} />
}
```

### Sidebar update

`apps/web/app/components/docs/nav.ts` gets a new group between Tooling and Reference:

```ts
{
  label: "Recipes",
  items: [
    { label: "Overview", href: "/docs/recipes" },
    { label: "Add a tool", href: "/docs/recipes/add-a-tool" },
    { label: "Typed state", href: "/docs/recipes/typed-state" },
    { label: "Auth middleware", href: "/docs/recipes/auth-middleware" },
    { label: "Stream output", href: "/docs/recipes/stream-output" },
    { label: "Retry flaky tools", href: "/docs/recipes/retry-flaky-tools" },
    { label: "Dispatch from a route", href: "/docs/recipes/dispatch-from-route" },
  ],
},
```

`DOCS_PAGES` (flat list for prev/next) and `breadcrumbsFor` continue to work without edits — they iterate `DOCS_NAV`.

### Search index

`search-index.ts` reads MDX at module init based on `DOCS_NAV` entries. Adding the nav entries causes the index to pick up the recipes automatically.

## Architecture

```
apps/web/
├── app/
│   ├── docs/
│   │   └── recipes/
│   │       ├── page.tsx                       # NEW — overview
│   │       ├── add-a-tool/page.tsx            # NEW
│   │       ├── typed-state/page.tsx           # NEW
│   │       ├── auth-middleware/page.tsx       # NEW
│   │       ├── stream-output/page.tsx         # NEW
│   │       ├── retry-flaky-tools/page.tsx     # NEW
│   │       └── dispatch-from-route/page.tsx   # NEW
│   └── components/docs/
│       └── nav.ts                             # MODIFIED — add Recipes group
└── content/docs/recipes/
    ├── index.mdx                              # NEW — overview
    ├── add-a-tool.mdx                         # NEW
    ├── typed-state.mdx                        # NEW
    ├── auth-middleware.mdx                    # NEW
    ├── stream-output.mdx                      # NEW
    ├── retry-flaky-tools.mdx                  # NEW
    └── dispatch-from-route.mdx                # NEW
```

15 new files, ~7 lines of nav change.

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes.
- **Manual smoke:**
  - Visit `/docs/recipes` — overview renders with all six links.
  - Visit each recipe URL — page renders end-to-end.
  - Sidebar shows the Recipes group between Tooling and Reference.
  - Prev/next links between recipes work (driven by `DOCS_PAGES` ordering).
  - All Related cross-links resolve (no 404s).
  - Mobile (390x844): each recipe renders cleanly, code blocks scroll horizontally, sidebar collapses behind hamburger.

## Migration risk

None. Pure additive change. No URL rewrites; no edits to existing pages.

## Open items deferred to plan

- Whether to add `promptSlug` for any recipes — skip for now; not part of the established prompt set.
- Whether to expand to more recipes (auth providers, custom model providers, etc.) — defer to a follow-up phase once the pattern is validated.
