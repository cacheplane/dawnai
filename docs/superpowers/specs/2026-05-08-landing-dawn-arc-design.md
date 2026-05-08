# Landing Dawn Arc — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — landing page palette system, scroll-driven palette interpolation, full-width CTA redesign

## Problem

The current landing renders end-to-end on a single dark cosmic palette. The hero's parallax dawn metaphor — sun bloom rising behind earth, cosmic starfield, atmospheric tints — is the strongest moment on the page, but the metaphor doesn't unfold; once the user scrolls past the hero they are in the same dark world for ten more sections. The page reads "this site has a dark theme with a cool hero" instead of "this site is about dawn and the page is the sunrise."

Specific issues:

1. **No narrative motion in the palette.** Every section beneath the hero shares the same `bg-bg-primary` / `bg-bg-secondary` surface tokens. The `LandingAmbient` paints colored blobs at scroll depths but the section backgrounds underneath them stay flat dark.
2. **Code and dense informational content sit in dark surfaces.** Comparison tables, code panels, deploy steps — all read better on light. Dark theme is fighting the content.
3. **The CTA is small and ends quietly.** The current `CtaSection` is a contained section that doesn't earn the closing moment.

## Goals

- The page transitions visibly from cosmic dark (hero) through twilight, dusk, and sunrise into full daylight by ~50% scroll. The dawn metaphor is structural, not just decorative.
- The transition is driven by **scroll position**, not section boundaries — every channel (background, foreground, muted, surface, accent, border) interpolates as one palette through five anchor stops with cubic ease-in-out smoothing.
- All landing sections consume a shared set of CSS variables so they participate automatically; nothing is hard-coded.
- The closing CTA is a full-width "dawn rising" panel — sun bloom, dotted grid, atmospheric blobs — that pays off the metaphor.
- Respects `prefers-reduced-motion`: snaps to the daylight palette without animating.
- 60Hz smooth on scroll (rAF-throttled). No jank, no layout thrash.

## Non-goals

- Theme toggle (manual light/dark). The arc is the theme; there is no preference.
- Animating typography, layout, or photos. Only the palette interpolates.
- Touching docs pages or any non-landing surface.
- Replacing the hero's existing `HeroParallaxLayers` — that earns the cosmic dark and stays as-is.

## Approach

### The palette engine

A small client-only module (`PaletteScroller`) that:

1. Reads `window.scrollY / (scrollHeight - innerHeight)` on each rAF.
2. Finds the bracketing pair of palette stops for that progress.
3. Computes a normalized 0–1 `t` within that span and applies cubic ease-in-out.
4. Lerps every channel (RGB and alpha) between the two stops.
5. Writes the result to seven CSS custom properties on `:root`: `--landing-bg`, `--landing-fg`, `--landing-muted`, `--landing-surface`, `--landing-border`, `--landing-accent`, `--landing-hue`.

**Why CSS variables over inline styles or Tailwind config:** any section can opt in just by referencing `var(--landing-bg)` in its background. The interpolation runs once per frame; the browser handles the rest. Tailwind v4's CSS-first config means we don't need to extend a JS theme — we add variables in `globals.css` next to the existing brand tokens.

### Anchor stops

Five stops, hand-tuned values from the v2 mockup the user approved:

| `at` | Beat | bg | fg | muted | surface | accent | hue |
|---|---|---|---|---|---|---|---|
| 0.00 | pre-dawn cosmic | `#020617` | `#c8c8cc` | `#8b8fa3` | `#0a0f1f` | `#fbbf24` | `#f5a524` |
| 0.15 | twilight violet | `#1a1530` | `#dad2e0` | `#ad9ec0` | `#281f46` | `#fbbf24` | `#f5a524` |
| 0.30 | dusk peach | `#3a2840` | `#f0dcdc` | `#c8aaaa` | `#52385a` | `#fb923c` | `#fb923c` |
| 0.50 | sunrise (resolved) | `#fef4e6` | `#21180c` | `#6d5638` | `#fffcf4` | `#d97706` | `#fbbf24` |
| 1.00 | daylight | `#fefefe` | `#0f1220` | `#555f75` | `#f8fafe` | `#d97706` | `#fbbf24` |

