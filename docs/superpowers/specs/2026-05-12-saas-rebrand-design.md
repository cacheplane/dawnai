# Dawn Website SaaS-Style Rebrand — Design

**Date:** 2026-05-12
**Scope:** Whole site (landing, header, footer, docs/blog chrome, brand page)
**Type:** Visual rebrand + landing IA rewrite

## Summary

Rebrand the Dawn website around a restrained, developer-infrastructure aesthetic — off-white surfaces, near-black ink, single amber accent, Fraunces display + Inter body + JetBrains Mono code. Replace the current 17-section "cosmic dawn arc" landing page with a 14-section page structured for senior engineers and engineering managers evaluating Dawn for their team, with code-first product visuals and honest open-source proof points.

This is a meaningful rebrand, not a polish pass. The cosmic palette, palette scroller, parallax earth, comic strip, and atmospheric scroll motion all go. Only the Dawn name, logo, wordmark, and the tagline "Build LangGraph agents like Next.js apps" survive from the current brand. The amber color and Fraunces typeface are retained because they fit the new direction, not because they're sacred.

## Positioning & Audience

**Product:** Dawn — TypeScript meta-framework for LangGraph.js.

**Tagline (kept):** "Build LangGraph agents like Next.js apps."

**Supporting line (kept, lightly editable):** "Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate."

**Primary audience:** staff/principal engineers and engineering managers evaluating Dawn for their team. They need credibility, scope-of-claims clarity, honest pre-1.0 positioning, and a clean read on LangGraph compatibility.

**Secondary audience (same page):** the implementer dev who will `pnpm create` and read the docs. They need a working install command and a code example that scans without marketing copy on top.

**Tone:** plainspoken, opinionated where Dawn has a real opinion, honest about pre-1.0 status, no SaaS clichés. Confidence without overclaiming.

**Page must not:**
- Pretend Dawn has customer logos, business-outcome testimonials, compliance posture, or a sales motion.
- Hide that it's pre-1.0 or that it builds on LangGraph.js (the runtime dependency is a feature, not a leak).
- Inherit the cosmic/palette aesthetic. The dawn metaphor lives only in the name.

## Visual System

### Color tokens

```
--color-bg            #ffffff      page background
--color-surface       #fafaf7      cards, bands
--color-surface-sunk  #f4f2ec      FAQ, code wells, final CTA band
--color-ink           #14110d      primary text
--color-ink-muted     #5a554c      secondary text, captions
--color-ink-dim       #8a857b      eyebrows, tertiary
--color-border        #e6e3da      hairline borders
--color-border-strong #cfcabd      heavier dividers, focus rings
--color-accent        #d97706      primary CTA, links, marker emphasis (calibrated in PR 8)
--color-accent-ink    #ffffff      text on amber surfaces
--color-accent-soft   #fef3c7      amber-tinted highlight, used sparingly
```

The exact amber value is a starting point and gets tuned in PR 8 against AA contrast on small text. Likely shifts to `#b45309` for the CTA fill if `#d97706` doesn't meet AA against white.

### Typography

- Display: **Fraunces** (variable, opsz/SOFT/WONK kept). Weight 500–600.
- Body: **Inter**. 400 body, 500 emphasis, 600 small caps eyebrows.
- Code: **JetBrains Mono**. 400 body, 500 inline emphasis.

Type scale (rough, calibrate in execution):

```
Display XL  72/76   Fraunces 600  -1% tracking
Display L   56/60   Fraunces 600  -1%
H1          40/44   Fraunces 600
H2          28/34   Fraunces 600
H3          20/28   Inter 600
Body L      18/30   Inter 400
Body        16/26   Inter 400
Small       14/22   Inter 400
Eyebrow     12/16   Inter 600 uppercase tracked +6%
Code        14/22   JetBrains Mono 400
```

### Layout

- Content max-width 1200px, header max-width 1280px.
- Section vertical rhythm 96px desktop / 64px mobile.
- Two-column feature blocks alternate text/visual; single column below 880px.
- Card radius 12px outer, 8px inner for image frames.
- One shadow token: `0 1px 2px rgba(20,17,13,0.04), 0 8px 24px -8px rgba(20,17,13,0.08)`.
- Borders preferred over shadows; both together used sparingly.
- No glassmorphism, no decorative gradients beyond an optional amber-to-transparent band on the final CTA.

### Motion

- Hover: opacity/border 120ms ease.
- Reveal on scroll: 8px translate + opacity, 240ms ease, once. Respects `prefers-reduced-motion`.
- No parallax, no palette scroller, no scroll-jacked timelines.

### Accessibility floor

