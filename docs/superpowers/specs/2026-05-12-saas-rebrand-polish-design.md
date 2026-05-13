# SaaS Rebrand Polish — Design

**Date:** 2026-05-12
**Status:** Draft
**Scope:** apps/web — full visual + structural cleanup after the SaaS rebrand (PRs #117–#124). Verifies pixel-perfect parity across landing, docs, blog, and brand routes; cleans up the temporary `landing-v2` naming; aligns typography, spacing, color, and interaction patterns across the site.

## Problem

The SaaS rebrand shipped in eight rapid PRs (#117–#124) that introduced a new token system (`page`/`surface`/`ink`/`divider`/`accent-saas`), a new landing under `landing-v2/`, and re-tokened docs and blog to match. The pieces all compile and pass automated checks, but they have not been audited together. Real-world consequences:

- Components retokened independently may drift on typography weights, line-heights, and spacing.
- Legacy class names from the old dark/cream theme (`text-text-primary`, `bg-bg-primary`, `border-border-subtle`, `landing-dark`) may still appear in places PR #123 missed. Tailwind silently no-ops unknown classes, so these wouldn't fail builds.
- The folder `landing-v2/` was a staging name; with the rebrand merged it's misleading.
- The Shiki theme switched to `github-light`; the old `dawnTheme` import or theme references may linger.
- Cross-route polish — does the Hero feel like the same brand as the blog index, the docs sidebar, the brand page? — has not been verified.

Without an explicit polish pass the site reads as 8 PRs glued together, not one coherent product.

## Goals

- **Pixel-perfect parity** across landing, docs, blog, brand: typography, spacing scale, color usage, button styles, interactive states.
- **Zero legacy token references** in `apps/web/`. No `text-text-*`, `bg-bg-*`, `border-border-*`, `landing-dark`, `dawnTheme`, or `accent-amber` (the old amber token) outside intentional kept aliases.
- **`landing-v2` renamed to `landing`** with all imports updated.
- **Mobile responsive correctness** verified at 375 / 414 / 768 / 1024 / 1440 across all surfaces.
- **Cross-route consistency** — the same component patterns (buttons, eyebrows, H1/H2/H3, section padding) render identically wherever they appear.
- **A graphic-designer-level pass** — not just functional checks but the kind of detail real polish requires: line-height drift between sections, weight inconsistencies, off-by-4px spacing, etc.

## Non-goals

- Not redesigning landing-v2 sections or replacing copy.
- Not introducing new visual concepts; this is an alignment pass.
- Not adding new routes or surfaces.
- Not fixing pre-existing accessibility issues unrelated to the rebrand (separate concern).
- Not changing the SaaS token values themselves; if the palette is wrong, that's a future spec.

## Approach

Five phases, executed in order.

### Phase 1 — Static audit

A no-browser pass that greps `apps/web/` for known offenders. Produces an in-memory checklist (no commit).

**Greps:**

| Target | Pattern | Expected result |
|---|---|---|
| Legacy surface tokens | `text-text-(primary\|secondary\|muted\|dim)`, `bg-bg-(primary\|secondary\|card)` | zero hits |
| Legacy border tokens | `border-border-subtle`, `border-border\b` | zero hits |
| Legacy amber token usage | `accent-amber\b`, `accent-amber-deep` | zero hits in non-comment code (kept in `globals.css` aliases only if PR #123 retained them; verify) |
| Removed scope class | `landing-dark` | zero hits |
| Old Shiki theme | `dawnTheme`, `dawn-theme` | zero hits |
| Staging folder name | `landing-v2` | zero hits after Phase 2 rename |
| Inline hex from old palette | `#0a0806`, `#14110d`, `#f8f5ef`, `#fdfbf7` | zero hits in non-comment code |

Each hit is recorded as `file:line: offender → replacement-token`. Common replacements:
- `text-text-primary` → `text-ink`
- `text-text-secondary` → `text-ink-muted`
- `text-text-muted` → `text-ink-dim`
- `bg-bg-primary` → `bg-page`
- `bg-bg-secondary` → `bg-surface`
- `bg-bg-card` → `bg-surface-sunk`
- `border-border-subtle` → `border-divider`
- `border-border` → `border-divider-strong`
- `accent-amber-deep` → `accent-saas`
- `accent-amber` → `accent-saas` (or `accent-saas-soft` depending on usage)

### Phase 2 — `landing-v2` → `landing` rename

```bash
git mv apps/web/app/components/landing-v2 apps/web/app/components/landing
```

Then update import sites:
- `apps/web/app/page.tsx` — 12 imports
- `apps/web/app/blog/[slug]/page.tsx` — 1 import (`FinalCta`)
- Cross-imports within the folder (likely none, but verify)

One commit: `refactor(web): rename landing-v2 to landing now that the rebrand is shipped`.

### Phase 3 — Visual sweep (Chrome MCP)

A single design-review subagent drives Chrome MCP through every (route × viewport) combination and returns a structured findings report.

**Viewports:** 375, 414, 768, 1024, 1440.

**Routes:**
1. `/`
2. `/blog`
3. `/blog/why-we-built-dawn`
4. `/blog/dawn-0-4-release`
5. `/blog/tags/philosophy`
6. `/docs/getting-started`
7. `/docs/routes`
8. `/docs/recipes`
9. `/brand`

Total: 45 screens.

**Per-screen checks:**
1. Typography parity — body font, size, line-height, weight, letter-spacing within page and across pages
2. Spacing scale — section padding, gap rhythm, button padding feel like one system
3. Color usage — only SaaS tokens; no orphan dark/cream surfaces
4. Buttons + interactive — primary CTA shape, hover, focus rings consistent
5. Header + footer — chrome identical on every route
6. Content widths — reading column intentional, not drift
7. Mobile responsive — no horizontal overflow; sidebars hidden at <md; TOC at <lg; tap targets ≥ 44px
8. Hierarchy — H1/H2/H3 scale and weight reads cleanly; eyebrows consistent

**Cross-route checks (the designer's job):**
- Does the landing Hero feel like the same brand as `/blog`'s index header? Same H1 weight, same eyebrow style?
- Do the four feature blocks (`FeatureRouting/Tools/Types/DevLoop`) match each other's spacing/structure?
- Are landing-v2's 12 sections rhythmically consistent on padding?
- Does `/brand` look like part of the same site as everything else?

**Output:** single markdown report `findings.md` in `docs/superpowers/specs/2026-05-12-saas-rebrand-polish-findings.md` (committed for reference), grouped by Critical / Important / Minor. Each finding cites file:component:viewport with a 1-line proposed fix.

Time-box the agent: 30 minutes.

### Phase 4 — Fix pass

One fix subagent receives the aggregated findings (static + visual). Fixes every Critical and Important issue. Commits as one or two `fix(web): SaaS rebrand parity fixes — <category>` commits.

Minor issues land if trivial; otherwise listed in PR description as known follow-ups (not blockers for merge).

### Phase 5 — Re-verify

A small verification subagent re-walks ONLY the routes/viewports that had Critical or Important findings. Confirms each is resolved.

If regressions or unfixed items: dispatch a second fix subagent. Cap at 2 fix iterations; escalate if still failing after that.

## Components touched (no edits unless audit hits)

The audit might find issues in any of these. Most likely candidates based on the rebrand history:

- `apps/web/app/components/landing-v2/*` — 12 files; the rebrand authored them but rapid iteration likely produced drift
- `apps/web/app/components/blog/*` — re-tokened in #123, no visual verification since
- `apps/web/app/components/docs/*` — re-tokened in #123, no visual verification since
- `apps/web/app/brand/*` — possibly skipped during #123 cleanup
- `apps/web/app/components/Header.tsx`, `HeaderInner.tsx`, `Footer.tsx`, `MobileMenu.tsx`
- `apps/web/app/components/docs/DocsTOC.tsx` — already noted that `border-accent-amber` may be stale
- `apps/web/mdx-components.tsx` — MDX overrides
- `apps/web/app/globals.css` — chip + prose-dawn link rules currently reference `--color-accent-saas` (good) but verify no stale rules remain

## Done criteria

- Phase 1 audit returns zero hits on the rerun.
- `landing-v2/` no longer exists in the tree; all imports updated.
- Phase 3 visual sweep returns zero Critical or Important findings on the re-verify pass.
- `pnpm vitest run`, `pnpm -r typecheck`, `pnpm --filter @dawn-ai/web lint`, `pnpm --filter @dawn-ai/web build` all clean.
- PR opened, CI green, merged.

## Testing

Automated:
- Workspace vitest suite must remain green.
- TypeScript + Biome lint clean.
- Production build succeeds; the 45-screen matrix is statically generated where applicable.

Manual (covered by Phase 3 + Phase 5 subagents):
- All 45 screen combinations inspected.
- Cross-route patterns checked for consistency.

## Open questions

None blocking. Items to revisit only if the audit surfaces them:
- Whether the legacy `accent-amber` token should remain as an alias for `accent-saas` (depends on whether anything depends on the name; default: remove entirely).
- Whether `--color-accent-blue`, `--color-accent-green`, `--color-accent-purple` (still in `@theme`) are used anywhere; if not, drop in a follow-up.
