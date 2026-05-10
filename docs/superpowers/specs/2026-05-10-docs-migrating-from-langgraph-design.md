# Migrating from LangGraph — Design

**Date:** 2026-05-10
**Status:** Approved
**Scope:** apps/web — new `/docs/migrating-from-langgraph` page (Phase C of the docs content pass)

## Problem

Dawn's whole positioning is "a meta-framework for LangGraph." Every team Dawn targets either has an existing LangGraph project they want to convert, or has been weighing LangGraph and wants to know the migration cost upfront. The docs do not currently answer either question.

The Mental Model page explains *what Dawn is*. The FAQ states the boundary at one-line resolution. Neither shows what an actual conversion looks like — file-tree before/after, code construct mappings, the gotchas a team will hit.

## Goals

- One new page at `/docs/migrating-from-langgraph`. Sits under "Get Started" in the sidebar, after "Mental Model".
- Reads as a single sitting (~250–300 lines). Longer than Mental Model because the content is genuinely longer; shorter than a full tutorial.
- Before/after code blocks per major construct so the reader sees the shape of the move, not just the description.
- Tone matches existing docs voice: short declarative, definition by contrast, no hedging.
- Closes with three numbered "what to read next" routes.

## Non-goals

- Not an exhaustive translation table. The reader sees the canonical move per construct; edge cases stay in the concept pages.
- Not a tooling page. No "now run this script" — there is no migration codemod.
- Not a comparison ("LangGraph alone vs LangGraph + Dawn"). That's the FAQ's territory.
- No edits to other pages.

## Approach

### Page outline

The page is one MDX file at `apps/web/content/docs/migrating-from-langgraph.mdx`:

1. **Lede** — 5–7 lines. Who this page is for. The boundary: Dawn does not replace LangGraph. Migration is mostly *moving code*, not rewriting it.
2. **`## tl;dr`** — six-bullet list, parallel structure: what stays the same, what moves, what's deleted (boilerplate).
3. **`## The shape of the move`** — file tree before/after (two fenced `text` blocks side-by-side as separate code blocks). The shape: `graphs/`, `tools/`, `agents/` flat directories become folder-routes under `src/app/`.
4. **`## Construct by construct`** — five H3 sections with before/after fenced code blocks:
   - **`### StateGraph → route`** — graph builder collapses into folder + `index.ts` exporting `graph`/`workflow`/`agent`/`chain`. The graph itself is unchanged; what disappears is the registration boilerplate.
   - **`### TypedDict / Pydantic state → state.ts`** — typed state moves to a sibling `state.ts`. Dynamic segments become fields automatically.
   - **`### Tools (`@tool`, `BaseTool`) → `tools/X.ts`**` — co-located typed functions; type inference at build replaces hand-written schemas.
   - **`### Conditional edges and routing → middleware + dispatch`** — request-level branching moves to `middleware.ts`; graph-level conditional edges stay where they are.
   - **`### `langgraph.json` → `dawn build`**` — generated `dawn.generated.d.ts` and `.dawn/build/langgraph.json` replace the hand-maintained config.
5. **`## What stays exactly the same`** — short bullet list: LangSmith, checkpointer/persistence, model providers, LangChain ecosystem packages, deployment to LangGraph Platform.
6. **`## Migration order`** — three-step playbook:
   1. Scaffold a Dawn project alongside the existing one (`dawn create`).
   2. Move one graph at a time, route by route. Run both projects side by side until parity.
   3. Cut over deployment last.
   - One paragraph per step.
7. **`## What to read next`** — three numbered options:
   1. "I want to scaffold a Dawn project now" → Getting Started
   2. "I want the boundary in one page" → Mental Model
   3. "I want construct-level depth" → Routes / Agents / Tools / State / Middleware
8. **`## Related`** — bulleted cross-links to Mental Model, Routes, Tools, FAQ.

### Voice rules

Same as Mental Model and FAQ:

- Short, declarative sentences. One per line where rhythm earns it.
- Definition by contrast where it earns its place.
- No hedge words ("you can", "you might"). Imperatives or declaratives.
- No marketing language. No "magical", no "instant".
- Active voice. Verbs over adjectives.
- Code blocks carry the weight where they can.

### Code-block accuracy

Before/after blocks must be runnable LangGraph and runnable Dawn. Read these for source-of-truth:

- LangGraph current API: check `node_modules/@langchain/langgraph/` types or use a concrete reference example
- Dawn shape: existing concept pages (`routes.mdx`, `agents.mdx`, `state.ts`, `tools.mdx`, `middleware.mdx`) and `apps/web/content/docs/getting-started.mdx`

If a specific LangGraph API surface is uncertain, prefer the canonical pattern (StateGraph + addNode + addEdge) over the trendy one. The reader needs to recognize their own code.

### Sidebar update

`apps/web/app/components/docs/nav.ts` — append to "Get Started":

```ts
{
  label: "Get Started",
  items: [
    { label: "Getting Started", href: "/docs/getting-started" },
    { label: "Mental Model", href: "/docs/mental-model" },
    { label: "Migrating from LangGraph", href: "/docs/migrating-from-langgraph" },  // NEW
  ],
},
```

### Route page

`apps/web/app/docs/migrating-from-langgraph/page.tsx` — standard 9-line shim.

### Search index

`search-index.ts` reads from `DOCS_NAV` at module init — adding the nav entry is sufficient.

## Architecture

```
apps/web/
├── app/
│   ├── docs/
│   │   └── migrating-from-langgraph/
│   │       └── page.tsx              # NEW
│   └── components/docs/
│       └── nav.ts                    # MODIFIED — add Migrating entry
└── content/docs/
    └── migrating-from-langgraph.mdx  # NEW
```

3 files. ~280 lines of new content, ~1 line of nav change.

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes.
- **Manual smoke:**
  - Visit `/docs/migrating-from-langgraph`. Page renders end-to-end.
  - Sidebar shows entry under Get Started after Mental Model.
  - All before/after code blocks render with syntax highlighting.
  - Cross-links resolve (no 404s).
  - Mobile (390x844): page wraps cleanly, code blocks scroll horizontally.

## Migration risk

None. Pure additive change. No URL rewrites; no edits to existing pages.

## Open items deferred to plan

- Whether to add a `promptSlug` for the migration page — skip for now.
- Whether to include a sample full project diff (full project tree before, full after) — defer; too long for an in-page asset, would belong on the repo.
