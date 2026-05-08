# Big Reveal Section — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — landing page, new full-height pull-quote section between Comparison and Solution

## Problem

The current landing page transitions from cosmic dark through dusk and into cream daylight via the scroll-driven palette engine, but the moment of arrival — where the dawn metaphor pays off — has no narrative weight. A `border-t` between `ComparisonTable` and `SolutionSection` is the only marker. The reader cruises past the most thematically loaded scroll position (~50% — sunrise) without registering it.

Consequence: the page reads as "dark theme that fades into light theme" rather than "the page is the sunrise." The dawn metaphor exists structurally but doesn't have a moment that earns it.

## Goals

- Insert a full-height (100vh) pull-quote section between `ComparisonTable` and `SolutionSection`.
- The section sets its own gradient background (dusk peach → sunrise mid → cream) so the gradient is exact, regardless of where the engine's interpolation is at that scroll progress.
- Two-line quote, sharp question + pivot, sits centered. Setup line in serif at modest scale; pivot line in serif at much larger scale, dark color punching against the cream-resolved bottom.
- A subtle radial sun-bloom at the bottom-center reinforces the moment.
- No animation. The 100vh is enough.

## Non-goals

- No sticky/pinned scroll behavior. The section is a normal block; the scroll just spends a long time on it because it's tall.
- No new palette anchors. The existing 5 stops cover the surrounding sections; the reveal sets its own gradient inline.
- No icons, ornaments, or chrome beyond the gradient + sun-bloom + text.
- Not changing the quote copy in the future without going through the same brainstorm loop — the wording is design, not config.

## Approach

### Structure

A new component `BigReveal.tsx` in `apps/web/app/components/landing/`, mounted in `page.tsx` between `ComparisonTable` and `SolutionSection`. Wrapped in the existing `ScrollReveal` for consistency with neighboring sections.

The component renders a single `<section>` with `min-height: 100vh`, an inline gradient, and three layers of decoration before the centered content. No client-side JS — it's a server component.

### Visual recipe

- **Background:** `linear-gradient(180deg, #3a2840 0%, #6a3848 25%, #c46c3e 55%, #fef4e6 88%, #fffcf4 100%)`. The stops are anchored to the dawn arc engine's dusk → sunrise → daylight values.
- **Sun bloom (`::before`):** radial gradient anchored bottom-center, ~140% × 90%, `rgba(251, 191, 36, 0.45)` core fading to transparent at 55%. Sits behind the text but in front of the base gradient.
- **Star fade (`::after`):** five tiny radial dots at 40–55% opacity scattered in the upper third — fading remnants of the cosmic star field, signaling that we've left the night sky behind. No animation — they're literal pixels in a `radial-gradient` stack on the `::after`.
- **Content layer:** `position: relative; z-index: 2;`. Centered both axes via flex.

### Typography

- **Setup line** ("Why do agent codebases drift, duplicate, and rot?")
  - `font-family: var(--font-display)` (Fraunces serif)
  - `font-size: clamp(28px, 4vw, 40px)`
  - `font-weight: 500`
  - `line-height: 1.2`
  - `color: rgba(254, 244, 230, 0.92)` — warm cream, lifted off the gradient by light text-shadow
  - `text-shadow: 0 2px 18px rgba(0,0,0,0.35)` — keeps the line legible across the dusk portion of the gradient
  - `max-width: 720px`, `margin: 0 auto 28px`
  - `font-variation-settings: 'opsz' 144, 'SOFT' 50` — keeps it visually consistent with the existing `font-display` usage
- **Pivot line** ("No framework.")
  - `font-family: var(--font-display)`
  - `font-size: clamp(56px, 9vw, 96px)`
  - `font-weight: 700`
  - `letter-spacing: -0.025em`
  - `line-height: 1.0`
  - `color: #1a1530` — twilight purple-near-black, contrasts hard against the cream-resolved bottom of the gradient
  - `font-variation-settings: 'opsz' 144, 'SOFT' 50, 'WONK' 0`

### Layout