- AA contrast on body text and CTAs.
- Visible focus rings using `--color-border-strong` + 2px offset.
- Reduced-motion fallback collapses reveals.

## Page IA (Landing — 14 sections)

### 1. Nav (Header)

Left: Dawn wordmark. Center/right: Docs · Examples · Blog · GitHub. Right action: `CopyCommand` chip with `pnpm create dawn-ai-app` + "Docs" text link. Sticky, hairline border-bottom on scroll, no shadow.

### 2. Hero

- Eyebrow: `TypeScript meta-framework · for LangGraph.js`.
- H1: "Build LangGraph agents like Next.js apps."
- Sub: "Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. **Keep the runtime. Drop the boilerplate.**"
- Actions: `CopyCommand` (primary, amber) + "Read the docs" text link.
- Visual: single browser-framed card showing a file tree on the left and a route file open on the right with shiki highlighting. Reuses current `HeroCodeShowcase` content, reskinned. No parallax, no starfield, no sun bloom.

### 3. Proof strip

Single row, `--color-surface` band. Contents:
- "Built on LangGraph.js" lockup with LangChain mark + caption.
- GitHub star count (build-time fetched with ISR revalidation).
- Contributor count.
- Model provider strip: "Works with OpenAI · Anthropic · Google · Ollama · any LangGraph-compatible model."

No customer logos.

### 4. Why Dawn (editorial)

- H2: "Why we built Dawn."
- 2–3 short paragraphs in editorial Fraunces + Inter setting. Names the gap (LangGraph is powerful but writing real agents in it is high-boilerplate, untyped, slow-to-iterate), names Dawn's bet (a Next.js-shaped framework over the LangGraph runtime), and what Dawn is explicitly not (a replacement runtime, an LLM router, a hosting product).

### 5. Feature: File-system routing

- Eyebrow: "Routing".
- H2: "Routes for agents, not just pages."
- 3-line para + 3–5 benefit bullets.
- Visual: file tree screenshot (left) + route file shiki snippet (right).
- "See routing docs →" link.

### 6. Feature: Route-local tools

- Eyebrow: "Tools".
- H2: "Tools that live next to the route that uses them."
- Benefit bullets + a tool definition snippet showing inferred argument types and how the route consumes the tool.
- "See tools docs →" link.

### 7. Feature: Generated types end-to-end

- Eyebrow: "Types".
- H2: "Types that follow the data."
- Visual: VS Code screenshot (or carefully framed code with annotated callouts) showing IntelliSense on agent state inferred from a Zod schema, plus an inline code snippet.
- "See type generation docs →" link.

### 8. Feature: HMR + dev loop

- Eyebrow: "Dev loop".
- H2: "Edit, save, reload — without restarting the graph."
- Terminal screenshot of the dev server output + benefit bullets (incremental compile, persistent state across edits, etc.).
- Optional: short loop GIF/video showing edit→reload. Skippable.

### 9. Keep the runtime (trust)

- Eyebrow: "Compatibility".
- H2: "Your bet on LangGraph.js stays your bet."
- Editorial: Dawn compiles to LangGraph constructs; you can drop into raw `StateGraph` whenever you want; if Dawn disappears tomorrow, your graphs are still valid LangGraph code. Concrete checklist of "what Dawn does NOT do": replace the runtime, mediate LLM calls, host your agents, lock you into a deployment target.

### 10. Compatibility & ecosystem

- Eyebrow: "Ecosystem".
- H2: "Plays well with your stack."
- Text-and-mark grid (no carousel) grouped by category: Models, Observability (LangSmith), Vector stores, Deploy targets (Vercel / Cloudflare / Node / Docker). Each row is text + small marks, not a marketing logo wall.

### 11. Quickstart — How to evaluate Dawn

- Eyebrow: "Try it".
- H2: "Three steps to know if Dawn fits."
- Three numbered cards:
  1. `pnpm create dawn-ai-app my-agent` (with `CopyCommand`).
  2. Run an example: a route that calls a tool and returns typed state.
  3. Port one of your existing LangGraph graphs — link to a porting guide.
- Closes with "Read the docs →" + "See examples →".

### 12. FAQ

Accordion. Topics drafted from real docs in PR 6:
- Is Dawn production-ready? (honest pre-1.0 answer + what "production-ready" looks like on the roadmap)
- What's the relationship to LangGraph.js?
- What about Deep Agents / planned features? (names Phase 3 roadmap explicitly)
- Who maintains Dawn? Cadence?
- License?
- Can we use Dawn with hosted LangGraph platforms?
- How does Dawn affect our observability/LangSmith setup?
- What does Dawn cost?
- Migration: porting an existing graph?

