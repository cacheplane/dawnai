# Landing Dawn Arc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scroll-driven palette engine that interpolates the landing page from cosmic dark (hero) through twilight, dusk, sunrise, and into full daylight as the user scrolls; migrate all landing sections to consume the shared palette via CSS variables; rewrite the closing CTA as the full-width D2 + grid panel.

**Architecture:** A small client-only engine writes seven CSS custom properties on `:root` from a five-anchor palette table, eased with cubic ease-in-out and rAF-throttled. Sections set their backgrounds to transparent (or `var(--landing-surface)` for cards) and inherit the page's `var(--landing-bg)` from `<body>`. `LandingAmbient` is removed; its responsibilities are absorbed by the engine and the new CTA. `prefers-reduced-motion` snaps to daylight.

**Tech Stack:** React 19, Next.js 16, TypeScript 6, Tailwind v4 (CSS-first config), `requestAnimationFrame`, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-05-08-landing-dawn-arc-design.md`

---

## File structure

**New:**
- `apps/web/lib/palette/stops.ts` — five-anchor palette table + types.
- `apps/web/lib/palette/interpolate.ts` — `paletteAt(progress)` + `easeInOutCubic` + `lerpRgb`.
- `apps/web/app/components/PaletteScroller.tsx` — client component, mounts the engine.

**Modified:**
- `apps/web/app/globals.css` — add seven `--landing-*` variables defaulted to pre-dawn; add `body` rule that uses `var(--landing-bg)` on the landing.
- `apps/web/app/page.tsx` — mount `<PaletteScroller />`, drop `<LandingAmbient />` import + usage.
- `apps/web/app/components/landing/LogoWall.tsx` — replace hardcoded `style={{ background: "#020617" }}` with transparent (inherits `--landing-bg`).
- `apps/web/app/components/landing/ProblemSection.tsx`, `ComparisonTable.tsx`, `SolutionSection.tsx`, `ArchitectureSection.tsx`, `CodeExample.tsx`, `DeploySection.tsx`, `FeatureGrid.tsx`, `HowItWorks.tsx`, `EcosystemSection.tsx` — drop `bg-bg-secondary/50`, switch surface cards from `bg-bg-card` / `border-border` to `var(--landing-surface)` / `var(--landing-border)`, switch text tokens (`text-text-primary` / `-secondary` / `-muted`) to `var(--landing-fg)` / `-fg-strong` / `-muted` where the text sits on the page bg or on a `--landing-surface` card.
- `apps/web/app/components/landing/CtaSection.tsx` — rewrite as full-width D2 + grid panel.

**Deleted:**
- `apps/web/app/components/landing/LandingAmbient.tsx`.

---

## Task 1: Palette stops table

**Files:**
- Create: `apps/web/lib/palette/stops.ts`

- [ ] **Step 1: Write the file**

Create `apps/web/lib/palette/stops.ts`:

```ts
/**
 * Five-anchor palette table for the landing scroll arc.
 *
 * Each stop maps a normalized scroll progress (0..1) to a complete palette.
 * `paletteAt()` interpolates between adjacent stops using cubic ease-in-out.
 *
 * RGB tuples are [r, g, b]; alpha tuples are [r, g, b, a].
 * Tune values here without touching the engine.
 */

export type Rgb = readonly [number, number, number]
export type Rgba = readonly [number, number, number, number]

export interface PaletteStop {
  readonly at: number // 0..1 scroll progress
  readonly bg: Rgb
  readonly fg: Rgb
  readonly muted: Rgb
  readonly surface: Rgb
  readonly accent: Rgb
  readonly hue: Rgb
  readonly border: Rgba
}

