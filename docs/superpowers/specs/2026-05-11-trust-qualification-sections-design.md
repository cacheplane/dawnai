# Trust + Qualification Sections — Design

**Date:** 2026-05-11
**Status:** Approved
**Scope:** apps/web — add two new landing sections, reorder/remove existing sections

## Problem

After PR #102 (hero positioning rewrite), the landing page anchors Dawn to LangGraph.js explicitly. But two adoption blockers remain unaddressed:

1. **Self-qualification.** A reader hits the page, reads the new headline ("Build LangGraph agents like Next.js apps."), feels the pain in ProblemSection, but doesn't know *if they're the target audience*. Without a "this is for you if…" signal, marginal readers bounce.
2. **Lock-in fear.** The whole positioning pitches Dawn as a meta-framework, not a runtime — but the page never says that anywhere visible. A skeptical reader assumes Dawn replaces LangGraph or LangSmith and bounces before the CTA.

Additionally, the current top-of-page block (LogoWall with 5 framework logos) is a thin signal that gets dwarfed by the new hero and competes with EcosystemSection further down (which shows the same logos plus providers, plus adapters). Two blocks doing similar work, neither doing it fully.

## Goals

- Surface **self-qualification** right where it lands hardest: after the pain in ProblemSection.
- Surface **anti-replacement trust** right before the CTA, where the reader's defenses are highest.
- Consolidate the "what stack does Dawn work with" signal into one block, placed where it answers the hero's implicit question.
- Cut LogoWall (5-logo strip) since EcosystemSection (12+ providers + adapter cards) is the larger, richer version.

## Non-goals

- Migration-as-primary-CTA — that's batch C (separate brainstorm).
- Comparison pages (`/compare/dawn-vs-*`) — separate work.
- Character/dialog landing section — a separate, later brainstorm.
- Touching any other existing section's content or visual treatment beyond reordering.
- Any new MDX components or shared chrome.

## Approach

### Section reorder

**Before:**
```
HeroSection → LogoWall → ProblemSection → ComparisonTable → BigReveal → SolutionSection
  → ArchitectureSection → EcosystemSection → CodeExample → DeploySection
  → FeatureGrid → HowItWorks → StarsSection → CtaSection
```

**After:**
```
HeroSection → EcosystemSection → ProblemSection → WhoItsFor → ComparisonTable → BigReveal
  → SolutionSection → ArchitectureSection → CodeExample → DeploySection
  → FeatureGrid → HowItWorks → StarsSection → NotAReplacement → CtaSection
```

