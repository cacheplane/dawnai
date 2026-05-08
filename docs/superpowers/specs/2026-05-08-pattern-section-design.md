# Pattern Section (ArchitectureSection redesign) — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — landing page, full rewrite of `ArchitectureSection.tsx` to land the Next.js → Dawn metaphor

## Problem

The current `ArchitectureSection` shows three stacked cards (You / Dawn / LangChain) with bullet lists of items. It's a correct architectural diagram but it's just words on cards — the section sits on the most thematically loaded claim Dawn makes ("App Router for AI agents") and never shows it. A Next.js developer scrolling through this section gets no visceral aha moment.

The narrative this section needs to carry: **if you know the App Router, you already know Dawn.** That has to be felt, not stated.

## Goals

- Replace the You/Dawn/LangChain stack with two paired components that make the App Router → Dawn mapping concrete:
  1. **Side-by-side file trees** — a real Next.js codebase next to a real Dawn codebase, mirrored line-for-line.
  2. **Translation table** — five concept pairs (file, role, dev tool) mapped Next.js → Dawn with one-line descriptions on each side.
- Headline names the claim explicitly: "It's App Router. For agents." with "App Router" italicized in gold.
- Tightly typeset closing line that re-states the trio: "Same patterns. Next.js ergonomics, Dawn conventions, LangGraph runtime."
- Code surfaces (the trees) sit on **fixed dark** so they read like a developer's terminal, regardless of where the scroll-driven palette is at the section's vertical position.
- Section overall sits on the daylight palette (cream + dark text), consistent with surrounding sections post-sunrise.

## Non-goals

- No animation. The section is a static read; the impact is in the visual parallel.
- No interactive tabs / hover states beyond what's needed for legibility.
- No diagrams of LangGraph internals. The section is about Dawn↔Next.js, not Dawn↔LangGraph (the latter belongs elsewhere).
- Not adding a "deploys to LangGraph Platform" callout here — that lives in `DeploySection`.
- Not moving the You/Dawn/LangChain stack to a different section. It's removed entirely; the trio relationship is captured in the closing line instead.

## Approach

### Layout

The section is a single full-width container with vertical sections in this order:

1. **Eyebrow** — small amber dot + "The pattern" label, all caps, letter-spaced.
2. **Headline** — big serif, two lines: "It's *App Router*. For agents." with "App Router" in italic gold (`#d97706`).
3. **Lede** — one paragraph (max 600px), Dawn brand muted color: "If you can build a Next.js app, you can build a Dawn agent. Same file-system conventions, same type inference, same dev server ergonomics — applied to LangGraph."
4. **File tree comparison** — two columns + center spine (3-column CSS grid).
5. **Translation table** — 5 rows on a white card with subtle border + soft shadow.
6. **Closing line** — centered, two-tone: "Same patterns. `Next.js` ergonomics, `Dawn` conventions, LangGraph runtime."

### File tree comparison (Section 4)

CSS grid `1fr 60px 1fr`. Both trees are dark code surfaces (`bg-bg-card` + `border-border`), monospace, with the existing token color palette (yellow for top-level dirs, purple for dynamic segments, blue for primary route file, green for handler/tool, dim gray for arrow annotations).

Tree headers carry two pieces of metadata:
- A bold capitalized tag identifying the system: "Next.js · App Router" (white-ish on dark) on the left, "Dawn · App Router for agents" (amber on dark) on the right.
- A small grey meta label: "a web app" (left) / "an AI agent" (right).

The two trees are deliberately mirrored: same indentation depth, same number of lines, same arrow annotations. The differences are precisely:

| Line | Next.js | Dawn |
|---|---|---|
| 1 | `app/` | `app/` |
| 2 | `layout.tsx` | `layout.ts` |
| 3 | `middleware.ts` | `middleware.ts` |
| 4 | `(public)/` ← route group | `(public)/` ← route group |
| 5 | `hello/` | `hello/` |
| 6 | `[tenant]/` ← dynamic segment | `[tenant]/` ← dynamic segment |
| 7 | `page.tsx` ← UI route | `index.ts` ← agent workflow |
| 8 | `route.ts` ← API endpoint | `tools/greet.ts` ← typed tool |

**Note on `layout.ts`** — Dawn does not currently ship a `layout.ts` primitive. The mockup includes one because the mirror is the design point; if Dawn doesn't have layouts, omit the line and let both trees be 7 lines instead of 8. **Decision in spec: omit `layout.tsx`/`layout.ts` from both trees** so the parallel doesn't claim a feature Dawn doesn't have. Final line counts: 7 each.

The center spine is a small flex column: a gold arrow → vertical "same conventions" label (rotated 180° via `writing-mode: vertical-rl`) → another gold arrow. Reads as a piece of editorial chrome connecting the two.

### Translation table (Section 5)

White card, soft border, soft shadow. Single header row at top with the headings "Next.js · App Router" (left) and "Dawn" (right) in amber-on-cream. Five data rows, each a 3-column grid:
- Left cell: monospace pair like `app/page.tsx` (top) + small body-font description (bottom)
- Center cell: gold "→"
- Right cell: monospace pair + description

Five rows in this exact order:

