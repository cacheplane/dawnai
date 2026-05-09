# Quick Check Section (ComparisonTable redesign) — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — landing page, full rewrite of `ComparisonTable.tsx` (the "Quick check" section between ProblemSection and BigReveal)

## Problem

The Quick check section currently renders an 8-row Convention/Next.js/Dawn table after a `You already know this story.` headline. It does its job, but flatly: a dry table is the wrong format for the page's most narrative beat (the "you've seen this pattern before" moment that bridges Problem and the BigReveal). The reader scans it, doesn't *feel* it, and the section lands with a thud rather than the recognition spark we're after.

It also overlaps in shape with the post-reveal `ArchitectureSection`, which now carries the deeper Next.js↔Dawn translation table. Two tables of slightly different rows separated by 100vh of dawn arc reads as redundant rather than reinforcing.

## Goals

Replace the table with a two-part structure that reframes the section as **"you already know this — and adopting it costs you nothing."**

1. **Brand wall** — a stacked card with four runtime → meta-framework pairs (React → Next.js, Svelte → SvelteKit, Vue → Nuxt, LangGraph → Dawn). The last row is amber-highlighted as the punchline. The pattern itself is the argument.
2. **Bridge line** — one italic-gold sentence: *"A meta-framework deletes the boilerplate, not your stack."*
3. **Two-column reassurance** — "Dawn deletes" (red x list of plumbing) on the left, "Dawn keeps" (amber check list of stack) on the right.

The combination lands the recognition (top), pivots to the value (middle), and addresses the implicit "but what about my existing stack?" anxiety (bottom).

## Non-goals

- Not adding new content unrelated to the Next.js↔Dawn pattern.
- Not animating anything (page already has the dawn arc; this section stays static).
- Not adding more comparisons of file paths or commands — `ArchitectureSection` already does that with file trees and a 5-row translation table.
- Not adding a CTA — the section is a bridge, not a destination.
- Not changing the section's vertical position in `page.tsx` (still between `ProblemSection` and `BigReveal`).

## Approach

### Section structure

A single section with three vertically-stacked content blocks:

```
[ Eyebrow ]   • Quick check
[ Headline ]  Every runtime gets a meta-framework.
[ Lede     ]  React got Next.js. Svelte got SvelteKit. Vue got Nuxt.
              LangGraph just got Dawn.

[ Brand wall: 4-row stacked card with runtime → meta-framework pairs ]

[ Bridge line: A meta-framework /deletes the boilerplate/, not your stack. ]

[ Two-column: Dawn deletes  ·  Dawn keeps ]
```

Outer scaffolding stays: `<section className="py-28 px-8 border-t landing-border">` with the same `ScrollReveal` wrap in `page.tsx`. The section sits at the dusk-peach scroll position; text reads on the engine's interpolated dusk palette using `landing-text` / `landing-text-muted` for body copy. Card surfaces use `landing-surface` so they participate in the arc; the `Dawn deletes` / `Dawn keeps` cards layer additional tints (red/amber) on top.

### Brand wall

A bordered, rounded card containing 4 grid rows. Each row is `1fr auto 1fr` (runtime · arrow · meta-framework). Each side has the brand name in monospace plus a small descriptive pill (`runtime` / `meta-framework`).

The last row (LangGraph → Dawn) is the punchline: subtle amber background tint on the row, amber-on-amber pill for "meta-framework", and amber-colored arrow + "Dawn" label.

### Bridge line

One sentence in `font-display` serif at ~26px, italic-gold accent on "deletes the boilerplate":

> A meta-framework *deletes the boilerplate*, not your stack.

This explicitly defuses the "Dawn is another lock-in I have to learn" reflex before it gets a chance to form. Bridges into the two-column section that proves it.

### Two-column reassurance

Two cards side-by-side at desktop, stacked at narrow:

| Dawn deletes (red `×`) | Dawn keeps (amber `✓`) |
|---|---|
| StateGraph node + edge wiring | Your tool implementations (just the function) |
| Zod schema duplicates of tool params | Your prompts and personas |
| Per-route protocol adapters | Your LangGraph workflows and graphs |
| Custom dev loop scripts | Your LangChain LCEL chains |
| Hand-rolled scenario test harnesses | Your model providers (OpenAI, Anthropic, etc.) |
| Bespoke Docker images for deployment | Your LangSmith tracing |

