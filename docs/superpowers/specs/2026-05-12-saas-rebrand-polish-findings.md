# SaaS Rebrand Polish — Visual Sweep Findings

**Date:** 2026-05-13
**Sweep coverage:** 9 of 9 routes visited; all at 330px actual viewport (DevTools responsive mode locked — resize_window could not override). Desktop layout verified via JS computed styles and source reading. Full 45-screen matrix not achievable at this viewport; approximately 9 screens captured plus JS analysis of 35 additional layout/style states.

> **Viewport note:** Chrome DevTools responsive mode was active at 330×715px for the entire session. `resize_window` calls were accepted (reported success) but `window.innerWidth` remained 330px throughout. Findings below reflect mobile layout observed + desktop layout inferred from source code and computed-style queries at breakpoints.

---

## Critical

**[330px]** `apps/web/app/components/landing/FeatureTypes.tsx` — "Types that follow the data" section causes 655px horizontal overflow on mobile. The `lg:grid-cols-2` grid collapses to a single column but the grid child `<div>` expands to 631px (double the viewport) because the Shiki code block inside has wide pre content without a proper `min-w-0` constraint on the grid cell, and `overflow-hidden` on `CodeFrame` doesn't contain the grid layout. Fix: add `min-w-0` to both grid children in `FeatureBlock` (`<div className="grid lg:grid-cols-2 ...">` children), or add `overflow-hidden` to the outer section.

**[330px]** `apps/web/app/globals.css` + `apps/web/app/blog/[slug]/page.tsx` — `.mdx-inline-code` has `white-space: nowrap` with no `overflow-wrap` fallback. Long inline code spans (e.g. `// src/app/support/[tenant]/index.ts`) in blog posts cause 554px horizontal overflow on `/blog/dawn-0-4-release`. Fix: add `overflow-wrap: break-word` or `max-width: 100%; display: inline-block` to `.mdx-inline-code`, or conditionally truncate with ellipsis.

**[330px]** `apps/web/app/brand/page.tsx:Scale section` — The `font-display text-[72px]` paragraph ("Build LangGraph agents.") inside a `rounded-xl border` card overflows to 326px scrollWidth in a 282px-wide container. The card uses `overflow: visible` (default). Fix: add `overflow-hidden` or `break-words` to the card containing the Scale section, or reduce the display size at `sm:` breakpoints.

---

## Important