export const PALETTE_STOPS: readonly PaletteStop[] = [
  // 0 — pre-dawn cosmic (matches hero's hardcoded dark)
  {
    at: 0.0,
    bg: [2, 6, 23],
    fg: [200, 200, 204],
    muted: [139, 143, 163],
    surface: [10, 15, 31],
    accent: [251, 191, 36],
    hue: [245, 165, 36],
    border: [255, 255, 255, 0.08],
  },
  // 0.15 — twilight violet
  {
    at: 0.15,
    bg: [26, 21, 48],
    fg: [218, 210, 224],
    muted: [173, 158, 192],
    surface: [40, 31, 70],
    accent: [251, 191, 36],
    hue: [245, 165, 36],
    border: [255, 255, 255, 0.1],
  },
  // 0.30 — dusk peach
  {
    at: 0.3,
    bg: [58, 40, 64],
    fg: [240, 220, 220],
    muted: [200, 170, 170],
    surface: [82, 56, 90],
    accent: [251, 146, 60],
    hue: [251, 146, 60],
    border: [255, 255, 255, 0.14],
  },
  // 0.50 — sunrise (resolved to daylight palette)
  {
    at: 0.5,
    bg: [254, 244, 230],
    fg: [33, 24, 12],
    muted: [109, 86, 56],
    surface: [255, 252, 244],
    accent: [217, 119, 6],
    hue: [251, 191, 36],
    border: [33, 24, 12, 0.1],
  },
  // 1.0 — daylight
  {
    at: 1.0,
    bg: [254, 254, 254],
    fg: [15, 18, 32],
    muted: [85, 95, 117],
    surface: [248, 250, 254],
    accent: [217, 119, 6],
    hue: [251, 191, 36],
    border: [15, 18, 32, 0.08],
  },
]
```

- [ ] **Step 2: Verify type-check**

Run from worktree root:

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS (no errors). The file is not yet imported.

- [ ] **Step 3: Commit**

```
git add apps/web/lib/palette/stops.ts
git commit -m "feat(web): add palette stops table for landing dawn arc"
```

---

## Task 2: Interpolation engine

**Files:**
- Create: `apps/web/lib/palette/interpolate.ts`

- [ ] **Step 1: Write the file**

Create `apps/web/lib/palette/interpolate.ts`:

```ts
import { PALETTE_STOPS, type PaletteStop, type Rgb, type Rgba } from "./stops"

export interface Palette {
  readonly bg: string
  readonly fg: string
  readonly muted: string
  readonly surface: string
  readonly accent: string
  readonly hue: string
  readonly border: string
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ]
}

function lerpRgba(a: Rgba, b: Rgba, t: number): Rgba {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
    lerp(a[3], b[3], t),
  ]
}

function fmtRgb(c: Rgb): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

function fmtRgba(c: Rgba): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`
}

function findBracket(p: number): { lo: PaletteStop; hi: PaletteStop } {
  const last = PALETTE_STOPS.length - 1
  if (p <= PALETTE_STOPS[0].at) return { lo: PALETTE_STOPS[0], hi: PALETTE_STOPS[0] }
  if (p >= PALETTE_STOPS[last].at) return { lo: PALETTE_STOPS[last], hi: PALETTE_STOPS[last] }
  for (let i = 0; i < last; i++) {
    const lo = PALETTE_STOPS[i]
    const hi = PALETTE_STOPS[i + 1]
    if (p >= lo.at && p <= hi.at) return { lo, hi }
  }
  // Unreachable given the guards above; satisfy the type checker.
  return { lo: PALETTE_STOPS[0], hi: PALETTE_STOPS[last] }
}

/**
 * Compute the interpolated palette at the given scroll progress.
 *
 * `progress` is clamped to [0, 1]. Within a bracketing pair of stops, the
 * normalized t is eased with cubic ease-in-out before the per-channel lerp.
 */
export function paletteAt(progress: number): Palette {
  const p = clamp01(progress)
  const { lo, hi } = findBracket(p)
  const span = hi.at - lo.at
  const tLinear = span === 0 ? 0 : (p - lo.at) / span
  const t = easeInOutCubic(tLinear)
  return {
    bg: fmtRgb(lerpRgb(lo.bg, hi.bg, t)),
    fg: fmtRgb(lerpRgb(lo.fg, hi.fg, t)),
    muted: fmtRgb(lerpRgb(lo.muted, hi.muted, t)),
    surface: fmtRgb(lerpRgb(lo.surface, hi.surface, t)),
    accent: fmtRgb(lerpRgb(lo.accent, hi.accent, t)),
    hue: fmtRgb(lerpRgb(lo.hue, hi.hue, t)),
    border: fmtRgba(lerpRgba(lo.border, hi.border, t)),
  }
}
```

