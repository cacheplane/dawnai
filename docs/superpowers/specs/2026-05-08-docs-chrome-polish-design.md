# Docs Chrome Polish — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — docs layout, sidebar, code-block density, inline-code styling

## Problem

The Dawn docs ship the right structure (left sidebar · content · right TOC) but the chrome is too constrained and the typography feels cramped/loose in the wrong places.

Specific complaints from the user-facing review:

1. **Constrained width.** The docs layout is `max-w-7xl mx-auto` (1280px). On 1440px+ displays the page sits in a narrow center column with empty gutters. The reading column is right but the chrome should reach the viewport edges.
2. **Side columns scroll with the page.** Both sidebars currently scroll alongside content. Long sections require the reader to scroll the nav off-screen and lose orientation.
3. **Active nav item has a left border.** The active link uses `border-l border-accent-amber -ml-px pl-[11px]` — a vertical accent line that competes with the content area's visual rhythm.
4. **Code blocks feel double-spaced.** The MDX `<Pre>` uses `text-sm leading-6 px-4 py-3`. With 14px text and 24px line-height the ratio is 1.71 — too much vertical space; the code reads like prose rather than source.
5. **Inline `<code>` is invisible.** `.mdx-inline-code` uses `bg-bg-card/60` with `text-text-secondary`. On the docs background the contrast collapses; readers can't tell inline code from regular prose.

## Goals

- **Full-width layout.** Docs span the viewport. Three-column grid: responsive sidebar · content (max ~720px reading width) · TOC. Each aside is sticky and scrolls independently on the y-axis.
- **OpenAI-flat sidebar.** No vertical accent line on the active item. Active state: amber text + soft amber bg. Section headers: 10px mono uppercase, muted. Hover: subtle white wash.
- **Tighter code blocks.** Drop the line-height ratio to ~1.55 and pull the padding inward. Code reads like real source, not prose.
- **Visible inline code.** Adopt the amber-tint treatment: subtle amber bg, amber text, faint amber border. Inline code becomes a recognizable token in flowing prose.

## Non-goals

- No content changes in this pass — the doc bodies stay byte-identical. Content brainstorm comes next as a separate spec.
- No new pages, no nav restructuring beyond removing the left-border treatment.
- No mobile-specific drawer / hamburger pattern. The docs already render usable narrow layouts; mobile polish can come in a later pass when triggered by feedback.
- Not touching `DocsSearch` (Cmd-K), `DocsBreadcrumb`, `DocsPrevNext`, `DocsPage`. Those work fine.
- Not changing the docs-area header, footer, or any landing-page chrome.

## Approach

### Layout (`apps/web/app/docs/layout.tsx`)

The current layout:

```tsx
<div className="max-w-7xl mx-auto px-8 py-12 flex gap-12">
  <DocsSidebar searchIndex={DOCS_INDEX} />
  <section className="flex-1 min-w-0 max-w-3xl">{children}</section>
  <DocsTOC />
</div>
```

becomes a three-column grid that fills the viewport, with sticky asides that scroll on their own y-axis:

```tsx
<div className="grid grid-cols-[240px_minmax(0,1fr)_240px] xl:grid-cols-[280px_minmax(0,1fr)_240px]">
  <aside className="sticky top-16 self-start h-[calc(100vh-4rem)] overflow-y-auto px-6 py-8 border-r border-border-subtle">
    <DocsSidebar searchIndex={DOCS_INDEX} />
  </aside>
  <section className="min-w-0 px-12 py-12 max-w-[760px] mx-auto w-full">
    {children}
  </section>
  <aside className="sticky top-16 self-start h-[calc(100vh-4rem)] overflow-y-auto px-6 py-8 border-l border-border-subtle">
    <DocsTOC />
  </aside>
</div>
```

Key choices:

- The grid uses `minmax(0, 1fr)` for the center column so it shrinks correctly when long code blocks otherwise force horizontal overflow.
- Both asides use `position: sticky; top: 4rem; height: calc(100vh - 4rem); overflow-y: auto` so they pin under the page header and scroll their own contents independently of the body.
- The center column wraps its children with `max-w-[760px] mx-auto w-full` so reading length stays comfortable even on a very wide viewport.
- Header height is `4rem` (64px) — confirmed by inspecting the existing `Header.tsx` styles.
- Below `lg` (1024px), the right TOC hides. Below `md` (768px), the left sidebar also hides. The center column reflows full-width. (No new mobile drawer in this pass — content remains accessible via the existing breadcrumb.)

### Sidebar (`apps/web/app/components/docs/DocsSidebar.tsx`)

Three concrete edits:

1. **Strip the outer `<aside className="w-56 shrink-0">` wrapper** — the layout owns sizing now. The component returns its inner content (search + nav).
2. **Remove the left-border treatment on the active link.** The active link currently uses:
   ```
   text-accent-amber bg-accent-amber/5 border-l border-accent-amber -ml-px pl-[11px]
   ```
   becomes:
   ```
   text-accent-amber bg-accent-amber/8
   ```
   The negative margin and left padding compensation go away too. Item layout stays `block text-sm px-3 py-1.5 rounded-md`.
