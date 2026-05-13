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

---

## Desktop sweep (1024 + 1440)

**Date:** 2026-05-13
**Viewports:** 1024 × 768, 1440 × 900 (true viewports — DevTools closed, `window.innerWidth` confirmed at each resize)
**Routes covered:** All 9 routes, both viewports = 18 screens

### Critical

**C1 — IntelliSenseVisual tooltip clips at both 1024 and 1440**
`apps/web/app/components/landing/IntelliSenseVisual.tsx:36` · both viewports

The tooltip is `absolute left-[58%] w-[320px]` inside a `relative` wrapper that is itself inside `FeatureBlock`'s `visualColumn` div (`overflow-hidden`). At 1024px the visual column is ~500px wide; 58% + 320px = ~610px, overflowing by ~110px. At 1440px the column is wider but the tooltip still clips the last few characters of code lines and its own content (visible: `content: string` truncated, comment lines ending in `-st`, `{ st`).
Fix: add `overflow-visible` to the `visualColumn` wrapper in `FeatureBlock.tsx` for this section, or change tooltip positioning to `right-4` / `bottom-4` so it stays within the panel bounds. Alternative: reduce `left-[58%]` to `left-[40%]` and add `max-w-[calc(100%-40%-1rem)]`.

**C2 — Cmd+K search modal: "Copy prompt" and "···" buttons visually bleed through overlay**
`apps/web/app/components/docs/` (search overlay component) · 1440px

When the Cmd+K search modal is open, the docs page's "Copy prompt" button and ellipsis "···" button appear on top of or adjacent to the modal panel's upper-right corner (confirmed in zoomed screenshot). The overlay is `z-50 bg-page/80 backdrop-blur-sm` — near-white with 80% opacity — so the underlying page is barely dimmed, making the button visually appear to poke through. The modal panel itself does not extend to cover this area.
Fix: darken the backdrop to `bg-ink/40` or `bg-page/60` (designer call), or increase the `pt-[12vh]` offset so the modal panel clears the breadcrumb toolbar row. Also verify the breadcrumb toolbar row has a z-index lower than 50.

### Important

**I1 — Container max-width inconsistency across landing sections**
`apps/web/app/page.tsx` + section components · both viewports

Landing sections use four different `max-w` values on inner containers: `max-w-[1200px]` (Hero, proof strip, Routes, Tools, Types, DevLoop), `max-w-[920px]` (Why Dawn/problem statement section), `max-w-[1100px]` (LangGraph bet, Ecosystem, Three steps), `max-w-[820px]` (FAQ). This creates subtle rhythm drift: at 1440px all are unconstrained and differ visually. The problem statement at 920px feels noticeably narrower than its neighbours, and the 1100px sections create a mid-tier band.
Fix: Consolidate to two intentional widths — e.g. `max-w-[1200px]` for full-bleed feature sections and `max-w-[820px]` for reading-focused sections (FAQ, problem statement). The current 920px and 1100px values appear accidental.

**I2 — Hero H1 not responsive — same 64px at 1024 and 1440**
`apps/web/app/components/landing/Hero.tsx` (or global typography) · both viewports

H1 on landing is `64px / fw600 / ls-0.96px` at both 1024 and 1440 (Fraunces). No fluid/responsive scaling between breakpoints. The /brand type specimen documents Display XL as "72/76" and H1 as "40/44" — neither matches the landing's 64px. At 1440 the headline ("Build LangGraph agents like Next.js apps.") feels undersized relative to the large viewport and adjacent code panel.
Fix: Either update the /brand spec to reflect 64px as the canonical landing display size, or add a `lg:text-[80px]` / `xl:text-[88px]` step to the Hero H1 to scale up at wider viewports. Also resolve the spec vs. implementation mismatch in `/brand`.

**I3 — /brand H1 size (72px) doesn't match landing H1 (64px) or brand spec H1 (40px)**
`apps/web/app/brand/page.tsx` · 1440px

The /brand page H1 ("Dawn brand.") renders at 72px, which matches the brand specimen's "Display XL · 72/76" label — but the landing H1 is 64px and the brand specimen's "H1" entry is 40px. Three different sizes for the same semantic level across three contexts. This creates inconsistency for anyone using /brand as a reference.
Fix: Clarify in /brand that "Display XL" is a one-off hero-only size, "H1 (page title)" is 48px (as used in docs/blog), and the landing hero uses a custom `text-[64px]` — or rationalise to a single display scale token.

**I4 — Code panels overflow container at 1024px (Tools and Types sections)**
`apps/web/app/components/landing/FeatureTools.tsx`, `IntelliSenseVisual.tsx` · 1024px

