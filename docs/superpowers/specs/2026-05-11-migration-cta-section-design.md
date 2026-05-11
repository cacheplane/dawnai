# Migration CTA Section — Design

**Date:** 2026-05-11
**Status:** Approved
**Scope:** apps/web — new `MigrateCta` micro-section inserted before `CtaSection`

## Problem

The `/docs/migrating-from-langgraph` page exists and is well-written, but the landing page never surfaces it. GTM research identifies migration as the **primary conversion path** for Dawn's highest-intent audience (existing LangGraph builders moving prototype → production / scaling across teams), yet the landing flow currently treats every visitor as a from-scratch user with the same CTAs ("Copy prompt", "Read the docs", "Start building").

Result: the LangGraph user who scrolls all the way down, feels the pain, sees the trust signals, and is ready to act — and gets the same generic CTA as the from-scratch user. The migration path is invisible until they manually find it in the docs sidebar.

## Goals

- Surface migration as an audience-specific path right before the universal CTA.
- Keep the existing CTAs (hero + bottom `CtaSection`) unchanged — the migration CTA is additive, not a replacement.
- Compact section that's easy to skip for from-scratch readers and impossible to miss for LangGraph readers.
- Single click takes the LangGraph user to `/docs/migrating-from-langgraph`.

## Non-goals

- Hero CTA changes. Hero stays Copy prompt + Read the docs.
- `CtaSection` changes. Bottom CTAs stay "Start building" / "Read the docs".
- Comparison pages (`/compare/dawn-vs-langgraph` etc.) — separate SEO work.
- Character/dialog section — later brainstorm.
- Any rewrite of the `/docs/migrating-from-langgraph` page itself — already in good shape per PR #90.

## Approach

### New section: `MigrateCta.tsx`

File: `apps/web/app/components/landing/MigrateCta.tsx`. Server component.

Compact banner — eyebrow → headline → single CTA. Centered, ~30vh of vertical space. Matches the dark-theme landing palette (no light-mode switch). Slot in between `NotAReplacement` and `CtaSection`.

Voice (locked):

- **Eyebrow:** `ALREADY ON LANGGRAPH?`
- **Headline:** `Bring your project. Migrate in an afternoon.`
- **CTA button:** `Migrate from LangGraph →`
- **CTA href:** `/docs/migrating-from-langgraph`

Component shape:

```tsx
import Link from "next/link"

export function MigrateCta() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Already on LangGraph?
        </p>
        <h2
          className="font-display text-4xl md:text-5xl font-semibold landing-text leading-[1.1] tracking-tight text-balance"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Bring your project. Migrate in an afternoon.
        </h2>
        <div className="mt-8">
          <Link
            href="/docs/migrating-from-langgraph"
            className="inline-flex items-center gap-2 bg-accent-amber text-bg-primary px-5 py-3 rounded-md font-semibold hover:bg-accent-amber-deep transition-colors"
          >
            Migrate from LangGraph →
          </Link>
        </div>
      </div>
    </section>
  )
}
```

Visual conventions match the prior new landing sections (`WhoItsFor`, `NotAReplacement`, `StarsSection`):
- Same eyebrow style (amber dot, uppercase, tracking-widest)
- Same `font-display` headline with `fontVariationSettings`
- Amber filled CTA button (matches StarsSection's "Star on GitHub" treatment)

### `page.tsx` insertion point

Current section order ends:
```
...StarsSection → NotAReplacement → CtaSection
```

New order:
```
...StarsSection → NotAReplacement → MigrateCta → CtaSection
```

`MigrateCta` is wrapped in `<ScrollReveal>` like the other late-page sections.

### Voice rules (carry forward)

- Short, declarative sentences
- No hedge words
- Direct address
- No marketing superlatives (the "afternoon" claim earns its place — concrete, contextual, audience-specific)

## Architecture

```
apps/web/app/components/landing/
└── MigrateCta.tsx       # NEW

apps/web/app/page.tsx    # add import + JSX insertion
```

One new file, one edit. No deletions.

## Testing

- `pnpm --filter @dawn-ai/web build`, `typecheck`, `lint` all pass.
- Manual smoke at `/` desktop (1440x900):
  - After scrolling past `NotAReplacement`, the reader sees the `MigrateCta` banner.
  - Eyebrow "ALREADY ON LANGGRAPH?" reads as an audience selector.
  - Headline is clearly distinct from the `CtaSection` headline below.
  - "Migrate from LangGraph →" CTA links to `/docs/migrating-from-langgraph` — verify with a click.
  - Visual rhythm is *trust signal → audience-specific CTA → universal CTA*. The two CTA blocks don't visually compete.
- Mobile (390x844):
  - Section stacks cleanly, CTA button remains tappable.

## Migration risk

Lowest of all positioning batches. One new file, one JSX insertion. No deletions, no reorders beyond the single insert, no API changes.

## Open items deferred to plan

- Whether the headline's "an afternoon" claim feels too promise-y once shipped. Default: keep as-is — the migration doc walks through the conversion construct by construct and "an afternoon" is plausible for a single graph. Reassess after the section lives for a week.
- Whether to add a tiny sub-line under the headline (e.g., *"Construct by construct. Keep what you have."*). Default: no sub-line — the eyebrow + headline + CTA is already 8 words; a sub adds friction without adding signal. Decide visually if the section looks too thin.
- Whether the CTA button should include a small migration-themed icon (e.g., curved arrow indicating "bring this over"). Default: no icon — the `→` carries the directional cue.

## Research grounding

- Research §"Make Migration a Primary CTA": *"Many users already have LangGraph prototypes / LangChain agents. Primary CTA: Migrate a LangGraph app to Dawn."*
- Research §"Primary Narrative": *"I got tired of rewriting the same LangGraph.js boilerplate over and over."* — the migration CTA is the conversion path for that narrative.
- Research §"ICP — LangGraph.js builders moving from prototype → production": *"This is the highest-intent audience."* The MigrateCta section is the targeted CTA for that audience.

Specifically NOT implementing this version of the research recommendation:
- "Migration as a hero PRIMARY CTA" (research §"Make Migration a Primary CTA"). Reason: the hero's Copy prompt is the distinctive AI-coding-agent CTA and a Dawn differentiator. Replacing it with Migration would over-rotate toward existing-LangGraph users and deprioritize the from-scratch audience (still 30%+ of incoming traffic). The compact mid-page section serves the migration audience without sacrificing the hero's distinctive primary.