**[all viewports]** `apps/web/app/components/ReadingLayout.tsx` + `apps/web/app/components/Header.tsx` — Docs/blog sidebars use `sticky top-[var(--header-h)]` (72px offset) but the site header has `position: static` — it scrolls away. After scrolling past the header, the sidebars stick to 72px from the top of the viewport, leaving a phantom gap where the header used to be. Fix: either make the header `sticky top-0` (add `sticky top-0 z-50` to `HeaderInner`'s `<header>`) or change the sidebar `top` to `top-0`.

**[all viewports]** `apps/web/app/brand/page.tsx:47` — Accent color swatch is hardcoded as `#d97706` (amber-600) but `--color-accent-saas` resolves to `#b45309` (amber-700) — verified by reading the CSS variable at runtime. The brand page is the source of truth for tokens and is showing the wrong value. Fix: change line 47 from `value: "#d97706"` to `value: "#b45309"`.

**[all viewports]** `apps/web/app/blog/page.tsx:16` + `apps/web/app/components/blog/PostHeader.tsx` — Eyebrow treatment is inconsistent across blog routes. The blog index page uses an inline `div` with `text-[11px] uppercase tracking-widest text-accent-saas` (amber, 11px, tracking-widest). PostHeader uses `text-[11px] uppercase tracking-widest text-ink-dim` (dim, 11px). The `<Eyebrow>` component (used on landing, brand, docs) is `text-xs` (12px) `font-semibold tracking-[0.06em] text-ink-dim`. Three different specs for the same UI pattern across blog vs landing vs brand. Fix: use the `<Eyebrow>` component in `blog/page.tsx` and `PostHeader`; use `tone="accent"` on the blog index eyebrow if amber is intentional.

**[all viewports]** `apps/web/app/components/landing/Hero.tsx:27` — Hero eyebrow (`TypeScript meta-framework · for LangGraph.js`) duplicates the `<Eyebrow>` component's class string inline instead of using the component. Diverges if `<Eyebrow>` evolves. Fix: replace with `<Eyebrow>TypeScript meta-framework · for LangGraph.js</Eyebrow>`.

**[330px]** `apps/web/app/components/landing/` — Five landing sections overflow horizontally at mobile (Hero: 386px, FeatureRouting: 386px, FeatureTools: 537px, FeatureTypes: 655px, FeatureDevLoop: 419px). All share the same root cause: `lg:grid-cols-2` grid children lack `min-w-0`, allowing code block content to set the column's intrinsic width. Fix: add `min-w-0 overflow-hidden` to both column wrappers inside `FeatureBlock`'s grid.

---

## Minor

**[all viewports]** `apps/web/app/components/landing/KeepTheRuntime.tsx:62` — Inline eyebrow `text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim` duplicated (not using `<Eyebrow>` component) within the compatibility grid card. Fix: replace with `<Eyebrow>`.

**[all viewports]** `apps/web/app/components/landing/Ecosystem.tsx:75` — Same pattern: eyebrow styles duplicated inline in the Ecosystem grid card. Fix: replace with `<Eyebrow>`.

**[all viewports]** `apps/web/app/components/blog/PostMeta.tsx` — Section label eyebrows (Published, Reading time, Tags, Author) use `text-[10px] uppercase tracking-widest` — a third distinct spec. These are intentionally smaller as sidebar metadata, but `tracking-widest` differs from both `<Eyebrow>`'s `tracking-[0.06em]` and `PostHeader`'s `tracking-widest`. Consider introducing a `size="sm"` variant on `<Eyebrow>` to unify.

**[all viewports]** `apps/web/app/components/landing/` — Section container max-widths vary across landing: Hero/FeatureBlocks use `max-w-[1200px]`, KeepTheRuntime/Quickstart/FinalCta use `max-w-[1100px]`, WhyDawn uses `max-w-[920px]`, Faq uses `max-w-[820px]`. The variation is intentional (narrower = more readable for text-heavy sections), but the gap between 1200px and 1100px for adjacent sections may cause visible content-edge drift at wide viewports. Fix: evaluate whether FeatureBlock sections should share the 1100px cap with peers, or explicitly document the intentional width stagger.

**[all viewports]** `apps/web/app/components/Header.tsx` — Header `<nav>` is `hidden md:flex` but includes a `<CopyCommand>` component (the install command) in the desktop nav bar. At `md` breakpoints this command widget is in the header alongside nav links. Verify the tap-target height meets 44px for the copy button — confirmed 21px rendered height at 330px mobile (not applicable), but at desktop the button is `p-1` which may be under 44px. Fix: ensure copy button is at least `p-2` or wraps in a container with `min-h-[44px]`.

**[330px]** `apps/web/app/blog/page.tsx` — Blog index post card (`Essay · 5 min read` eyebrow) uses `rgb(180, 83, 9)` (accent-saas) for the category label inside a card. The featured card has a warm cream background (`rgb(250, 250, 247)` = surface), while tag-filtered cards appear on plain white. This color inconsistency between featured and regular cards is minor but noticeable.

---

## Cross-route consistency

**Landing hero vs `/blog` "Notes on Dawn"**: Landing hero H1 is Fraunces 600 at 40px mobile → 72px desktop. Blog H1 is Fraunces 600 at 36px mobile → 48px desktop. Weight and family match; the size difference is intentional (marketing hero vs editorial heading). However the eyebrow treatment diverges: landing hero is `text-ink-dim` inline, blog index is `text-accent-saas` inline via a different class string — these should both be `<Eyebrow>` component calls with explicit `tone=` to make intent readable.

**Feature blocks (FeatureRouting / FeatureTools / FeatureTypes / FeatureDevLoop)**: All four share `FeatureBlock` with identical section padding (`py-20 md:py-28`), max-width (`max-w-[1200px]`), and grid spec (`lg:grid-cols-2 gap-12 lg:gap-16`). Spacing rhythm is consistent. The alternating `imageSide` prop correctly flips layout. Mobile overflow is the shared defect (all five feature sections — including Hero — overflow at 330px due to the same `min-w-0` omission).

**`/brand` vs rest of site**: Brand page feels coherent — same Fraunces display font, same token set, same header/footer chrome. The H1 at 56px is larger than docs/blog (36px) but matches the landing's `md:` breakpoint size, giving it appropriate authority as a brand reference page. Two issues break the "source of truth" premise: (1) the accent swatch is the wrong hex value (`#d97706` vs `#b45309`), and (2) the Scale section overflows on mobile. Otherwise `/brand` reads as part of the same system.

**Header chrome across all 9 routes**: Header background is `bg-page` (white), border-b `border-divider`, Fraunces logo + Inter nav links. Identical on all routes. The header is `position: static` on every route — consistent but means docs sidebar sticky offset is wrong everywhere (see Important #1).

**Color token usage**: No orphan cream (`#f5f0e8`, `#fffbf5`) or cosmic surface (`#0a0a1a`, deep navy) values found anywhere in computed styles across all 9 routes. All background colors resolve to the SaaS token set (`page`, `surface`, `surface-sunk`) or transparent. The rebrand token migration appears complete.

**Reading column width**: Blog posts and docs both use `ReadingLayout`'s center column (`max-w-[760px] mx-auto`). Blog post body text renders at 18px/29.25px (Inter, `ink-muted`), docs body at 16px/28px. The slightly larger blog body type is appropriate for long-form reading. Both feel intentional rather than accidental.

---

## Re-verify results

**Re-verified against commit `a3298b5` (2026-05-13). Viewport note: DevTools responsive mode locked at 330×715px; `resize_window` accepted but `window.innerWidth` remained 330px. Checks at 537px (after `resize_window 1280px`) are also noted where relevant.**

- **Critical 1 — Landing mobile overflow:** ⚠️ Partial — `document.documentElement.scrollWidth === innerWidth` at 537px viewport (no page-level overflow). However per-section JS check at 330px confirms sections 4 ("FeatureTools", sw=537px) and 6 ("FeatureDevLoop", sw=419px) still overflow at true mobile width. Root cause: the `imageSide="left"` render path in `FeatureBlock.tsx` wraps `textColumn`/`visualColumn` in `<div className="lg:order-1 order-2">` / `<div className="lg:order-2 order-1">` wrappers that were not given `min-w-0`. The fix added `min-w-0` to the inner column divs but not to these outer order-wrapper grid cells. The red-border overflow indicator was visible in the DevTools responsive-mode screenshot at 330px.

- **Critical 2 — Blog post inline code overflow:** ✅ Fixed — `/blog/dawn-0-4-release` at 330px: `document.documentElement.scrollWidth === innerWidth` (no overflow). Inline `<code>` elements now have `overflow-wrap: break-word` computed style (previously `normal`). `white-space: nowrap` is still set but the `overflow-wrap` fallback prevents page-level blowout.

- **Critical 3 — Brand page Scale overflow:** ✅ Fixed — `/brand` at 330px: `scrollWidth === innerWidth` (no overflow). The Scale section display text was reduced from `text-[72px]` to `text-3xl md:text-4xl`; section `scrollWidth` is 327px within the 330px viewport. `overflow-hidden` was not needed — the font-size reduction itself resolved the overflow.

- **Important 1 — Sticky header:** ✅ Fixed — `/docs/getting-started` scrolled to 1000px: `getComputedStyle(header).position === "sticky"`, `top === "0px"`. Header remains pinned. `HeaderInner.tsx` now applies `sticky top-0 z-50` (or equivalent) to the `<header>` element.

- **Important 2 — Brand page accent hex:** ✅ Fixed — `/brand` accent-saas swatch now displays `#b45309`. Previously showed `#d97706`. Confirmed via DOM text search — the correct amber-700 value is rendered.

- **Important 3 — Eyebrow consistency (blog index vs post):** ✅ Fixed — Blog index "Blog" eyebrow: `text-xs font-semibold uppercase tracking-[0.06em] text-accent-saas` → 12px, 0.72px ls, fw 600. Post header "Essay · 5 min read" eyebrow: `text-xs font-semibold uppercase tracking-[0.06em] text-accent-saas` → 12px, 0.72px ls, fw 600. Both pages now resolve to identical computed font-size and letter-spacing, matching the `<Eyebrow>` component spec.

- **Important 4 — Hero eyebrow:** ✅ Fixed — `/` Hero eyebrow ("TypeScript meta-framework · for LangGraph.js"): `text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim` → 12px, 0.72px ls, fw 600. Now uses `<Eyebrow>` component (rendered as `<p>` tag) instead of inline class string. Matches spec.

- **Important 5 — Landing feature blocks (mobile overflow):** ⚠️ Partial — Same as Critical 1. Sections 0–3 and 5 show no overflow at 330px. Sections 4 (FeatureTools) and 6 (FeatureDevLoop) still overflow at 330px due to the missing `min-w-0` on the `imageSide="left"` order-wrapper grid cells. Fix needed in `apps/web/app/components/landing/FeatureBlock.tsx`: add `min-w-0` to both `<div className="lg:order-1 order-2">` and `<div className="lg:order-2 order-1">` wrappers.