1. `app/page.tsx` (A route's UI — what gets rendered for a path) → `app/index.ts` (A route's agent workflow — what runs for a path)
2. `app/route.ts` (An HTTP handler at this path) → `app/tools/*.ts` (A typed tool the agent at this path can call. Co-located.)
3. `[slug]/` (Dynamic segment — typed at build via generated `params`) → `[tenant]/` (Dynamic segment — typed at build via generated `RouteState`)
4. `middleware.ts` (Edge / request middleware. Runs before the handler.) → `middleware.ts` (Auth, retry, logging — same semantics, runs before the workflow.)
5. `next dev` (Type-aware dev server with HMR.) → `dawn dev` (Type-aware dev server with HMR — speaks the LangGraph deployment protocol.)

### Closing line (Section 6)

Centered, max-width 640px. Body-font, mid-size:

> "Same patterns. `Next.js` ergonomics, `Dawn` conventions, LangGraph runtime."

The two pill-shaped inline labels (`Next.js`, `Dawn`) are styled like small monospace tokens — `Next.js` on a neutral chip (cosmic-on-cream), `Dawn` on amber chip. "LangGraph runtime" sits in plain body color.

### Palette discipline

The section's outer surface uses the daylight `landing-text` and `landing-text-muted` for body copy — it inherits the engine's daylight palette at this scroll position (~50%+).

The **file trees** are fixed dark (`bg-bg-card`, `border-border`) and use the existing color tokens (`text-yellow-400`, `text-purple-400`, `text-blue-400`, `text-green-400`, `text-text-muted`, `text-text-dim`). This matches the discipline applied in `CodeExample` after Pass 1: code surfaces are content, they sit on a fixed dark surface so syntax tokens stay legible regardless of the page palette.

The **translation table** uses `background: white` and `color: #21180c` directly. It's not on the engine's surface — it's a content card, like an inline reference document. Soft border `rgba(33,24,12,0.10)` and soft shadow `0 4px 16px -8px rgba(33,24,12,0.08)`. Header row uses `rgba(217,119,6,0.06)` (amber wash) for the cap.

### Typography

- Eyebrow: `text-xs uppercase tracking-widest text-accent-amber`, with leading `•` dot
- Headline: `font-display`, `clamp(40px, 6vw, 56px)`, weight 700, `letter-spacing: -0.025em`, line-height 1.05. "App Router" is wrapped in `<span style="color:#d97706;font-style:italic">` for the gold accent.
- Lede: 18px, line-height 1.55, `landing-text-muted`, max-width 600px
- Tree contents: `font-mono`, 13px, line-height 2
- Tree header tag: `font-sans`, 10px, uppercase, letter-spacing 0.15em, weight 700
- Tree header meta: `font-sans`, 11px, dim
- Arrow spine label: `font-mono`, 9px, uppercase, letter-spacing 0.18em, weight 700, vertical writing
- Table header row: 11px uppercase, letter-spacing 0.15em, amber, weight 700
- Table cells: `font-mono` 14px for the file/command, body 13px line-height 1.5 for the description
- Closing line: 17px, body, line-height 1.55, `landing-text-muted`. Pills are inline-block, 13px monospace.

### Responsive

- Trees side-by-side at `≥768px`. On narrower viewports, stack vertically; the arrow spine becomes a horizontal arrow with a "same conventions" label below.
- Table 3-col layout collapses to 2-col on narrow viewports (drop the arrow column; replace with a thin amber border-left on each right cell so the relationship is still visible).
- Headline `clamp(40, 6vw, 56)` already handles its own sizing.

## Architecture

```
apps/web/app/components/landing/
└── ArchitectureSection.tsx       # rewritten end-to-end
```

That's the entire footprint. The section's outer scaffolding (the `<section>` wrapper with `py-36`, `border-t`, mounted in `page.tsx` between `SolutionSection` and `CodeExample`) stays exactly as it is.

The current `Layer`, `LayerCard`, `Connector` interfaces and helpers are deleted — they're not used elsewhere.

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes. Inline styles are intentional (matches `CtaSection`, `BigReveal`).
- **Visual smoke (manual):** scroll to the section. Confirm:
  - Headline reads "It's *App Router*. For agents." with the italic gold "App Router".
  - Two trees render side-by-side at full desktop width, mirrored line-for-line, on dark code surfaces.
  - Tree token colors are vivid (yellow dirs, purple dynamic segments, blue route file, green tools).
  - Translation table renders below the trees, white card, 5 rows, gold arrows, body descriptions readable.
  - Closing line shows the `Next.js`/`Dawn` chips with correct color contrast.
  - Mobile (<640px): trees stack, table collapses to 2-col with left amber border on the right cell.
- **Reduced motion:** no animation in this section, so unaffected.

## Migration risk

Low. The section is a single-component rewrite with no shared types or imports outside its own file. Removing the old `Layer`/`LayerCard` types only affects this file (verified: no other consumer imports them).

The section's vertical position in the page tree stays identical, so palette engine progress at this scroll position is unchanged.

## Open items deferred to plan

- Whether the "an AI agent" / "a web app" tree-meta tags read as too cute or as helpful framing. Spec keeps them; plan can drop them based on smoke-test feedback if they feel like clutter.
- Whether to surface a CTA to the docs from this section (e.g., "Read the routing guide →"). Spec excludes — the section is a self-contained metaphor; cross-links belong on the docs side. Plan does not add a CTA.
