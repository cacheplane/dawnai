# Big Reveal Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-height (100vh) pull-quote section between `ComparisonTable` and `SolutionSection` on the landing page that pays off the dawn metaphor with a sharp question + pivot ("Why do agent codebases drift, duplicate, and rot? / No framework.") set on a hand-tuned dusk → cream gradient.

**Architecture:** One new server component `BigReveal.tsx` that renders a `<section>` with `min-height: 100vh`, an inline gradient background matching the engine's dusk → sunrise → daylight values, two decoration layers (sun bloom + faint star dots), and centered serif content. One-line insertion in `page.tsx` mounts it inside a `ScrollReveal`. No JS, no animation, no palette-engine integration changes — the section sets its own bg explicitly.

**Tech Stack:** React 19, Next.js 16, TypeScript 6, Tailwind v4, Fraunces serif via `--font-display`.

**Spec:** `docs/superpowers/specs/2026-05-08-big-reveal-section-design.md`

---

## File structure

**New:**
- `apps/web/app/components/landing/BigReveal.tsx` — the section component.

**Modified:**
- `apps/web/app/page.tsx` — import and mount `<BigReveal />` between `<ComparisonTable />` and `<SolutionSection />`, both wrapped in `ScrollReveal`.

That's the complete change footprint.

---

## Task 1: Create the `BigReveal` component

**Files:**
- Create: `apps/web/app/components/landing/BigReveal.tsx`

- [ ] **Step 1: Write the file**

Create `apps/web/app/components/landing/BigReveal.tsx`:

```tsx
/**
 * Full-height pull-quote section that sits between ComparisonTable and
 * SolutionSection on the landing page. The "big reveal" — the moment the
 * page resolves from dusk into cream daylight, with a sharp question + pivot.
 *
 * Sets its own gradient background explicitly so the dusk → cream payoff is
 * visually exact, regardless of where the scroll-driven palette engine is
 * interpolated at this scroll position.
 *
 * No JS, no animation. The 100vh of vertical space is the moment.
 */
export function BigReveal() {
  return (
    <section
      className="relative w-full overflow-hidden flex items-center justify-center"
      style={{
        minHeight: "100vh",
        padding: "80px 24px",
        background:
          "linear-gradient(180deg, #3a2840 0%, #6a3848 25%, #c46c3e 55%, #fef4e6 88%, #fffcf4 100%)",
      }}
    >
      {/* Sun bloom rising at bottom-center */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          bottom: "-20%",
          left: "50%",
          width: "140%",
          height: "90%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at center, rgba(251,191,36,0.45) 0%, rgba(245,165,36,0.18) 30%, transparent 60%)",
          zIndex: 0,
        }}
      />

      {/* Faint star dots — fading remnants of the cosmic field, scattered in upper third */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.55) 1px, transparent 1.6px), radial-gradient(circle at 65% 12%, rgba(255,255,255,0.45) 1px, transparent 1.6px), radial-gradient(circle at 82% 22%, rgba(255,255,255,0.6) 1px, transparent 1.6px), radial-gradient(circle at 35% 14%, rgba(255,255,255,0.5) 1px, transparent 1.6px), radial-gradient(circle at 48% 26%, rgba(255,255,255,0.4) 1px, transparent 1.6px)",
          zIndex: 0,
        }}
      />

      {/* Content */}
      <div className="relative max-w-[760px] text-center" style={{ zIndex: 2 }}>
        <p
          className="font-display mx-auto"
          style={{
            color: "rgba(254, 244, 230, 0.92)",
            fontSize: "clamp(28px, 4vw, 40px)",
            fontWeight: 500,
            lineHeight: 1.2,
            marginBottom: "28px",
            maxWidth: "720px",
            textShadow: "0 2px 18px rgba(0,0,0,0.35)",
            fontVariationSettings: "'opsz' 144, 'SOFT' 50",
          }}
        >
          Why do agent codebases drift, duplicate, and rot?
        </p>
        <h2
          className="font-display"
          style={{
            color: "#1a1530",
            fontSize: "clamp(56px, 9vw, 96px)",
            fontWeight: 700,
            letterSpacing: "-0.025em",
            lineHeight: 1,
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
          }}
        >
          No framework.
        </h2>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Verify type-check**

Run from worktree root:

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS (no errors). The component is not yet imported anywhere, so it must compile in isolation.

- [ ] **Step 3: Commit**

```
git add apps/web/app/components/landing/BigReveal.tsx
git commit -m "feat(web): add BigReveal full-height pull-quote section"
```

---

## Task 2: Mount `BigReveal` in the landing page

**Files:**
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Add the import**

In `apps/web/app/page.tsx`, find the imports block. Find:

```tsx
import { ArchitectureSection } from "./components/landing/ArchitectureSection"
```

Add a new import line directly under it:

```tsx
import { BigReveal } from "./components/landing/BigReveal"
```

The imports block will end up with `BigReveal` listed alphabetically among the other landing imports.

- [ ] **Step 2: Mount it between Comparison and Solution**

In the JSX returned from `HomePage`, find:

```tsx
      <ScrollReveal>
        <ComparisonTable />
      </ScrollReveal>
      <ScrollReveal>
        <SolutionSection />
      </ScrollReveal>
