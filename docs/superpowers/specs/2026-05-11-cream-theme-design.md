# Cream Theme — Design

**Date:** 2026-05-11
**Status:** Draft
**Scope:** apps/web — flip the global theme tokens from dark to cream so docs, blog, and other non-landing routes adopt the warm light palette established at the bottom of the landing page. Landing's scroll-driven palette engine is preserved untouched.

## Problem

The marketing site has two visual contexts:

1. **Landing (`/`)** — runs a scroll-driven palette engine (`PaletteScroller`, `lib/palette/stops.ts`) that animates from cosmic dark at the top to a warm daylight cream at the bottom (`StarsSection`, `CtaSection`).
2. **Docs (`/docs/*`) and blog (`/blog/*`)** — currently render against the *top* (dark) palette: `bg-bg-primary: #0a0806`, `text-text-primary: #f8f5ef`, etc.

The dark theme on docs and blog is at odds with the warm finale of the landing arc and undersells the brand at exactly the point a reader has committed to going deeper. We want the reading surfaces (docs, blog, and every non-landing route) to feel like the *end* of the landing journey, not the *beginning*.

## Goals

- A single cream palette across all non-landing routes: barely-warm background, dark navy text, amber accents.
- The amber accent treatment used in `StarsSection` (bold counter numerals, primary CTA, hover states) becomes the default high-emphasis hit point on cream — applied to active sidebar items, link underlines, tag chips, and similar focused elements.
- Landing page is **untouched** visually — its scroll-driven palette engine continues to take the user from cosmic to daylight as before.
- One place to maintain the routing rule that distinguishes "landing surface" from "cream surface".
- A documented mobile/responsive validation pass driven by the Chrome MCP extension to catch regressions across viewport widths.

## Non-goals

- Not rebuilding the landing's `PaletteScroller` engine.
- Not introducing a user-toggled light/dark mode.
- Not changing the Shiki code-block theme — `pre` blocks stay dark on cream as a deliberate high-contrast anchor.
- Not changing the brand color (`accent-amber: #f59e0b`, `accent-amber-deep: #d97706`); accents stay as they are, just used on cream instead of dark.
- Not touching the FeaturedPostCard's hardcoded warm-gradient — it already targets the cream world correctly.
- Not changing CtaSection (already cream + amber).
- Not changing the Footer's surface — it stays dark on every route (deliberate anchor below the cream content; matches "B — always-dark footer" decision).

## Approach

### Token flip in `apps/web/app/globals.css`

Replace the dark `@theme` token values for the surface and text tokens. Accent tokens are unchanged.

```css
--color-bg-primary:     #fdfbf7;   /* barely-warm cream — page background */
--color-bg-secondary:   #fcfaf3;   /* inset panels, table header */
--color-bg-card:        #fbf8ee;   /* cards, modals — slightly more amber */
--color-border:         rgba(26,21,48,0.12);
--color-border-subtle:  rgba(26,21,48,0.08);
--color-text-primary:   #1a1530;   /* matches CtaSection title */
--color-text-secondary: #6d5638;   /* warm-muted, matches CtaSection lede */
--color-text-muted:     #8a7657;   /* eyebrow tone */
--color-text-dim:       #b2a285;
/* accents unchanged: --color-accent-amber, --color-accent-amber-deep, blue, green, purple */
```

The `body { background: var(--landing-bg); color: var(--landing-fg); }` rule stays. `--landing-bg` is still owned by the scroll engine and defaults to cosmic dark, so the *body* still defaults to cosmic. What flips is everything that resolves through the new `--color-*` tokens via Tailwind utilities.

### Cream surface mechanism — `<CreamSurface>` in root layout

A small client component lives in `apps/web/app/components/CreamSurface.tsx`:

```tsx
"use client"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

export function CreamSurface({ children }: { readonly children: ReactNode }) {
  const isLanding = usePathname() === "/"
  return (
    <div className={isLanding ? "" : "bg-bg-primary text-text-primary min-h-screen"}>
      {children}
    </div>
  )
}
```

In `apps/web/app/layout.tsx`:

```tsx
<body>
  <Header />
  <CreamSurface>{children}</CreamSurface>
  <Footer />
</body>
```

This is the *single* rule that distinguishes the landing surface from the cream surface. The Header and Footer sit outside `<CreamSurface>` so each chooses its own background; this matches existing behavior where the Header already has an `isLanding` switch, and lets the Footer keep its dark `var(--landing-bg)` surface as decided.

`usePathname()` is resolved during server rendering in the App Router, so the correct branch (cream vs. empty) is in the initial HTML and there is no FOUC. Hydration just re-applies the same class.

### Component touch list

Most components inherit the new tokens for free. Explicit work:

**Docs**

| File | Change |
|---|---|
| `app/components/docs/DocsSidebar.tsx` | Active link: `bg-accent-amber/15 text-accent-amber-deep` pill (was amber text on dark) |
| `app/components/docs/DocsTOC.tsx` | Active line stays amber-bordered — should read correctly on cream; verify visually |
| `app/components/docs/DocsSearch.tsx` | Modal panel: confirm `bg-bg-card` (now cream) + `shadow-xl` separates against backdrop; bump shadow if needed |
| `app/components/docs/DocsBreadcrumb.tsx`, `DocsPrevNext.tsx`, `PageActions.tsx`, `RelatedCards.tsx` | Use tokens — verify after flip, expect no manual changes |
| `mdx-components.tsx` | `<a>`: amber-deep underline `text-decoration-color`, `text-underline-offset: 3px`. `<blockquote>`: `border-l-accent-amber-deep`. `<table>` header: `bg-bg-secondary`. |