```tsx
<section className="relative w-full overflow-hidden flex items-center justify-center" style={{ minHeight: '100vh', background: '...gradient...', padding: '80px 24px' }}>
  <div aria-hidden className="absolute inset-0" /* sun bloom */ />
  <div aria-hidden className="absolute inset-0" /* star dots */ />
  <div className="relative max-w-[760px] text-center" style={{ zIndex: 2 }}>
    <p className="setup-line">Why do agent codebases drift, duplicate, and rot?</p>
    <h2 className="pivot-line">No framework.</h2>
  </div>
</section>
```

The section uses `min-height: 100vh` rather than fixed `height: 100vh` so the content doesn't get clipped on short viewports (e.g., mobile landscape). Padding ensures the quote breathes inside the 100vh frame.

### Page integration

In `apps/web/app/page.tsx`, between `<ComparisonTable />` and `<SolutionSection />`:

```tsx
<ScrollReveal>
  <ComparisonTable />
</ScrollReveal>
<ScrollReveal>
  <BigReveal />
</ScrollReveal>
<ScrollReveal>
  <SolutionSection />
</ScrollReveal>
```

`ScrollReveal` already wraps neighbors; this matches the rhythm.

### Interaction with the palette engine

The reveal section sets its own gradient explicitly. The engine continues to update `--landing-bg` underneath, but the reveal's `<section>` covers it edge-to-edge for its 100vh height, so the engine output is invisible during the reveal. Sections before and after the reveal continue to inherit `var(--landing-bg)` as before.

This is intentional and serves the design: the reveal is the one moment where we want the gradient to be **exact**, not interpolated. The engine's eased-cubic interpolation is great for continuous motion but is approximate at any single point; the reveal section needs to nail the dusk → cream payoff visually, hence the hand-tuned gradient.

The added 100vh of scroll height shifts the engine's progress accordingly — every section beyond the reveal now reaches its target stop slightly later in absolute scroll, but the percentage-based mapping handles this automatically.

### Reduced motion

No special handling needed — the section is fully static. The gradient is CSS, no JS, no animation. The `prefers-reduced-motion: reduce` media query already snaps the surrounding palette to daylight; the reveal still renders its gradient (which represents the same dawn-to-daylight idea statically). Users who request reduced motion get the reveal as a flat dawn moment between two daylight sections.

### Accessibility

- The quote is real text (`<p>` and `<h2>`), not an image.
- The pivot uses `<h2>` so it shows up in the heading outline.
- Decorative layers carry `aria-hidden`.
- No animation, so no motion-induced issues.
- Color contrast: the setup line has a text-shadow specifically to maintain WCAG AA contrast across the gradient transition (the dusk portion is darkest at the top, lightest at the bottom — text-shadow handles the edge cases).

## Architecture

```
apps/web/app/components/landing/
├── BigReveal.tsx          # NEW — full-height pull-quote section
├── ComparisonTable.tsx    # unchanged
└── SolutionSection.tsx    # unchanged

apps/web/app/page.tsx      # mount BigReveal between ComparisonTable and SolutionSection
```

That's the entire change footprint — one new file, one edit to `page.tsx`.

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build` and `pnpm --filter @dawn-ai/web typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes — the section uses inline styles for the gradient and color values (intentional, like `CtaSection.tsx`), all token-aligned.
- **Visual smoke (manual):** scroll the landing in dev. Confirm:
  - The reveal sits between Comparison and Solution.
  - It occupies a full viewport height regardless of viewport size.
  - The setup line is legible across the gradient (no contrast collapse).
  - The pivot line is large, dark, and hits hard against the cream bottom.
  - Sun bloom is visible at the bottom-center.
  - Mobile (<640px): quote scales down via `clamp()` and remains centered.
- **Reduced motion:** with macOS Reduce Motion enabled, the section renders identically (no animation to disable).

## Migration risk

Almost none. The section is additive — no existing code is changed except a one-line insertion in `page.tsx`. The palette engine's percentages stay valid because they're scroll-progress-relative, not pixel-anchored.

If the existing dawn arc anchor at 0.50 ("sunrise resolved") was tuned assuming the current scroll height, adding 100vh shifts the absolute pixel locations of the stops. In practice this is invisible — the engine still reaches sunrise at 50% scroll, just 100vh later in pixels.

## Open items deferred to plan

- Whether to add a `prefers-reduced-data` opt-out (the gradient is small CSS, not a real concern; skip).
- Whether to expose the quote as a prop or content config for future variants (YAGNI; the quote is design copy, not config).
