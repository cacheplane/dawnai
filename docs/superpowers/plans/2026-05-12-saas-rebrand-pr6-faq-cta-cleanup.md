# SaaS Rebrand PR 6 — FAQ + FinalCta + Cosmic Cleanup Plan

> superpowers:subagent-driven-development.

**Goal:** Add `FAQ` and `FinalCta` sections, then delete every cosmic landing artifact: all `landing/*` components, `PaletteScroller`, `ScrollReveal`, `lib/palette/*`, `lib/shiki/highlight.ts`, and the cosmic-only globals.css declarations. After this PR the landing is fully cream-palette, no `landing-dark` scope, no palette scroller.

**Kept (until PR 7 docs/blog re-token):** `CreamSurface.tsx`, `lib/shiki/dawn-theme.ts`, cream-theme tokens in globals.css (`--color-bg-primary`, `--color-text-primary`, etc., still consumed by docs/blog).

**Spec:** § Page IA · #12 FAQ, #13 Final CTA; § Component Inventory · Deletions.

---

## File Structure

**New:**
- `apps/web/app/components/landing-v2/Faq.tsx`
- `apps/web/app/components/landing-v2/FinalCta.tsx`

**Modified:**
- `apps/web/app/page.tsx`
- `apps/web/app/globals.css`

**Deleted:**
- `apps/web/app/components/landing/` (all 19 files)
- `apps/web/app/components/PaletteScroller.tsx`
- `apps/web/app/components/ScrollReveal.tsx`
- `apps/web/lib/palette/interpolate.ts`
- `apps/web/lib/palette/stops.ts`
- `apps/web/lib/shiki/highlight.ts`

---

## Tasks

1. **Faq** — Accordion with 9 questions drafted from the spec (production-ready, LangGraph relationship, Deep Agents roadmap, maintainer/cadence, license, hosted-LangGraph compat, LangSmith integration, cost/MIT, migration). First item `defaultOpenId`.
2. **FinalCta** — `--color-surface-sunk` band with H2 "Start building.", short supporting line, install `CopyCommand` + Star on GitHub link.
3. **page.tsx** — remove all remaining cosmic imports (ComicStrip, BigReveal, StarsSection, MigrateCta, CtaSection, PaletteScroller, ScrollReveal), remove the `<div className="landing-dark">` wrapper, render Faq + FinalCta after Quickstart.
4. **Delete cosmic files** — `rm` the files listed above in one commit.
5. **globals.css cleanup** — remove `.landing-dark` scope, `:root { --landing-* }` and prefers-reduced-motion override, `body { background: var(--landing-bg); ... }` rule, `.landing-surface`/`.landing-text`/`.landing-text-muted`/`.landing-border` utility classes.
6. **Lint + push + PR + merge on green.**

---

## Out of scope

- Docs/blog re-token + CreamSurface deletion (PR 7).
- `dawnTheme` (next.config.ts dependency) — stays.
- Cream-theme tokens (`--color-bg-primary`, etc.) — still consumed by docs/blog.