**Blog**

| File | Change |
|---|---|
| `app/components/blog/FeaturedPostCard.tsx` | No change — hardcoded amber gradient already targets cream context |
| `app/components/blog/PostCard.tsx`, `PostHeader.tsx`, `PostMeta.tsx`, `TagChips.tsx` | Use tokens; visual verification only |
| `app/components/blog/post-index.test.ts`, `rss-feed.test.ts` | No change |

**Global CSS (`apps/web/app/globals.css`)**

- `.mdx-inline-code` — update to: `background: rgba(217,119,6,0.10); color: #b45309; border: 1px solid rgba(217,119,6,0.25);` (the chip treatment from the C3 mockup).
- `pre [data-highlighted-line]` — bump background opacity from `0.06` to `0.10` to maintain contrast against the dark pre on a cream page (subtle but worth verifying).
- Add a `.prose-dawn a` rule with amber-deep underline + offset for sharp link affordance on cream prose.

**Landing**

- `Header` — its non-landing branch already uses `border-b border-border-subtle`, which inherits the new cream-toned subtle border. No edit expected.
- All landing section components (`HeroSection`, `LogoWall`, `ProblemSection`, `BigReveal`, `StarsSection`, `CtaSection`, etc.) use the `--landing-*` palette vars driven by `PaletteScroller`, not the `--color-*` tokens. **Unaffected by this change.**

**Out of scope (verified, no edits)**

- Shiki dark theme `apps/web/lib/shiki/dawn-theme.ts` — kept; `pre` stays dark on cream.
- `/brand` — uses landing palette vars; visually verify, no token edits.

### Hardcoded-hex audit

Grep `apps/web/app` for inline `style={{ background: "#0..." }}` / `style={{ color: "#f..." }}` and any literal dark hexes (`#0a0806`, `#14110d`, etc.) that bypass tokens. Each must either move to a token reference or be a deliberate landing-only hardcode. The implementation plan owns the grep + fix.

## Responsive validation pass

After the token flip and component touch-list edits land, run a full mobile/responsive validation pass driven by the Chrome MCP extension. Subagents execute this in parallel groups; the controller aggregates findings.

**Viewport matrix:**

| Width | Notes |
|---|---|
| 375px | iPhone mini / small mobile |
| 414px | iPhone Pro Max / typical mobile |
| 768px | iPad portrait, tablet break |
| 1024px | iPad landscape, small laptop |
| 1440px | typical desktop |

**Routes to check:**

- `/`
- `/docs/getting-started`
- `/docs/routes`
- `/blog`
- `/blog/why-we-built-dawn`
- `/blog/dawn-0-4-release`
- `/blog/tags/philosophy`
- `/prompts/scaffold`
- `/brand`

**Per (route × viewport) checks:**

- No horizontal overflow on `<html>`.
- Header chrome readable, mobile menu intact on `<md`.
- Reading column doesn't exceed viewport; sidebar collapsed on `<md`; TOC hidden on `<lg`.
- Code blocks scroll horizontally — never widen the page.
- CTA section legible; primary button tap-target ≥ 44×44px.
- Footer dark, readable, link spacing reasonable.
- No orphan dark backgrounds inside cream surfaces.
- Inline code chips legible at all sizes.

**Parallelization:** dispatch ~3 subagents, each owning 3 routes × 5 viewports (15 screens each), with explicit instructions to use the Chrome MCP extension (`mcp__Claude_in_Chrome__*` tools) to navigate, resize, and screenshot.

**Findings format:** each subagent returns a structured report listing issues by route + viewport + severity (Critical / Important / Minor) with a 1-line description and screenshot reference.

**Fix pass:** after findings aggregate, one fix subagent applies changes targeted at the issues. Re-verify with a second Chrome MCP pass on the affected routes.

**Done when:** zero Critical or Important issues remain across the matrix. Minor issues are listed in the PR description as follow-ups, not blockers.

## Testing & verification (automated)

- `pnpm vitest run` — full workspace tests pass.
- `pnpm -r typecheck` — clean.
- `pnpm --filter @dawn-ai/web lint` — clean (no new warnings).
- `pnpm --filter @dawn-ai/web build` — production build succeeds without Tailwind v4 warnings about the redefined tokens.

## Done criteria

- `globals.css` tokens are flipped to the cream palette.
- `<CreamSurface>` wrapper paints every non-landing route in cream.
- Landing (`/`) renders cosmic-to-daylight scroll-engine exactly as before.
- Docs and blog reading surfaces render cream with amber accents.
- Dark `pre` code blocks stay legible; inline chip uses the amber-on-cream treatment.
- Footer remains dark across all routes.
- Responsive validation: zero Critical/Important issues across the route × viewport matrix.
- All automated checks pass.

## Open questions (resolved post-merge if at all)

- Whether to extract the cream `pre` background into a token (`--color-pre-bg`) for future light-Shiki experiments. Defer until a real need.
- Whether to provide a docs/blog "table of authors" or similar surface that benefits from a softer-than-cream panel (e.g., `bg-bg-secondary`). Wait for a content request.
