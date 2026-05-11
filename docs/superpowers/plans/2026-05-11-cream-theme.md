# Cream Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip `apps/web`'s default theme tokens from dark to cream so every non-landing route adopts a warm light surface, while leaving the landing page's scroll-driven palette engine intact.

**Architecture:** A single `<CreamSurface>` client wrapper in the root layout uses `usePathname()` to apply `bg-bg-primary text-text-primary` to every route except `/`. Theme tokens in `globals.css` are inverted: surface tokens become cream values, text tokens become warm-dark navy, accent tokens are unchanged. The dark Shiki theme stays on `pre` blocks (high-contrast anchor); a new `.mdx-inline-code` chip targets cream backgrounds. A Chrome-MCP-driven responsive validation pass runs across a 5-viewport × 9-route matrix in parallel subagents to catch regressions.

**Tech Stack:** Next.js 16 App Router, Tailwind v4 (`@theme` tokens), Shiki dawn-theme (unchanged), Chrome MCP for visual verification.

**Spec:** [`docs/superpowers/specs/2026-05-11-cream-theme-design.md`](../specs/2026-05-11-cream-theme-design.md)

---

## Codebase Notes (read before starting)

- `apps/web/app/globals.css` lines 1–32: `@theme { --color-* ... }` block holds the dark tokens we're flipping. Lines 42–52: `.mdx-inline-code` chip. Lines 84–88: `pre [data-highlighted-line]` opacity. Line 100+: landing `--landing-*` vars (not touched by this work).
- `apps/web/app/layout.tsx` lines 83–89: body structure (`<body><div min-h-screen flex flex-col><Header /><main flex-1>{children}</main><Footer /></div></body>`). The `<html className="dark ...">` on line 81 is a Tailwind dark-mode class — Tailwind v4 in this repo doesn't use `dark:` variants, so the attribute is currently inert. Leave it alone in this work (separate cleanup if anyone wants).
- `<article className="prose-dawn">` wraps MDX bodies in `apps/web/app/components/docs/DocsPage.tsx:28` and `apps/web/app/blog/[slug]/page.tsx`. `prose-dawn` has no existing CSS — we'll add rules under that selector for link treatment.
- Landing-section components (`HeroSection`, `LogoWall`, `ProblemSection`, `BigReveal`, `StarsSection`, `CtaSection`, etc.) read from `--landing-*` vars driven by `PaletteScroller`, not `--color-*` tokens. They are unaffected by the token flip — verify, don't edit.
- `FeaturedPostCard.tsx` hardcodes the warm amber gradient — leave it.
- The repo's Chrome MCP server is available via `mcp__Claude_in_Chrome__*` tools. Implementer subagents use these for visual verification; the controller dispatches verification subagents in parallel.

---

## File Structure

**Create:**

- `apps/web/app/components/CreamSurface.tsx` — client wrapper that paints cream on non-landing routes

**Modify:**

- `apps/web/app/globals.css` — token flip + chip + prose-dawn + highlight opacity
- `apps/web/app/layout.tsx` — wrap `{children}` with `<CreamSurface>`
- `apps/web/app/components/docs/DocsSidebar.tsx` — active item: amber pill on cream
- `apps/web/mdx-components.tsx` — blockquote border + table header bg targeting cream

**Audit (no edits unless hit):**

- Grep `apps/web/app` for hardcoded dark hexes (`#0a0806`, `#14110d`, `#19150f`, `#241f19`, `#f8f5ef`) that bypass tokens. Replace each with the token reference unless it's intentionally landing-only.

---

## Task 1 — `<CreamSurface>` wrapper + root layout integration

**Files:**
- Create: `apps/web/app/components/CreamSurface.tsx`
- Modify: `apps/web/app/layout.tsx` lines 83–89

- [ ] **Step 1: Create `CreamSurface.tsx`**

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

- [ ] **Step 2: Update root layout to wrap `{children}` with `<CreamSurface>`**

In `apps/web/app/layout.tsx`, add the import:

```tsx
import { CreamSurface } from "./components/CreamSurface"
```

Then replace the `<main>` line so the body block reads:

```tsx
<body>
  <div className="min-h-screen flex flex-col">
    <Header />
    <main className="flex-1">
      <CreamSurface>{children}</CreamSurface>
    </main>
    <Footer />
  </div>
</body>
```

The wrapper is **inside** `<main>` so Header and Footer keep their own backgrounds.

- [ ] **Step 3: Type check**

Run: `pnpm --filter @dawn-ai/web typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/CreamSurface.tsx apps/web/app/layout.tsx
git commit -m "feat(web): add CreamSurface wrapper for non-landing routes"
```

At this point the wrapper exists but the tokens are still dark, so visually nothing changes yet — that's Task 2.

---

## Task 2 — Flip theme tokens in `globals.css`

**Files:**
- Modify: `apps/web/app/globals.css` lines 4–22

- [ ] **Step 1: Replace surface and text tokens in the `@theme` block**

In `apps/web/app/globals.css`, replace lines 4–22 (the seven `--color-bg-*`, three `--color-text-*`, plus `--color-border` and `--color-border-subtle` tokens, leaving the two `--color-dawn-*` and `--color-neutral-*` and accent tokens unchanged).

Replace this block:

```css
  --color-dawn-black: #000000;
  --color-dawn-white: #ffffff;
  --color-dawn-neutral-gray: #6b6b6b;
  --color-bg-primary: #0a0806;
  --color-bg-secondary: #0f0c09;
  --color-bg-card: #14110d;
  --color-border: #241f19;
  --color-border-subtle: #19150f;
  --color-text-primary: #f8f5ef;
  --color-text-secondary: #8a857b;
  --color-text-muted: #5a554c;
  --color-text-dim: #3f3b35;
  --color-accent-green: #00a67e;
  --color-accent-blue: #3178c6;
  --color-accent-purple: #646cff;
  --color-accent-amber: #f59e0b;
  --color-accent-amber-deep: #d97706;
```

With this:

```css
  --color-dawn-black: #000000;
  --color-dawn-white: #ffffff;
  --color-dawn-neutral-gray: #6b6b6b;
  --color-bg-primary: #fdfbf7;
  --color-bg-secondary: #fcfaf3;
  --color-bg-card: #fbf8ee;
  --color-border: rgba(26, 21, 48, 0.12);
  --color-border-subtle: rgba(26, 21, 48, 0.08);
  --color-text-primary: #1a1530;
  --color-text-secondary: #6d5638;
  --color-text-muted: #8a7657;
  --color-text-dim: #b2a285;
  --color-accent-green: #00a67e;
  --color-accent-blue: #3178c6;
  --color-accent-purple: #646cff;
  --color-accent-amber: #f59e0b;
  --color-accent-amber-deep: #d97706;
```

- [ ] **Step 2: Type check**