Border channel is encoded as `rgba` with the alpha interpolated separately. Pre-dawn through dusk uses `rgba(255,255,255, ...)`; sunrise and daylight use `rgba(15,18,32, ...)` — the channel switches color across the cream stop, but because the alpha is low (0.08–0.18) and `t` near the stop is small, the visual result reads continuously.

### Section migration

Each landing section currently sets its own `style={{ background: ... }}` or uses `bg-bg-primary` / `bg-bg-secondary` Tailwind classes. We replace those with one of two patterns:

- **Transparent** — the section reads through to the page-level `:root` background. Most sections use this. The `<body>` (or the landing root) sets `background: var(--landing-bg)`.
- **Surface card** — sections that visually need a panel (e.g., FeatureGrid cards, ComparisonTable rows) use `background: var(--landing-surface)` and `border: 1px solid var(--landing-border)`.

The hero stays as-is. Its hardcoded cosmic background and parallax layers are intentional; the user is at progress 0.00 and the engine is feeding them the same color the hero already paints. No conflict.

The existing `LandingAmbient` is **deleted**. Its three jobs — starfield below the hero, blob blooms at scroll depths, faint dot grid — are absorbed:

- The starfield and blob blooms were doing the job the palette engine now does, with less precision. Gone.
- The dot grid moves into the new CTA section as decoration there (it was masked to fade at top/bottom anyway, so its only meaningful presence was already CTA-adjacent).

### The CTA

`CtaSection.tsx` is rewritten as a full-width edge-to-edge panel. The user-approved treatment ("D2 + dotted grid, no horizon line"):

- **Base:** `linear-gradient(180deg, #fff7e0 0%, #ffe2a8 100%)` — cream → warm cream.
- **Layer 1 (`::before`):** atmospheric corner blobs — violet bottom-left (`rgba(196,167,231,0.30)`) + sky top-right (`rgba(127,200,255,0.24)`) radial gradients, full bleed.
- **Layer 2 (`.grid`):** amber dot grid `radial-gradient(circle, rgba(217,119,6,0.28) 1px, transparent 1.6px)` at 28×28 spacing, masked with `radial-gradient(ellipse, black 0% 45%, transparent 78%)` so it fades at the edges.
- **Layer 3 (`.sun-bloom`):** rising sun — radial bloom positioned bottom-center, 140% wide × 140% tall, `rgba(245,165,36,0.50)` core fading to transparent at 55%.
- **Content:** centered, max-width 720, h1 at 64px, primary dark button + secondary outlined button.
- **Top border:** `1px solid rgba(217,119,6,0.15)` to mark the seam against daylight context above.
- **Padding:** 180px vertical (large enough to be the closing moment, not so large that mobile users have to scroll forever).

Z-index order: gradient base (auto) → blobs (`::before`, z 0) → dot grid (`.grid`, z 1) → sun bloom (`.sun-bloom`, z 0) → content (`.cta-inner`, z 2). Sun bloom sits beneath the grid intentionally so the grid texture reads on top of the warmest spot.

### Reduced motion

