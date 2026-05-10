# FAQ — Design

**Date:** 2026-05-10
**Status:** Approved
**Scope:** apps/web — new `/docs/faq` page (Phase A.4 of the docs content pass)

## Problem

The docs cover what Dawn is, what each piece does, and how to do common tasks. They do not directly answer the questions a developer asks before adopting it: *Does this require LangGraph? Can I bring my own model provider? How does this compare to <X>? Is it production-ready? Does it support Python?*

These questions get asked in every new-user conversation. Centralizing the answers in one short page reduces repeat-explanations and gives prospective adopters a single place to scan.

## Goals

- One new page at `/docs/faq`. Sits under "Reference" in the sidebar.
- Short, opinionated answers. 2–4 sentences each. No hedging.
- Cover the highest-frequency questions only — about 10. The page should read in one sitting (~150 lines).
- Tone matches existing docs voice (short declarative, no marketing language).
- Each answer links to the deeper page where appropriate.

## Non-goals

- Not a troubleshooting guide. Specific error messages live in the relevant concept page or recipe.
- Not a roadmap document. Phase status questions point at the README/repo, not detailed milestones.
- Not exhaustive. If a question gets asked twice, it goes here. Otherwise it doesn't.
- No restructure of existing docs.

## Approach

### Question set

10 questions, grouped by audience. Order roughly tracks when a reader would ask:

**Adopting Dawn**
1. Do I have to use LangGraph?
2. Can I bring my own model provider?
3. How does Dawn compare to Mastra / CopilotKit / Vercel AI SDK?
4. Does Dawn support Python?
5. Is Dawn production-ready?

**Working in Dawn**
6. Can I drop down to raw LangGraph when I need to?
7. What does `dawn build` actually do?
8. Why a meta-framework instead of a library?

**Operating Dawn**
9. Can I deploy outside LangGraph Platform?
10. How do I gradually migrate an existing LangGraph project?

### Answer shape

Each entry follows:

```
## <Question phrased exactly as a developer would type it>

<2–4 sentences. Direct answer first, then the one piece of context that
matters. Link to the deeper page if there is one.>
```

No hedge openers ("It depends…", "Well…"). Open with the verdict, follow with the why.

### Page structure

```
# FAQ

<Lede: 2–3 sentences. What this page is, what it isn't.>

## Adopting Dawn

### Do I have to use LangGraph?
### Can I bring my own model provider?
### How does Dawn compare to Mastra / CopilotKit / Vercel AI SDK?
### Does Dawn support Python?
### Is Dawn production-ready?

## Working in Dawn

### Can I drop down to raw LangGraph when I need to?
### What does `dawn build` actually do?
### Why a meta-framework instead of a library?

## Operating Dawn

### Can I deploy outside LangGraph Platform?
### How do I gradually migrate an existing LangGraph project?

## Related

- [Mental Model](/docs/mental-model) — the framework's shape
- [Deployment](/docs/deployment) — runtime targets
- [Recipes](/docs/recipes) — task-oriented how-tos
```

H3 questions ensure each answer becomes its own TOC entry on the right rail.

### Sidebar update

`apps/web/app/components/docs/nav.ts` — add FAQ to the Reference group:

```ts
{
  label: "Reference",
  items: [
    { label: "API", href: "/docs/api" },
    { label: "CLI", href: "/docs/cli" },
    { label: "FAQ", href: "/docs/faq" },   // NEW
  ],
},
```

### Route page

`apps/web/app/docs/faq/page.tsx` follows the standard 9-line shim pattern.

### Search index

`search-index.ts` reads from `DOCS_NAV` at module init — adding the nav entry causes the index to pick up the FAQ automatically.

## Architecture

```
apps/web/
├── app/
│   ├── docs/
│   │   └── faq/
│   │       └── page.tsx              # NEW
│   └── components/docs/
│       └── nav.ts                    # MODIFIED — add FAQ to Reference
└── content/docs/
    └── faq.mdx                       # NEW
```

3 files. ~150 lines of new content, ~1 line of nav change.

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes.
- **Manual smoke:**
  - Visit `/docs/faq` — page renders end-to-end with all 10 H3 entries.
  - Sidebar shows "FAQ" under "Reference".
  - TOC right rail lists each H3 question.
  - Mobile (390x844): page renders cleanly, code chips wrap, sidebar collapses behind hamburger.
  - All cross-links resolve.

## Migration risk

None. Pure additive change.

## Open items deferred to plan

- Whether to add a `promptSlug` for FAQ questions — skip for now; unclear which questions warrant it.
- Whether to back specific comparison answers (Mastra/CopilotKit/Vercel AI SDK) with concrete bullet differences vs. one-line positioning. Default: one-line positioning + link to landing page comparison if it exists; otherwise just the positioning.