First item open by default; rest collapsed.

### 13. Final CTA band

`--color-surface-sunk` full-width band.
- H2: "Start building."
- One supporting line.
- Actions: `CopyCommand` (primary) + "Star on GitHub →" (secondary).

### 14. Footer

Three columns: Product (Docs, Examples, Blog, Brand), Resources (LangGraph.js, GitHub, Discussions, RSS), Legal (License, Code of Conduct, Security). Bottom row: wordmark, version (if surfaced), copyright.

## Component Inventory

### New / refactored (under `app/components/`)

```
Header.tsx                         refactor — wordmark + nav links + install chip; remove dark scope
Footer.tsx                         refactor — three-column SaaS-style footer

landing/                           full replacement of current 17 components
  Hero.tsx                         new — replaces HeroSection + HeroEarthParallax + HeroCodeShowcase reskin
  ProofStrip.tsx                   new
  WhyDawn.tsx                      new
  FeatureBlock.tsx                 new — reusable (eyebrow/H2/copy/bullets/visual/link)
  FeatureBlockRouting.tsx          composes FeatureBlock
  FeatureBlockTools.tsx            composes FeatureBlock
  FeatureBlockTypes.tsx            composes FeatureBlock
  FeatureBlockDevLoop.tsx          composes FeatureBlock
  KeepTheRuntime.tsx               new — trust section
  Ecosystem.tsx                    new
  Quickstart.tsx                   new
  Faq.tsx                          new — accordion (keyboard accessible)
  FinalCta.tsx                     new

shared primitives
  CopyCommand.tsx                  keep, reskin to amber-on-cream
  Button.tsx                       new — primary (amber filled), secondary (text+icon)
  Eyebrow.tsx                      new
  CodeFrame.tsx                    new — browser-chrome frame around shiki output
  ScreenshotFrame.tsx              new — image variant with alt + caption
  Card.tsx                         new
  Accordion.tsx                    new — aria-friendly
  StarBadge.tsx                    new — GitHub star count
  ProviderMark.tsx                 new — small inline word+mark for ecosystem rows
```

### Deletions (PR 6)

```
app/components/PaletteScroller.tsx
app/components/ScrollReveal.tsx                kept and adapted if reusable; otherwise replaced
app/components/CreamSurface.tsx                obsolete (cream is the only system now)
app/components/landing/HeroEarthParallax.tsx
app/components/landing/HeroCodeShowcase.tsx    folded into new Hero
app/components/landing/HeroSection.tsx
app/components/landing/StarsSection.tsx
app/components/landing/BigReveal.tsx
app/components/landing/ComicStrip.tsx
app/components/landing/ProblemSection.tsx      content absorbed into WhyDawn
app/components/landing/SolutionSection.tsx     content absorbed into WhyDawn
app/components/landing/ComparisonTable.tsx     replaced by KeepTheRuntime + FAQ
app/components/landing/ArchitectureSection.tsx absorbed into KeepTheRuntime or dropped
app/components/landing/CodeExample.tsx         folded into feature blocks
app/components/landing/HowItWorks.tsx          replaced by Quickstart
app/components/landing/MigrateCta.tsx          replaced by FinalCta
app/components/landing/NotAReplacement.tsx     absorbed into KeepTheRuntime
app/components/landing/WhoItsFor.tsx           dropped (audience is the lead-in to WhyDawn)
app/components/landing/DeploySection.tsx       absorbed into Ecosystem
app/components/landing/EcosystemSection.tsx    rebuilt as Ecosystem.tsx
app/components/landing/FeatureGrid.tsx         replaced by feature blocks
app/components/landing/CtaSection.tsx          replaced by FinalCta
lib/palette/                                   palette stops + scroller engine
```

### Token / style changes

```
app/globals.css
  - drop @theme cosmic tokens (dawn-black, neutral-gray)
  - drop .landing-dark scope
  - drop --landing-bg/fg/muted/surface/accent/hue/border vars
  - drop body { background: var(--landing-bg) ... }
  - introduce new @theme palette (Visual System)
  - simplify body to bg/ink defaults

app/layout.tsx
  - remove `<html className="dark ...">`
  - remove CreamSurface wrapper

mdx-components.tsx
  - prose-dawn link color → --color-accent
  - inline code chip restyled
```

### Cross-site touchpoints (per "whole site" scope)

```
app/blog/**     re-token only (PR 7); no layout change
app/docs/**     re-token; sidebar/links/headings recolored; ReadingLayout uses new --header-h
app/brand/**    rewrite — documents the new system (PR 1)
```

### Tests / verification