Each card has:
- Eyebrow label ("Dawn deletes" / "Dawn keeps") in red / amber, uppercase, letter-spaced
- Sub-heading: "Plumbing you wrote five times." / "Everything you already wrote."
- 6-item list with custom mask-image bullets (× for deletes, ✓ for keeps)

Border + bg tint differentiate the cards: `deletes` uses `rgba(120,30,40,0.14)` bg + `rgba(255,99,99,0.25)` border; `keeps` uses `rgba(251,191,36,0.05)` bg + `rgba(251,191,36,0.36)` border.

### Palette discipline

The brand wall and the two cards use semi-transparent surfaces over the engine's `--landing-bg` so they interpolate with the dusk → cream arc. Text colors come from `landing-text` / `landing-text-muted`. Brand-specific colors (red for deletes, amber for keeps + the punchline row) are static — they don't interpolate, because they're carrying meaning, not theme.

The mask-image bullet icons use `mask` + solid color so they read clearly across the entire arc.

### Typography

- Eyebrow: `text-xs uppercase tracking-widest text-accent-amber`, with leading `•`
- Headline: `font-display`, `clamp(36px, 5vw, 48px)`, weight 700, `letter-spacing: -0.025em`, line-height 1.05.
- Lede: `text-base` to `text-lg`, body color, max-width ~580px.
- Bridge line: `font-display` 26px, weight 500, italic-gold accent.
- Brand wall pair labels: monospace 18px weight 600.
- Brand wall pills: 11px sans, slight border, soft tint.
- Column heads: 11px uppercase letter-spaced.
- Column subheads: `font-display` 22px weight 700.
- Column list items: 14.5px body.

### Responsive

- Desktop: brand wall is full-width 4-row stacked card. Two-column reassurance is `1fr 1fr`.
- Narrow (<768px): brand wall rows stay one per row (the `1fr auto 1fr` grid stays). Two-column reassurance stacks vertically.
- Headline `clamp(36, 5vw, 48)` handles its own sizing.

### Accessibility

- All text is real text (no images).
- The mask-image bullets are decorative and the `<ul>` items carry their own semantic content.
- Color is not the only signal — the "Dawn deletes / Dawn keeps" labels are explicit text.
- Bridge line uses `<em>` with inline color rather than image.

## Architecture

```
apps/web/app/components/landing/
└── ComparisonTable.tsx       # full rewrite
```

That's the entire footprint. No other files touched. Component is renamed *internally* to reflect the new structure, but the export name stays `ComparisonTable` so `page.tsx` doesn't need to change.

(Optional follow-up not in this spec: rename file + export to `QuickCheckSection.tsx`. Skipping for now to keep the diff minimal.)

The current `rows` const, `dawnOnly` flag, and the table-cell rendering logic are removed. Replaced with two new constants: `META_FRAMEWORKS` (4 brand-wall pairs) and `DELETES` / `KEEPS` (6 items each).

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes. Inline styles (red/amber tints, mask-image bullets) are intentional, matching the discipline used in `BigReveal`, `CtaSection`, `ArchitectureSection`.
- **Visual smoke (manual):** scroll to the section. Confirm:
  - Eyebrow `• QUICK CHECK` amber, all caps, letter-spaced.
  - Headline reads "Every runtime gets a meta-framework." in serif.
  - Lede mentions React/Next.js, Svelte/SvelteKit, Vue/Nuxt, LangGraph/Dawn.
  - Brand wall: four pairs in a stacked card. Last row (LangGraph → Dawn) is amber-tinted. Pill labels read "runtime" and "meta-framework".
  - Bridge line: *"A meta-framework deletes the boilerplate, not your stack."* with italic-gold "deletes the boilerplate".
  - Two-column cards: red-tinted "Dawn deletes" with × bullets on the left, amber-tinted "Dawn keeps" with ✓ bullets on the right.
  - On narrow viewports the columns stack and the brand wall remains usable.
- **Reduced motion:** no animation in this section, unaffected.

## Migration risk

Almost none. The section is self-contained; no shared types or imports outside its own file. The `rows` const + `dawnOnly` flag are removed but unused elsewhere (verified).

The vertical position in the page tree stays identical, so palette engine progress at this scroll position is unchanged.

## Open items deferred to plan

- Whether to rename file + export from `ComparisonTable` to `QuickCheckSection`. Skipped — out of scope; would force a rename in `page.tsx` that doesn't serve the visual change.
- Whether to add Solid → SolidStart as a fifth brand-wall row. Skipped — Solid is less universally known among LangChain users; four rows reads cleaner and the "every runtime" claim is already established by 3+1.