Run: `pnpm --filter @dawn-ai/web typecheck`
Expected: passes (CSS changes don't affect TS).

- [ ] **Step 3: Quick visual smoke**

Start the dev server (or rely on the one already running). Open `/docs/getting-started` in any browser — you should see cream content with the dark code blocks already in place (they're driven by Shiki, not tokens). It will look 80% right; the chip and the active-sidebar pill come in later tasks.

Open `/` — the landing should still render its full scroll arc cosmic-dark → daylight. If the landing top has flipped to cream, stop and investigate: `<CreamSurface>` should be returning the empty-className branch on `/`. Use `mcp__Claude_in_Chrome__navigate` if you want to verify programmatically, but a glance is enough.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): flip theme tokens from dark to cream"
```

---

## Task 3 — Inline code chip on cream

**Files:**
- Modify: `apps/web/app/globals.css` lines 42–52

- [ ] **Step 1: Replace the `.mdx-inline-code` rule**

Replace lines 42–52 (the existing chip):

```css
/* Inline code (rendered by InlineCode MDX override) */
.mdx-inline-code {
  background: rgb(245 158 11 / 0.1);
  color: #f5b840;
  border: 1px solid rgb(245 158 11 / 0.2);
  border-radius: 4px;
  padding: 0.0625rem 0.375rem;
  font-size: 0.875em;
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: nowrap;
}
```

With:

```css
/* Inline code (rendered by InlineCode MDX override) */
.mdx-inline-code {
  background: rgba(217, 119, 6, 0.10);
  color: #b45309;
  border: 1px solid rgba(217, 119, 6, 0.25);
  border-radius: 4px;
  padding: 0.0625rem 0.375rem;
  font-size: 0.875em;
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: nowrap;
}
```

The block-code reset rule on lines 57+ (`pre .mdx-inline-code { ... }`) is unchanged.

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): tune inline code chip for cream background"
```

---

## Task 4 — `prose-dawn` link rule + highlight opacity bump

**Files:**
- Modify: `apps/web/app/globals.css` lines 84–88 plus a new rule appended near the inline-code section

- [ ] **Step 1: Bump highlighted-line opacity**

Find lines 84–88:

```css
/* Highlighted lines (e.g. ```ts {1,3-5} ```) */
pre [data-highlighted-line] {
  background: rgb(from var(--color-accent-amber) r g b / 0.06);
  border-left-color: var(--color-accent-amber);
}
```

Change `0.06` to `0.10`:

```css
/* Highlighted lines (e.g. ```ts {1,3-5} ```) */
pre [data-highlighted-line] {
  background: rgb(from var(--color-accent-amber) r g b / 0.10);
  border-left-color: var(--color-accent-amber);
}
```

- [ ] **Step 2: Add a `.prose-dawn a` rule**

Append after the existing inline-code block-reset rule (around line 66, but exact placement is flexible — anywhere not inside an existing media-query/@layer is fine). Add:

```css
/* Prose link affordance — sharp amber underline on cream */
.prose-dawn a {
  color: var(--color-text-primary);
  text-decoration: underline;
  text-decoration-color: var(--color-accent-amber-deep);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  transition: text-decoration-thickness 120ms ease;
}
.prose-dawn a:hover {
  text-decoration-thickness: 2px;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): cream-tuned link underline and code highlight opacity"
```

---

## Task 5 — `DocsSidebar` active item: amber pill

**Files:**
- Modify: `apps/web/app/components/docs/DocsSidebar.tsx`

- [ ] **Step 1: Read the file**

```bash
cat apps/web/app/components/docs/DocsSidebar.tsx
```

Find the active-link styling (currently something like `text-accent-amber` for active items, possibly with a soft amber bg).

- [ ] **Step 2: Update the active-link className**

The active state should be a soft amber pill: `bg-accent-amber/15 text-accent-amber-deep` with the same horizontal padding as the inactive state. Inactive stays at `text-text-secondary hover:text-text-primary`.

If the existing active className is like `text-accent-amber bg-accent-amber/10` or similar, change to:

```tsx
// active
"px-3 py-1.5 rounded-md text-sm font-medium bg-accent-amber/15 text-accent-amber-deep"

// inactive
"px-3 py-1.5 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors"
```

The exact existing classNames may differ — preserve layout/padding/typography from what's there; only swap the active state's text color to `text-accent-amber-deep` and its background to `bg-accent-amber/15`. If the file uses a string-builder pattern (clsx, twMerge, or a custom helper), follow the same pattern.

- [ ] **Step 3: Type check + visual smoke via Chrome MCP**

```bash
pnpm --filter @dawn-ai/web typecheck
```

If you have Chrome MCP access (`mcp__Claude_in_Chrome__navigate`), navigate to `http://localhost:3000/docs/getting-started`, take a screenshot, confirm the active sidebar item shows the amber-deep pill. Otherwise, a manual browser check is fine.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/docs/DocsSidebar.tsx
git commit -m "feat(web): amber pill active state for DocsSidebar"
```

---

## Task 6 — `mdx-components.tsx`: blockquote + table header on cream

**Files:**
- Modify: `apps/web/mdx-components.tsx`

- [ ] **Step 1: Find and update the blockquote and table-header overrides**

Read `apps/web/mdx-components.tsx`. Find the `blockquote` override (if present) and the `thead`/`th` overrides.

For `blockquote`, ensure the left border uses `border-accent-amber-deep` (not a generic muted color). Example target:

```tsx
blockquote: ({ children }) => (
  <blockquote className="border-l-4 border-accent-amber-deep bg-bg-secondary px-5 py-3 my-6 text-text-secondary italic">
    {children}
  </blockquote>
),
```

If a blockquote override does **not** exist, add one with the above content.

For the table header, ensure the `<thead>` or `<th>` background uses `bg-bg-secondary` (one tick warmer than `bg-bg-primary` so headers stand out on the cream page). Example target:

```tsx
th: ({ children }) => (
  <th className="text-left font-semibold px-4 py-2 bg-bg-secondary text-text-primary border-b border-border-subtle">
    {children}
  </th>
),
```

If `th` already exists with different styling, only change the background to `bg-bg-secondary` and leave other classes. If it uses a class like `bg-bg-card` already, that's even closer to the new amber surface and acceptable — verify visually.

- [ ] **Step 2: Type check**

```bash
pnpm --filter @dawn-ai/web typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/mdx-components.tsx
git commit -m "feat(web): MDX blockquote + table header tuning for cream"
```

---

## Task 7 — Hardcoded-hex audit

**Files:**
- Modify: any files identified by the audit (TBD by what the grep finds)

- [ ] **Step 1: Run the audit**

From the repo root:

```bash
grep -rnE "#0a0806|#0f0c09|#14110d|#19150f|#241f19|#f8f5ef|#8a857b|#5a554c|#3f3b35" \
  apps/web/app apps/web/mdx-components.tsx 2>/dev/null
```

These are the seven dark-token hexes we just removed. Anything that still references them by literal hex is bypassing the token system.

- [ ] **Step 2: Triage each hit**

For each line returned:

- **If it's inside a landing-section component** (`apps/web/app/components/landing/*` or `apps/web/app/page.tsx`): leave it. Landing intentionally uses its own palette.
- **If it's anywhere else** (docs, blog, MDX, Header non-landing branch, etc.): replace the hex with the appropriate Tailwind utility or CSS variable reference. Examples:
  - `style={{ background: "#0a0806" }}` → `className="bg-bg-primary"` (or `style={{ background: "var(--color-bg-primary)" }}` if className isn't possible).
  - `color: "#f8f5ef"` → `color: "var(--color-text-primary)"`.

- [ ] **Step 3: Run audit again to confirm zero non-landing hits**

```bash
grep -rnE "#0a0806|#0f0c09|#14110d|#19150f|#241f19|#f8f5ef|#8a857b|#5a554c|#3f3b35" \
  apps/web/app apps/web/mdx-components.tsx 2>/dev/null \
  | grep -v "components/landing" | grep -v "app/page.tsx"
```

Expected: empty output.

- [ ] **Step 4: Typecheck + lint**

```bash
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

Both must pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "fix(web): replace remaining hardcoded dark hexes with tokens"
```

If the audit found zero non-landing hits, skip Step 5 and report "no hits" — the audit itself is the deliverable.

---

## Task 8 — Desktop smoke verification (Chrome MCP)

This task verifies the four primary surfaces at desktop width via Chrome MCP before kicking off the parallel responsive pass.

**Pre-req:** dev server running at `http://localhost:3000`. If it isn't, start it with `pnpm --filter @dawn-ai/web dev &` first.

- [ ] **Step 1: Open Chrome to each route at 1440×900, screenshot each**

Use `mcp__Claude_in_Chrome__navigate` and `mcp__Claude_in_Chrome__resize_window` (1440×900). For each of these routes, navigate then screenshot:

- `http://localhost:3000/`
- `http://localhost:3000/docs/getting-started`
- `http://localhost:3000/blog`
- `http://localhost:3000/blog/why-we-built-dawn`

If `mcp__Claude_in_Chrome__*` tools aren't loaded as deferred tools, fetch them first with ToolSearch: `{ query: "claude-in-chrome", max_results: 30 }`.

- [ ] **Step 2: Confirm visually**

Inspect each screenshot:

| Route | Pass condition |
|---|---|
| `/` | Cosmic-dark hero, scroll arc unchanged. No cream above the fold. |
| `/docs/getting-started` | Cream body, dark `pre`, amber inline-chip, amber-deep underlined links, amber-pill active sidebar item. Dark footer below. |
| `/blog` | Cream surface, featured card amber gradient intact, release card legible. Dark footer. |
| `/blog/why-we-built-dawn` | Cream surface, TOC visible on the right, amber link underlines, CtaSection still amber, footer dark. |

Note any issues. If any are present, fix them before continuing (small touch-ups commit message: `fix(web): desktop smoke pass — <component>`). If everything looks right, proceed.

- [ ] **Step 3: Commit if any touch-up changes were needed**

```bash
git add apps/web
git commit -m "fix(web): desktop smoke pass touch-ups"
```

If no touch-ups, no commit.

---

## Task 9 — Parallel responsive validation (3 subagents)

This is the bulk of the visual work. Dispatch **three subagents in parallel**, each owning 3 routes across 5 viewports. Each subagent uses Chrome MCP to navigate, resize, and screenshot.

**Important — this task is dispatched by the controller, not executed by an implementer subagent directly.** The implementer doing Tasks 1–8 hands off here; the controller dispatches three reviewer subagents.

**Subagent A — Landing + Top-level routes**
- Routes: `/`, `/brand`, `/prompts/scaffold`
- Viewports: 375, 414, 768, 1024, 1440

**Subagent B — Docs**
- Routes: `/docs/getting-started`, `/docs/routes`, `/docs/recipes` (or `/docs/recipes/typed-state`)
- Viewports: 375, 414, 768, 1024, 1440

**Subagent C — Blog**
- Routes: `/blog`, `/blog/why-we-built-dawn`, `/blog/tags/philosophy`
- Viewports: 375, 414, 768, 1024, 1440

**Per (route × viewport), each subagent checks:**

1. No horizontal scroll on `<html>` (verify via `mcp__Claude_in_Chrome__javascript_tool` running `document.documentElement.scrollWidth === document.documentElement.clientWidth`).
2. Header readable; mobile menu intact on <md viewports.
3. Reading column fits viewport; sidebar collapsed on <md; TOC hidden on <lg.
4. Code blocks scroll horizontally without widening the page.
5. CTA section legible; primary button ≥ 44px tap target on mobile.
6. Footer dark, readable, link spacing reasonable.
7. Inline code chips legible at all sizes.
8. No orphan dark backgrounds inside cream surfaces.

**Each subagent returns:**

A structured Markdown report with one section per route. Within each section, one bullet per (viewport, issue, severity, suggested fix). Severities: Critical, Important, Minor.

```markdown
## /docs/getting-started
- (375px) Critical — sidebar overlaps content, no toggle visible. Fix: ensure md:hidden on <DocsSidebar>.
- (1024px) Minor — TOC line spacing tight.
```

- [ ] **Step 1: Dispatch the three subagents in parallel**

Single message with three `Agent` tool calls (so they run concurrently). Each subagent prompt includes:

- The viewport list and route list for that subagent.
- The 8 checks above.
- Instructions to use `mcp__Claude_in_Chrome__*` exclusively. If those tools aren't in scope, fetch them via ToolSearch first.
- The structured report format.
- Dev server URL.

- [ ] **Step 2: Aggregate findings**

Once all three subagents return, the controller compiles a single findings list, deduplicated and grouped by severity.

- [ ] **Step 3: Snapshot the findings**

Write the aggregated findings to `docs/superpowers/specs/2026-05-11-cream-theme-responsive-findings.md` (no commit yet — gets folded into the PR description or scratch).

---

## Task 10 — Fix pass (one implementer, targeted)

Dispatch a single implementer subagent with:

- The aggregated findings list from Task 9.
- Instructions to fix every Critical and Important finding inline, one commit per fix or one combined commit (engineer's choice — prefer one combined commit titled `fix(web): cream theme responsive fixes`).
- Minor findings stay on the list and aren't blockers.

- [ ] **Step 1: Dispatch the fix subagent**

The subagent gets the findings + instructions to:
- Fix all Critical and Important issues
- After fixing, re-verify via Chrome MCP at the smallest affected viewport for each fix
- Run `pnpm --filter @dawn-ai/web typecheck` and `lint` after edits
- Commit

- [ ] **Step 2: Re-verify with a smaller subagent dispatch**

Dispatch one verification subagent that walks just the routes/viewports that were Critical/Important in Task 9. Confirm fixes hold.

- [ ] **Step 3: If new issues surfaced, loop**

If the re-verification turns up regressions, dispatch a second fix subagent. Cap the loop at two iterations — if issues remain after that, escalate.

---

## Task 11 — Final verification & PR

- [ ] **Step 1: Full automated suite**

```bash
pnpm vitest run
pnpm -r typecheck
pnpm --filter @dawn-ai/web lint
pnpm --filter @dawn-ai/web build
```

All four must pass. Note that the workspace contains two pre-existing test failures (`packages/vite-plugin/test/plugin.test.ts`, `scripts/release-publish.test.mjs`) unrelated to this work — they fail on `main` too. Confirm those are the *only* failures.

- [ ] **Step 2: Push branch**

```bash
git push -u origin claude/condescending-moore-7988a2
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat(web): cream theme — flip token defaults, scope landing dark" --body "$(cat <<'EOF'
## Summary

Flips theme tokens from dark to cream so docs, blog, and other non-landing routes adopt the warm light palette established at the bottom of the landing page. Landing's scroll-driven palette engine is untouched.

- **Spec:** docs/superpowers/specs/2026-05-11-cream-theme-design.md
- **Plan:** docs/superpowers/plans/2026-05-11-cream-theme.md

### Changes
- `globals.css` `@theme` tokens flipped: surface tokens cream, text tokens warm-dark navy, accents unchanged
- New `<CreamSurface>` wrapper in root layout paints non-landing routes
- DocsSidebar active item: amber-deep pill on cream
- MDX blockquote border + table header tuned
- `.mdx-inline-code` chip retargeted for cream
- `prose-dawn a` rule: amber-deep underline with hover thickening
- Hardcoded-hex audit: replaced with token references
- Responsive validation pass: 9 routes × 5 viewports via Chrome MCP

### Known follow-ups (minor)
[Paste minor findings from Task 9 here]

## Test plan

- [ ] Visit / — landing cosmic-to-daylight scroll arc unchanged
- [ ] /docs/getting-started — cream body, dark pre, amber chip + underlines + sidebar pill
- [ ] /blog — Magazine layout on cream, dark footer
- [ ] /blog/<slug> — TOC populated, CTA still amber, footer dark
- [ ] Mobile sweep at 375px — no horizontal overflow on any tested route
- [ ] pnpm vitest run, typecheck, lint, build all green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI, merge on green**

```bash
gh pr checks <PR-NUMBER> --watch
# when green:
gh pr merge <PR-NUMBER> --squash --delete-branch --admin
```

---

## Done criteria

- `globals.css` tokens flipped; `<CreamSurface>` in place.
- Landing renders cosmic-to-daylight as before (verified).
- Docs and blog reading surfaces are cream with amber accents.
- Inline code chips use the amber-on-cream treatment.
- Active sidebar item is an amber-deep pill.
- Footer is dark on every route.
- Zero Critical or Important responsive issues across the 9 × 5 matrix.
- All automated checks pass.
- PR merged.