- Existing vitest setup. Add smoke render test per new section component.
- Visual regression is manual — start dev server, walk the page.
- AA contrast verified with axe-core or equivalent in PR 8.

## Implementation Plan (PR Sequence)

In-place rewrite. New tokens introduced alongside the cosmic system in PR 1 so old sections keep rendering until each is replaced. Cosmic system deleted in PR 6, not at the start. CI green at every step.

**PR 1 — Foundation**
- Add new color + type tokens to `app/globals.css` (no deletion).
- Build primitives: `Button`, `Eyebrow`, `CodeFrame`, `ScreenshotFrame`, `Card`, `Accordion`, `StarBadge`, `ProviderMark`.
- Refresh `Header` (drop dark scope, install chip) and `Footer` (three-column).
- Rewrite `/brand` page as the v2 system documentation.
- Page still renders old landing; visible change limited to chrome + brand page.

**PR 2 — Hero replacement**
- New `Hero.tsx` replaces hero stack.
- `page.tsx` imports updated.
- Old hero files left on disk until PR 6; not imported.
- `<html className="dark">` removed from layout.

**PR 3 — ProofStrip + WhyDawn**
- Replaces `ProblemSection`, `WhoItsFor`, `SolutionSection`.

**PR 4 — Feature blocks**
- Reusable `FeatureBlock` primitive.
- Four section instances: Routing, Tools, Types, Dev loop.
- Replaces `FeatureGrid`, `CodeExample`.
- Real shiki snippets and at least one VS Code IntelliSense screenshot captured.

**PR 5 — KeepTheRuntime + Ecosystem + Quickstart**
- Three sections in one PR.
- Replaces `NotAReplacement`, `ComparisonTable`, `ArchitectureSection`, `DeploySection`, `EcosystemSection`, `HowItWorks`.

**PR 6 — FAQ + FinalCta + cosmic cleanup**
- New `Faq` and `FinalCta` sections.
- Delete cosmic system (see Deletions above).
- `page.tsx` now imports only new components.
- Rebrand fully visible.

**PR 7 — Docs/blog re-token pass**
- Apply new tokens to docs and blog chrome (sidebar, links, headings, code chips, callouts).
- `mdx-components.tsx` updated.
- No layout changes.

**PR 8 — Calibration**
- Amber value tuning on cream (AA contrast).
- Copy polish across all sections.
- Final visual walk desktop + mobile.

### Per-PR checks
- `pnpm typecheck` + `pnpm build` + `pnpm test` (build-before-typecheck ordering per CI convention).
- Smoke render test for new section components.
- Manual visual review on dev server before requesting review.

### Out of scope (deliberate)
- `prefers-color-scheme: dark` support — no dark mode in this rebrand.
- Animations beyond the lightweight reveal primitive.
- Marketing copy beyond what fits each section's content slot — full copy review happens in PR 8.

## Risks

1. **Amber on cream contrast.** `#d97706` on `#ffffff` is borderline for AA on small text. Calibrated in PR 8; likely shifts to `#b45309` for CTA fill or moves to amber text on `--color-accent-soft` chip for non-CTA highlights.
2. **Loss of visual personality.** Removing the palette scroller, parallax earth, and comic strip is a real subtraction. The page must earn restraint with editorial copy quality. Copy gets explicit attention in PR 8.
3. **Recent work being deleted.** The last five commits on `main` are landing-section work. Worth one last look before PR 6 — new page can borrow editorial phrases the old sections already polished.
4. **Pre-1.0 honesty in FAQ.** Wording "is Dawn production-ready?" wrong either oversells (loses trust with senior engineers) or undersells. Needs Brian-voice drafting.
5. **Whole-site re-token blast radius.** Docs/blog MDX leans on tokens like `.prose-dawn` link styling and `.mdx-inline-code` chip. PR 7 includes a docs-page walk on dev server before merge.
6. **GitHub star count freshness.** Build-time fetch with ISR revalidation, or display a range ("Hundreds of devs building") if exact count feels small.

## Open Calibrations (deferred to execution)

- Exact amber CTA value.
- Hero artifact composition: file tree + one route file? tree + route + generated-types panel? Decided in PR 2.
- Whether the four feature blocks (Routing/Tools/Types/Dev loop) all stand on their own or two collapse into one. Decided in PR 4.
- Quickstart visual: static three-card layout, animated terminal recording, or screenshot loop. Decided in PR 5.
- FAQ items + answers — drafted from real docs in PR 6.
- Secondary CTA destination ("Star on GitHub" vs. Discussions vs. mailto). Decided in PR 6.
- Whether `ScrollReveal` adapts to the new lighter motion or gets replaced. Decided in PR 6.