```

Replace with:

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

- [ ] **Step 3: Verify build, typecheck, lint**

Run from worktree root:

```
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

All three should PASS. If lint flags formatting on `page.tsx` (likely import ordering), run:

```
pnpm --filter @dawn-ai/web exec biome check --config-path ../../packages/config-biome/biome.json --css-parse-tailwind-directives=true --write app/page.tsx
```

Then re-run lint to confirm clean.

- [ ] **Step 4: Commit**

```
git add apps/web/app/page.tsx
git commit -m "feat(web): mount BigReveal between Comparison and Solution"
```

---

## Task 3: Verification

- [ ] **Step 1: Confirm build, typecheck, and lint are all clean**

Run from worktree root:

```
pnpm --filter @dawn-ai/web build && pnpm --filter @dawn-ai/web typecheck && pnpm --filter @dawn-ai/web lint
```

Expected: all PASS.

- [ ] **Step 2: Manual smoke test**

Start the dev server (or verify it's already running on port 3000):

```
pnpm --filter @dawn-ai/web dev
```

Visit `http://localhost:3000`. Scroll past the comparison table. Verify:

1. The reveal section is visible immediately after `ComparisonTable` and before `SolutionSection`.
2. It occupies the full viewport height — you have to scroll a full screen to pass it.
3. The setup line "Why do agent codebases drift, duplicate, and rot?" reads in cream serif near the top of the section, legible against the dusk gradient.
4. The pivot "No framework." sits below it in much larger dark serif, hitting hard against the cream-resolved bottom of the gradient.
5. A subtle amber sun-bloom is visible behind/below the text.
6. A handful of faint star dots are scattered across the upper third.
7. Resizing the window narrower scales the type down via `clamp()` — the quote remains centered and readable on mobile widths.
8. No layout shift, no animation, no JS errors in the console.

- [ ] **Step 3: Manual smoke — reduced motion**

Open DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion: reduce". Reload `http://localhost:3000`.

Verify the reveal section still renders identically (it should — there's no animation to disable). The surrounding palette engine bails out as designed; the reveal section's hand-drawn gradient is unaffected.

Disable the emulation when done.

- [ ] **Step 4: No commit needed unless tweaks were made**

If the visual smoke surfaced anything that needed adjusting (gradient stops, type scale, sun-bloom intensity), make the change in `BigReveal.tsx`, re-run the verification, and commit:

```
git add apps/web/app/components/landing/BigReveal.tsx
git commit -m "chore(web): tune BigReveal after smoke test"
```

If nothing needed changing, skip this step.

---

## Verification checklist

After all tasks complete:

- [ ] `apps/web/app/components/landing/BigReveal.tsx` exists.
- [ ] `apps/web/app/page.tsx` imports `BigReveal` and renders it inside a `ScrollReveal` between `ComparisonTable` and `SolutionSection`.
- [ ] `pnpm --filter @dawn-ai/web build && typecheck && lint` all PASS.
- [ ] Manual scroll smoke confirms the section sits at full viewport height with the gradient + quote + sun bloom + star dots rendering correctly on desktop.
- [ ] Mobile-width smoke (DevTools narrow viewport) confirms the type clamps down and the layout holds.
- [ ] Reduced-motion smoke confirms the section renders identically.