The `pre` inside `CodeFrame` has `overflow-x-auto`, but the code in FeatureTools overflows by ~65px and IntelliSenseVisual overflows by ~183px at 1024px. The `overflow-x-auto` should allow horizontal scrolling within the panel, but combined with the `overflow-hidden` on `CodeFrame` the code is clipped rather than scrollable. Visual result: code lines are truncated with no scroll affordance visible to the user.
Fix: Verify that `CodeFrame`'s `overflow-hidden` is not suppressing the scroll. If so, remove `overflow-hidden` from the `CodeFrame` wrapper or move it to only the header bar element, leaving the content area as `overflow-auto`.

**I5 — Hero → proof strip gap: large dead space below hero content at 1024**
`apps/web/app/components/landing/Hero.tsx` · 1024px

At 1024×768 the hero section is 645px tall but the hero inner content (headline + code panel + CTA row) visually ends around 550–560px, leaving ~90px of empty cream background before the proof strip border. This gap is more prominent at 1024 than at 1440 (where the hero section still fills the viewport more naturally).
Fix: Inspect whether the hero uses `min-h-screen` or a fixed padding that over-extends at this breakpoint. Reduce `pt-20 md:pt-28` or add a `max-h` cap at lg breakpoint to tighten the hero-to-proof-strip transition.

### Minor

**M1 — /brand type specimen "H1" label (40/44) doesn't reflect live site**
`apps/web/app/brand/page.tsx` · both viewports

The brand specimen labels the H1 demo as "Fraunces 600 · 40/44" but docs/blog H1 renders at 48px/lh-48px/-1.2px. The specimen is displaying a smaller size than what's actually used.
Fix: Update the specimen size and label to match the live H1 token (48px/48px).

**M2 — Proof strip "WORKS WITH" label alignment at 1440**
`apps/web/app/components/landing/ProofStrip.tsx` · 1440px

At 1440px the proof strip is full-width with "BUILT ON · LangGraph.js · 98 stars · 3 contributors" left-aligned and "WORKS WITH · OpenAI · Anthropic · Google · Ollama" right-aligned. The label "WORKS WITH" sits inline with the provider names, creating a run-on feel. At 1024px this tightens further. Minor visual rhythm issue.
Fix: Separate "WORKS WITH" label onto its own column or add more spacing between the label and the list items to match the "BUILT ON" treatment.

**M3 — TOC rail at 1024: appears on blog posts but not explicitly tested for docs sidebar scroll behaviour**
`apps/web/app/components/docs/Sidebar.tsx` · 1024px

The left docs sidebar navigation is visible at 1024px (confirmed via screenshot) but its height/scroll behaviour was not tested. At 1024px with a long page, the sidebar may not be sticky-scrollable if it lacks `overflow-y-auto h-screen sticky top-[72px]`.
Fix: Confirm sidebar has sticky scroll at 1024 — if not, add `sticky top-[72px] h-[calc(100vh-72px)] overflow-y-auto` to the sidebar wrapper.

### Cross-route consistency observations

- **Fraunces H1 is consistent across all content routes** (blog index, blog post, docs page) at 48px/fw600/-1.2px. Landing hero H1 is 64px — intentionally larger as a display headline. /brand H1 is 72px, which is the "Display XL" specimen size. The three-tier scale (72 → 64 → 48) is defensible but undocumented.

- **Sticky header**: position:sticky, top:0, height 72px, scroll-padding-top:72px — confirmed working correctly at both viewports. No anchor-link overlap issues observed.

- **Footer is identical across all routes** — same four-column layout, same link set, same "Built on the LangChain ecosystem" tagline. Consistent.

- **DevLoopAnimation**: Renders cleanly as a terminal-style animated component at both viewports. Animation (compile → preserve → watch → update lines) visible and polished. No overflow or clipping issues.

- **Blog post three-column layout** (meta rail 240px | article max-w-760px | TOC 240px) is correct and present at both 1024 and 1440. TOC rail visible at both breakpoints (uses `lg:grid-cols-[240px_1fr_240px]` which activates at 1024px).

- **Search modal (Cmd+K)**: Opens correctly, shows structured results grouped by section. Functionally correct. Visual issue: backdrop too light (`bg-page/80` ≈ near-white) — provides minimal dimming effect; modal doesn't feel "elevated" from the page. The "Copy prompt" bleed-through (C2) worsens this.

- **No orphan dark/cosmic tokens found** across all 9 routes at both viewports. Color token migration is complete — all backgrounds resolve to `page`, `surface`, `surface-sunk`, or transparent.