- [ ] **Step 2: Verify type-check**

Run:

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/lib/palette/interpolate.ts
git commit -m "feat(web): add palette interpolation engine"
```

---

## Task 3: CSS variables on `:root` + body background

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Append the variables and body rule**

Append to the end of `apps/web/app/globals.css`:

```css
/* Landing dawn arc — palette variables driven by PaletteScroller.
   Defaults match the pre-dawn stop in lib/palette/stops.ts so server-rendered
   HTML is correct before the engine mounts on the client. */
:root {
  --landing-bg: rgb(2, 6, 23);
  --landing-fg: rgb(200, 200, 204);
  --landing-muted: rgb(139, 143, 163);
  --landing-surface: rgb(10, 15, 31);
  --landing-accent: rgb(251, 191, 36);
  --landing-hue: rgb(245, 165, 36);
  --landing-border: rgba(255, 255, 255, 0.08);
}

body {
  background: var(--landing-bg);
  color: var(--landing-fg);
}

/* Reduced motion — snap to daylight palette and disable any palette
   transition. PaletteScroller also bails out, but this guarantees the
   visual end-state even before the script runs. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --landing-bg: rgb(254, 254, 254);
    --landing-fg: rgb(15, 18, 32);
    --landing-muted: rgb(85, 95, 117);
    --landing-surface: rgb(248, 250, 254);
    --landing-accent: rgb(217, 119, 6);
    --landing-hue: rgb(251, 191, 36);
    --landing-border: rgba(15, 18, 32, 0.08);
  }
}
```

- [ ] **Step 2: Verify build**

Run:

```
pnpm --filter @dawn-ai/web build
```

Expected: PASS. The dev server (if running) will pick up the new variables on next reload.

- [ ] **Step 3: Commit**

```
git add apps/web/app/globals.css
git commit -m "feat(web): add landing palette CSS variables with reduced-motion fallback"
```

---

## Task 4: PaletteScroller client component

**Files:**
- Create: `apps/web/app/components/PaletteScroller.tsx`

- [ ] **Step 1: Write the file**

Create `apps/web/app/components/PaletteScroller.tsx`:

```tsx
"use client"

import { useEffect } from "react"
import { paletteAt } from "../../lib/palette/interpolate"

/**
 * Drives the landing-page CSS variables from scroll position.
 *
 * Mount once near the top of the landing tree. Renders nothing.
 * Respects `prefers-reduced-motion`: bails out before registering the
 * scroll listener, leaving the daylight defaults from globals.css in place.
 */
export function PaletteScroller() {
  useEffect(() => {
    if (typeof window === "undefined") return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) return

    const root = document.documentElement
    let ticking = false

    function apply() {
      const max = document.documentElement.scrollHeight - window.innerHeight
      const progress = max > 0 ? window.scrollY / max : 0
      const pal = paletteAt(progress)
      root.style.setProperty("--landing-bg", pal.bg)
      root.style.setProperty("--landing-fg", pal.fg)
      root.style.setProperty("--landing-muted", pal.muted)
      root.style.setProperty("--landing-surface", pal.surface)
      root.style.setProperty("--landing-accent", pal.accent)
      root.style.setProperty("--landing-hue", pal.hue)
      root.style.setProperty("--landing-border", pal.border)
      ticking = false
    }

    function onScroll() {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(apply)
    }

    apply() // initial paint at the user's current scroll position
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll, { passive: true })

    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [])

  return null
}
```

- [ ] **Step 2: Verify type-check**

Run:

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/app/components/PaletteScroller.tsx
git commit -m "feat(web): add PaletteScroller client component"
```

---

## Task 5: Mount engine, delete LandingAmbient

**Files:**
- Modify: `apps/web/app/page.tsx`
- Delete: `apps/web/app/components/landing/LandingAmbient.tsx`

- [ ] **Step 1: Update `page.tsx`**

In `apps/web/app/page.tsx`:

Find:

```tsx
import { LandingAmbient } from "./components/landing/LandingAmbient"
```

Replace with:

```tsx
import { PaletteScroller } from "./components/PaletteScroller"
```

Find:

```tsx
    <div className="relative isolate">
      <LandingAmbient />
```

Replace with:

```tsx
    <div className="relative isolate">
      <PaletteScroller />
```

- [ ] **Step 2: Delete the old ambient file**

```
rm apps/web/app/components/landing/LandingAmbient.tsx
```

- [ ] **Step 3: Verify build**

```
pnpm --filter @dawn-ai/web build
```

Expected: PASS. The page should still render — it's now backed by the daylight defaults until sections are migrated; the hero will paint its own dark over the body so it still looks correct.

- [ ] **Step 4: Commit**

```
git add apps/web/app/page.tsx apps/web/app/components/landing/LandingAmbient.tsx
git commit -m "feat(web): mount PaletteScroller, remove LandingAmbient"
```

---

## Task 6: Migrate landing section backgrounds to transparent

This task removes hardcoded section backgrounds so each section reads through to the body's `var(--landing-bg)`. The hero (`HeroSection.tsx`) is intentionally left alone — its hardcoded cosmic dark matches the pre-dawn stop and is part of the parallax design.

**Files modified in this task:**
- `apps/web/app/components/landing/LogoWall.tsx`
- `apps/web/app/components/landing/ProblemSection.tsx`
- `apps/web/app/components/landing/ComparisonTable.tsx`
- `apps/web/app/components/landing/SolutionSection.tsx`
- `apps/web/app/components/landing/CodeExample.tsx`
- `apps/web/app/components/landing/DeploySection.tsx`
- `apps/web/app/components/landing/FeatureGrid.tsx`
- `apps/web/app/components/landing/HowItWorks.tsx`
- `apps/web/app/components/landing/EcosystemSection.tsx`

- [ ] **Step 1: LogoWall — drop hardcoded background**

In `apps/web/app/components/landing/LogoWall.tsx`, find:

```tsx
    <section className="relative px-8 py-14" style={{ background: "#020617" }}>
```

Replace with:

```tsx
    <section className="relative px-8 py-14">
```

- [ ] **Step 2: Strip `bg-bg-secondary/50` from sections that use it**

Each of these sections has a `<section className="... bg-bg-secondary/50">` wrapper. Remove `bg-bg-secondary/50` from each (keep the rest of the className intact):

- `apps/web/app/components/landing/CodeExample.tsx` line 40 (or wherever it appears)
- `apps/web/app/components/landing/ComparisonTable.tsx` line 37
- `apps/web/app/components/landing/EcosystemSection.tsx` line 21
- `apps/web/app/components/landing/FeatureGrid.tsx` line 30

For each file, find the substring `bg-bg-secondary/50 ` (with trailing space) or ` bg-bg-secondary/50` (with leading space) and delete it from the `className`.

Use grep to verify all are gone:

```
grep -rn "bg-bg-secondary" apps/web/app/components/landing
```

Expected: no results.

- [ ] **Step 3: Verify build**

```
pnpm --filter @dawn-ai/web build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add apps/web/app/components/landing
git commit -m "feat(web): drop hardcoded section backgrounds for landing arc inheritance"
```

---

## Task 7: Migrate card surfaces and text to palette variables

This task moves card-style surfaces (`bg-bg-card`, `border-border`) and text colors (`text-text-primary`, `text-text-secondary`, `text-text-muted`) to the new palette variables so they interpolate with the page.

**Strategy:** these are inline style overrides on the elements that previously used the static brand tokens. We do not touch the brand tokens themselves — they remain valid for non-landing surfaces (docs, header, footer).

The migration is mechanical: a small `<style>`-driven mapping at the top of each affected component, plus className edits where the static tokens were used.

The cleanest approach is to add a single utility CSS class block to `globals.css` that exposes "landing-aware" variants, then swap the classes in each section.

- [ ] **Step 1: Add landing utility classes to `globals.css`**

Append to the end of `apps/web/app/globals.css`:

```css
/* Landing-aware utilities — read from --landing-* and follow the scroll arc.
   Use these on landing-page elements that previously used bg-bg-card,
   border-border, or text-text-* brand tokens. */
.landing-surface {
  background: var(--landing-surface);
  border-color: var(--landing-border);
}
.landing-text {
  color: var(--landing-fg);
}
.landing-text-muted {
  color: var(--landing-muted);
}
.landing-border {
  border-color: var(--landing-border);
}
```