If `(prefers-reduced-motion: reduce)` matches at script start, the engine sets the daylight stop directly and never registers a scroll listener. The hero still renders its dark palette via its own hardcoded styles (the engine's output is not used by the hero), so users who request reduced motion see: cosmic hero, then the rest of the page in daylight. No interpolation animation, no surprise.

### Performance

- **rAF throttling** — only one update queued per frame regardless of scroll event rate.
- **CSS variables on `:root`** — single style mutation per frame; the browser's compositor handles everything else.
- **No layout-affecting properties animate** — only colors. No reflow.
- **Listener registered once** with `{ passive: true }`.
- **Stops table is constant** — no allocation per frame except the result palette object (could be reused, not worth the complexity at this scale).

Target: <1ms scripting per scroll frame on a midrange laptop. The v2 mockup's rAF profile already hits this.

## Architecture

```
apps/web/
├── app/
│   ├── components/
│   │   ├── PaletteScroller.tsx        # NEW — client component, mounts the engine
│   │   └── landing/
│   │       ├── HeroSection.tsx        # unchanged (hero owns its own dark palette)
│   │       ├── LogoWall.tsx           # bg → transparent
│   │       ├── ProblemSection.tsx     # bg → transparent
│   │       ├── ComparisonTable.tsx    # surfaces → var(--landing-surface)
│   │       ├── SolutionSection.tsx    # bg → transparent
│   │       ├── ArchitectureSection.tsx# bg → transparent
│   │       ├── CodeExample.tsx        # surface card → var(--landing-surface)
│   │       ├── DeploySection.tsx      # bg → transparent
│   │       ├── FeatureGrid.tsx        # surface cards → var(--landing-surface)
│   │       ├── HowItWorks.tsx         # bg → transparent
│   │       ├── EcosystemSection.tsx   # bg → transparent
│   │       ├── CtaSection.tsx         # rewritten — full-width D2 + grid
│   │       └── (LandingAmbient.tsx)   # DELETED
│   ├── globals.css                    # add 7 --landing-* vars + body bg rule
│   └── page.tsx                       # mount <PaletteScroller />, drop <LandingAmbient />
└── lib/
    └── palette/
        ├── stops.ts                   # the 5-anchor table + types
        └── interpolate.ts             # lerp + easeInOutCubic + paletteAt
```

Data flow:

1. `page.tsx` server-renders the landing tree. `<body>` (via `app/layout.tsx`) sets `background: var(--landing-bg)`.
2. Initial CSS values for the variables = the pre-dawn stop, baked into `globals.css`. Server-rendered HTML is correct without JS.
3. `<PaletteScroller />` (client component) mounts. It reads progress, runs the lerp, writes variables.
4. Scroll → rAF → palette compute → variable write → browser paints. Sections inherit via `var(--landing-bg)`.

### Why split `stops.ts` and `interpolate.ts`

`stops.ts` is the design contract (the table designers tune). `interpolate.ts` is the engine (math, no design knowledge). Each file has one responsibility, neither needs to know the other's internals beyond its types. Tunable color decisions live in one place a designer can edit without touching the JS.

## Testing

- **Unit (vitest):** `paletteAt()` interpolates correctly at boundary stops (`at = 0.0, 0.15, 0.30, 0.50, 1.00`), at midpoints, and beyond `1.0` (clamps to daylight). Tests verify the easing curve is applied (a midpoint sample at `t = 0.5` is the eased value, not the linear midpoint).
- **Visual smoke (manual):** scroll the landing in dev. Confirm continuous palette flow with no jumps, no flicker, sections reading correctly at 0%, 15%, 30%, 50%, 75%, 100%.
- **Reduced-motion smoke:** with macOS Reduce Motion enabled, the page snaps to daylight on load and stays there during scroll.
- **Build:** `pnpm --filter @dawn-ai/web build` succeeds. No new client-bundle bloat beyond the engine itself (~1.5KB gz).

## Migration risk

The biggest risk is sections that currently rely on a known dark surface for legibility (e.g., a tooltip with `text-text-primary` on `bg-bg-card`). When `--landing-surface` interpolates to cream, that text becomes light-on-light.

Mitigation: every text token used in landing sections is replaced with `var(--landing-fg)` or `var(--landing-muted)` so it interpolates with the surface. Hardcoded `text-text-primary` calls are audited and converted in the same task that converts the surface.

The brand accents (amber, green, blue, purple) stay constant — they're brand colors, not palette colors. The dot grid in the CTA stays amber regardless of scroll position.

## Open items deferred to plan

- Whether to ship the engine as a hook (`useScrollPalette()`) or as a side-effect-only component. Component is simpler; hook lets future code read current palette. Default to component; revisit if a use case appears.
- Whether to also expose `--landing-progress` (the raw 0–1) for any section that wants to do its own thing (e.g., a section that fades in opacity at a specific stop). Plan can add it cheaply if needed.