3. **Section header style.** Currently `text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-2 px-3` — keep, but tighten to `text-[10px] tracking-[0.12em] text-text-muted font-mono mb-1.5` so it visually demotes (it's a label, not a heading).

The `<DocsSearch>` block above the nav stays as-is.

### Code blocks (`apps/web/app/components/mdx/CodeBlock.tsx`)

The `<Pre>` component currently:

```tsx
<pre className="overflow-x-auto px-4 py-3 text-sm leading-6 font-mono ...">
```

becomes:

```tsx
<pre className="overflow-x-auto px-3 py-2 text-[13px] leading-[1.55] font-mono ...">
```

The header strip styling is unchanged. The border + bg-bg-card chrome is unchanged. Only the typography of the code body tightens.

The `[data-line]` rule in `globals.css` also tightens its padding from `0 1rem` to `0 0.75rem` to keep the inner code aligned with the new px-3 outer padding.

### Inline code (`apps/web/app/globals.css`)

The current `.mdx-inline-code` rule:

```css
.mdx-inline-code {
  background: rgb(from var(--color-bg-card) r g b / 0.6);
  color: var(--color-text-secondary);
  border-radius: 4px;
  padding: 0.125rem 0.375rem;
  font-size: 0.875em;
  font-family: var(--font-mono, ui-monospace, monospace);
}
```

becomes the amber-tint treatment:

```css
.mdx-inline-code {
  background: rgb(245 158 11 / 0.10);
  color: #f5b840;
  border: 1px solid rgb(245 158 11 / 0.20);
  border-radius: 4px;
  padding: 0.0625rem 0.375rem;
  font-size: 0.875em;
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: nowrap;
}
```

Notes:
- Uses raw RGB values for the amber accent (`#f59e0b` = `245 158 11`) so the rule doesn't fight the engine's interpolating CSS variables (it shouldn't — docs aren't on the landing arc — but the explicit value documents intent).
- `white-space: nowrap` keeps inline tokens like `getCwd()` from wrapping mid-symbol.
- Padding is tighter than the original (`0.0625rem` instead of `0.125rem`) so the chip fits on a single text line cleanly with the new 1px border included.

### Header height alignment

The sticky asides use `top: 4rem` and `height: calc(100vh - 4rem)`. The existing `Header.tsx` is `h-16` (64px = 4rem). If the header height ever changes, both values move together — easy to grep, but worth noting.

### Visual smoke checklist

After the change:

- Visit `/docs/getting-started` at 1440×900. The page spans the viewport. The sidebar sits at 280px (xl breakpoint). The center column is centered within its column at ~720px reading width. The right TOC pins to the right edge.
- Scroll the page. The center column scrolls; the sidebar and TOC stay anchored. Each aside has its own scrollbar if it overflows.
- The active sidebar link "Getting Started" has amber text + soft amber bg. No vertical accent line.
- Section headers in the sidebar read as 10px uppercase mono in muted color.
- Code blocks are visibly tighter — line-height feels like real source, not prose.
- Inline code (`<code>` chips like `getCwd()`) reads as amber-on-amber-tint with a faint border.
- At 1024px the right TOC disappears. At 768px the left sidebar also disappears; center reflows full-width.

## Architecture

```
apps/web/
├── app/
│   ├── docs/
│   │   └── layout.tsx              # full-width grid, sticky asides
│   ├── components/docs/
│   │   └── DocsSidebar.tsx         # drop outer aside wrapper, remove left-border, tighten section header
│   ├── components/mdx/
│   │   └── CodeBlock.tsx           # tighten Pre's text/leading/padding
│   └── globals.css                 # rewrite .mdx-inline-code, tighten [data-line] padding
```

Four files. ~30 lines of net change.

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes.
- **Visual smoke (manual):**
  - Render `/docs/getting-started`, `/docs/routes`, and `/docs/cli` at 1440×900. Confirm the layout, sidebar style, code block density, inline code visibility match the mockup.
  - Scroll each page to the bottom — sidebar and TOC stay sticky.
  - Resize to 1024px — right TOC hides, layout still works.
  - Resize to 768px — left sidebar also hides, content reflows full-width.

## Migration risk

Low. The four files are tightly scoped; no shared types or imports change. The most likely visual surprise is on docs pages with very long code blocks — they may now overflow horizontally where they previously ate the right margin. The new `min-w-0` on the center column + `overflow-x-auto` on `<pre>` already handle this.

The header height assumption (`4rem`) is documented in the spec; if the header height changes in the future, the sticky asides need to update accordingly.

## Open items deferred to plan

- Whether to add a thin scrollbar style to the sticky asides (keeps the chrome quiet on macOS overlay scrollbars but adds CSS noise on Windows/Firefox). Default: don't style. Reconsider if the scrollbar feels intrusive.
- Whether to add a "Skip to content" accessibility link for keyboard users navigating past the sidebar. Out of scope for this polish pass; track separately.