- [ ] **Step 2: Migrate per-file in landing components**

For each of these files, replace the listed classes:

In **all** of `apps/web/app/components/landing/*.tsx` (except `HeroSection.tsx`, `HeroEarthParallax.tsx`, `LogoWall.tsx`, and `CtaSection.tsx`):

| Find | Replace with |
|---|---|
| `bg-bg-card border border-border` | `landing-surface border` |
| `bg-bg-card` (when used as a surface) | `landing-surface` |
| `border-border-subtle` (when used on a landing-aware surface) | `landing-border` |
| `text-text-primary` | `landing-text` |
| `text-text-secondary` | `landing-text` |
| `text-text-muted` | `landing-text-muted` |

Use grep to find every occurrence:

```
grep -rn "bg-bg-card\|border-border\|text-text-primary\|text-text-secondary\|text-text-muted" apps/web/app/components/landing
```

Open each file in the result and apply the table above. Do **not** touch `HeroSection.tsx`, `HeroEarthParallax.tsx`, `LogoWall.tsx`, or `CtaSection.tsx` (the hero owns its own palette; LogoWall has only a label that already reads correctly; CtaSection is being rewritten in Task 8).

- [ ] **Step 3: Verify build, typecheck, lint**

```
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

Expected: all PASS. If lint flags class ordering, run:

```
pnpm --filter @dawn-ai/web exec biome check --config-path ../../packages/config-biome/biome.json --css-parse-tailwind-directives=true --write app
```

- [ ] **Step 4: Commit**

```
git add apps/web/app/globals.css apps/web/app/components/landing
git commit -m "feat(web): migrate landing section surfaces and text to palette variables"
```

---

## Task 8: Rewrite the closing CTA

**Files:**
- Modify: `apps/web/app/components/landing/CtaSection.tsx`

The new CTA is the user-approved D2 + grid full-width treatment from
`.superpowers/brainstorm/.../cta-d2-grid.html`.

- [ ] **Step 1: Read the current CtaSection to know what we're replacing**

```
cat apps/web/app/components/landing/CtaSection.tsx
```

This is for context only — the rewrite below replaces the file in full.

- [ ] **Step 2: Overwrite the file**

Replace the contents of `apps/web/app/components/landing/CtaSection.tsx` with:

```tsx
export function CtaSection() {
  return (
    <section
      className="relative w-full overflow-hidden border-t"
      style={{
        background: "linear-gradient(180deg, #fff7e0 0%, #ffe2a8 100%)",
        borderColor: "rgba(217,119,6,0.15)",
        padding: "180px 24px",
      }}
    >
      {/* Layer 1 — atmospheric corner blobs */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 25% 75%, rgba(196,167,231,0.30) 0%, transparent 50%), radial-gradient(ellipse at 75% 25%, rgba(127,200,255,0.24) 0%, transparent 50%)",
          zIndex: 0,
        }}
      />

      {/* Layer 2 — sun bloom rising from bottom (sits beneath the grid) */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          bottom: "-40%",
          left: "50%",
          width: "140%",
          height: "140%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at center, rgba(245,165,36,0.50) 0%, rgba(245,165,36,0.18) 28%, transparent 55%)",
          zIndex: 0,
        }}
      />

      {/* Layer 3 — amber dot grid, masked to fade at edges */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at center, rgba(217,119,6,0.28) 1px, transparent 1.6px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(ellipse at center, black 0%, black 45%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 0%, black 45%, transparent 78%)",
          zIndex: 1,
        }}
      />

      {/* Content */}
      <div className="relative max-w-[720px] mx-auto text-center" style={{ zIndex: 2 }}>
        <h2
          className="font-display font-semibold tracking-tight"
          style={{
            color: "#1a1530",
            fontSize: "clamp(40px, 6vw, 64px)",
            lineHeight: 1.05,
            letterSpacing: "-0.025em",
            marginBottom: "20px",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          Build your first agent in under a minute.
        </h2>
        <p
          className="mx-auto"
          style={{
            color: "#6d5638",
            fontSize: "19px",
            lineHeight: 1.55,
            marginBottom: "32px",
            maxWidth: "540px",
          }}
        >
          File-system routes, type-safe tools, no Zod boilerplate. Scaffold a project and run it in
          one terminal.
        </p>
        <div className="flex gap-3 justify-center flex-wrap">
          <a
            href="https://github.com/cacheplane/dawnai"
            className="inline-block rounded-xl font-semibold transition-transform"
            style={{
              padding: "16px 32px",
              fontSize: "16px",
              background: "#1a1530",
              color: "#fef4e6",
            }}
          >
            Start building →
          </a>
          <a
            href="/docs/getting-started"
            className="inline-block rounded-xl font-medium transition-colors"
            style={{
              padding: "16px 28px",
              fontSize: "16px",
              background: "rgba(26,21,48,0.04)",
              color: "#1a1530",
              border: "1px solid rgba(26,21,48,0.18)",
            }}
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Verify build, typecheck, lint**

```
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

Expected: all PASS. If lint complains about inline styles, that's expected — the hardcoded design values here are intentional (this section is the only landing section that does not interpolate; it owns the dawn-rising moment and stays at sunrise regardless of scroll).

- [ ] **Step 4: Commit**

```
git add apps/web/app/components/landing/CtaSection.tsx
git commit -m "feat(web): rewrite CtaSection as full-width dawn-rising panel with dotted grid"
```

---

## Task 9: Final verification

- [ ] **Step 1: Build, typecheck, lint all clean**

```
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

Expected: all PASS with zero warnings on landing files.

- [ ] **Step 2: Manual smoke — palette interpolation**

Start the dev server:

```
pnpm --filter @dawn-ai/web dev
```

Visit `http://localhost:3000` and scroll slowly. Verify:

- 0% scroll (hero) — cosmic dark, sun bloom visible behind earth.
- ~15% scroll (logo wall area) — twilight violet tint on body, no hard transition seam against the hero.
- ~30% scroll (Problem / Comparison) — dusk peach, surfaces still legible.
- ~50% scroll (Solution / CodeExample) — fully resolved sunrise cream, code panels read as light cards.
- ~75% scroll (Deploy / Features / How It Works / Ecosystem) — daylight; high contrast text on white-ish bg.
- 100% scroll (CTA) — daylight context above the CTA; CTA itself is the cream + dotted-grid + sun-bloom panel; no scroll-driven palette change inside the CTA.

If any boundary feels jarring (visible jump or color flicker), re-tune the corresponding stop in `lib/palette/stops.ts` and reload.

- [ ] **Step 3: Manual smoke — reduced motion**

Open DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion: reduce". Reload `http://localhost:3000`.

Verify:
- Page loads in daylight palette (cream-ish bg, dark text).
- Scrolling does not change the palette.
- The hero still paints its hardcoded cosmic dark; everything below is daylight.

Disable the emulation when done.

- [ ] **Step 4: Final commit if anything was tweaked**

If you adjusted stops or fixed any visual issue:

```
git add apps/web
git commit -m "chore(web): tune dawn arc stops after smoke test"
```

If nothing needed changing, skip this step.

---

## Verification checklist

After all tasks complete:

- [ ] All landing sections (except hero and CTA) consume `--landing-*` variables.
- [ ] `LandingAmbient.tsx` is deleted; `git ls-files apps/web/app/components/landing/` does not list it.
- [ ] `PaletteScroller` is mounted in `page.tsx` and renders nothing visible.
- [ ] CSS variables on `:root` default to pre-dawn cosmic; `prefers-reduced-motion` overrides to daylight.
- [ ] CTA renders as a full-width cream panel with dotted grid, sun bloom, atmospheric blobs, and dark primary button.
- [ ] No `bg-bg-secondary/50` remains in `apps/web/app/components/landing`.
- [ ] No `text-text-primary`, `text-text-secondary`, `text-text-muted`, or `bg-bg-card` remains in landing sections (excepting hero and CTA which intentionally hardcode).
- [ ] `pnpm --filter @dawn-ai/web build && typecheck && lint` all PASS.
- [ ] Manual scroll smoke and reduced-motion smoke both pass.