Concretely:
- **Remove** `LogoWall` (position 2). Delete the import and JSX.
- **Move** `EcosystemSection` from position 8 → position 2 (replaces LogoWall's slot).
- **Add** `WhoItsFor` as a new section at position 4 (right after `ProblemSection`).
- **Add** `NotAReplacement` as a new section at position ~13 (right before `CtaSection`).

The component file `LogoWall.tsx` can be deleted (no other consumers). Audit via `grep` before deleting; if anything else imports it, leave the file and just drop the call.

### New section: `WhoItsFor.tsx`

File: `apps/web/app/components/landing/WhoItsFor.tsx`. Server component.

Visual treatment: 3-card horizontal grid (responsive: 1 col mobile, 3 col `md:` and up). Each card matches the existing landing card aesthetic — `landing-surface` background, subtle border, padding around content. No icons; the title + one-liner is enough.

Content (verbatim — these are the locked card strings):

```ts
const PERSONAS = [
  {
    title: "Next.js SaaS team",
    line: "You already build with Next.js. Dawn uses the same conventions.",
  },
  {
    title: "Scaling LangGraph across teams",
    line: "You're already on LangGraph and LangSmith. The next ten agents shouldn't each be a snowflake.",
  },
  {
    title: "AI consultancy or agency",
    line: "You build the same agent for ten clients. Build it once.",
  },
] as const
```

Section chrome:
- Eyebrow: `WHO IT'S FOR` (caps, amber dot, matches other sections)
- Headline: `Dawn is for you if…` — `font-display`, matches other section headlines
- No sub-line; the cards carry it
- 3-card grid below

The "Scaling LangGraph across teams" card is the highest-leverage of the three — it threads through the fragmentation pain in ProblemSection ("snowflake" callback). Card order on desktop: Next.js → Scaling → Consultancy. On mobile they stack in the same order.

### New section: `NotAReplacement.tsx`

File: `apps/web/app/components/landing/NotAReplacement.tsx`. Server component.

Visual treatment: single column, centered, `max-w-2xl`. No cards. Three text lines stacked vertically with subtle separators (`border-t landing-border` between items — same pattern as the pain one-liners in the new ProblemSection). Calm, quiet — this is a trust signal, not a sell.

Content (verbatim):

Eyebrow: `NOT A REPLACEMENT`
Headline: `Dawn doesn't replace your stack.`
No sub-line.
Three lines (each bolded noun is a real product Dawn integrates with):

1. Dawn doesn't replace **LangGraph**. The runtime stays where it is.
2. Dawn doesn't replace **LangSmith**. Deploy as you already do.
3. Dawn doesn't replace **your model providers**. OpenAI, Anthropic, Google — all the same.

The bolded nouns use `text-text-primary font-medium` while the rest of the line is `landing-text-muted` — same pattern as the hero's "Keep the runtime. Drop the boilerplate." kicker.

### Voice rules (carry from prior batches)

- Short, declarative sentences
- No hedge words
- Direct address ("you", "your")
- No marketing superlatives
- No rebuttal in `NotAReplacement` — the section's job is one signal only

## Architecture

```
apps/web/app/components/landing/
├── EcosystemSection.tsx    # moved (no edits)
├── LogoWall.tsx            # DELETE
├── WhoItsFor.tsx           # NEW
└── NotAReplacement.tsx     # NEW

apps/web/app/page.tsx       # reorder imports + JSX
```

### `page.tsx` JSX shape

```tsx
import { ArchitectureSection } from "./components/landing/ArchitectureSection"
import { BigReveal } from "./components/landing/BigReveal"
import { CodeExample } from "./components/landing/CodeExample"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { CtaSection } from "./components/landing/CtaSection"
import { DeploySection } from "./components/landing/DeploySection"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HeroSection } from "./components/landing/HeroSection"
import { HowItWorks } from "./components/landing/HowItWorks"
// LogoWall import REMOVED
import { NotAReplacement } from "./components/landing/NotAReplacement"
import { ProblemSection } from "./components/landing/ProblemSection"
import { SolutionSection } from "./components/landing/SolutionSection"
import { StarsSection } from "./components/landing/StarsSection"
import { WhoItsFor } from "./components/landing/WhoItsFor"
import { PaletteScroller } from "./components/PaletteScroller"
import { ScrollReveal } from "./components/ScrollReveal"

export default async function HomePage() {
  return (
    <div className="relative isolate">
      <PaletteScroller />
      <HeroSection />
      <EcosystemSection />
      <ProblemSection />
      <ScrollReveal>
        <WhoItsFor />
      </ScrollReveal>
      <ScrollReveal>
        <ComparisonTable />
      </ScrollReveal>
      <ScrollReveal>
        <BigReveal />
      </ScrollReveal>
      <ScrollReveal>
        <SolutionSection />
      </ScrollReveal>
      <ScrollReveal>
        <ArchitectureSection />
      </ScrollReveal>
      <ScrollReveal>
        <CodeExample />
      </ScrollReveal>
      <ScrollReveal>
        <DeploySection />
      </ScrollReveal>
      <ScrollReveal>
        <FeatureGrid />
      </ScrollReveal>
      <ScrollReveal>
        <HowItWorks />
      </ScrollReveal>
      <ScrollReveal>
        <StarsSection />
      </ScrollReveal>
      <ScrollReveal>
        <NotAReplacement />
      </ScrollReveal>
      <ScrollReveal>
        <CtaSection />
      </ScrollReveal>
    </div>
  )
}
```

Note: `EcosystemSection` is currently `async` (or might be) — preserve whatever signature it has. `HeroSection` is async (added in batch A) — keep `HomePage` async.

## Testing

- `pnpm --filter @dawn-ai/web build`, `typecheck`, `lint` all pass.
- Manual smoke at `/` desktop (1440x900):
  - LogoWall is gone; EcosystemSection sits directly under the hero.
  - After ProblemSection's closer ("Dawn is the convention that makes it stop.") the reader scrolls into WhoItsFor.
  - Three persona cards render with the locked copy.
  - Below all middle sections, just before CtaSection, the NotAReplacement section reads as three calm anti-claims.
  - Bolded nouns (LangGraph, LangSmith, model providers) pop visually against the muted body.
- Mobile (390x844):
  - EcosystemSection adapts (its existing responsive treatment carries).
  - WhoItsFor cards stack to 1 column.
  - NotAReplacement three lines stack with separators intact.

## Migration risk

Low. Adds two new files, deletes one, reorders JSX in one file. No URL changes, no API changes, no MDX content changes. EcosystemSection content is unchanged — only its position moves.

## Open items deferred to plan

- Whether the persona cards in WhoItsFor should have a small icon or visual cue. Default: no icons; the title carries the persona signal. Decide visually if a card-row of pure text reads too flat.
- Whether NotAReplacement should sit right before `CtaSection` (current proposal) or right before `StarsSection` (one section higher, just after HowItWorks). Default: directly before CtaSection — the trust signal hits last, the reader exhales, then converts. If during chrome validation it visually crowds the CTA, move it one slot up.
- Whether to surface a fourth NotAReplacement bullet (e.g., "Dawn doesn't replace your tracing — keep LangSmith / Phoenix / your custom setup"). Default: three lines (rule of three). Decide visually if it reads sparse.

## Research grounding

- **Self-qualification** — research §"Add 'Who Dawn Is For'": *"This helps self-qualification immediately."*
- **Anti-replacement trust** — research §"Add a 'Dawn Is Not…' Trust Section": *"This reduces lock-in concerns."*
- **Persona selection** — research §"ICP — Specific Audiences": the three personas map directly to the top three audiences identified (Next.js SaaS teams, LangGraph builders going to production, AI consultancies). The Scaling reframe (card #2) was clarified during this brainstorm — the actual highest-leverage persona is the enterprise scaling motion, not single-dev-going-to-prod.
