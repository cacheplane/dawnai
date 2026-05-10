# Mobile Menu — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — full-screen mobile menu overlay triggered from the site header

## Problem

The docs sidebar is currently hidden below the `md` breakpoint (768px) by the layout in `apps/web/app/docs/layout.tsx`. Mobile readers can land on a docs page but cannot navigate to other pages without the desktop sidebar visible. The site header on mobile only shows logo + Docs / GitHub / Read the Docs links, which is enough for the landing page but not for the docs.

## Goals

- Add a hamburger button to the site header, visible only below the `md` breakpoint.
- Tapping the button opens a full-screen overlay menu (Option A from the brainstorm) covering the entire viewport.
- The overlay shows two sections stacked vertically:
  - **Site** — top-level nav (Docs link, GitHub link). Always shown.
  - **Docs** — the full docs sidebar nav (Start / Core concepts / Workflow / Reference). Only shown when the user is on a docs page.
- Close affordances: × button in the overlay header; Escape key; tap on a nav link auto-closes.
- Body scroll is locked while the overlay is open.
- Reasonable a11y: focus moves into the overlay on open, returns to the trigger on close.

## Non-goals

- No swipe-down dismissal (no touch gesture handling). The × and Esc are enough.
- No focus trap library — we use a minimal "focus first link on open, return to trigger on close" pattern.
- No animation beyond a simple fade-in (no slide gestures, no spring physics).
- Not changing desktop header behavior.
- Not splitting Site/Docs into tabs (Option B). User picked A — one stack.

## Approach

### Trigger button

Add a hamburger button to `Header.tsx`, visible only on mobile via `md:hidden`. The existing nav links (`Docs`, `GitHub`, `Read the Docs`) stay rendered but hide on the same breakpoint via `hidden md:flex`. So mobile sees logo + hamburger; desktop sees logo + nav.

The button is a plain `<button type="button">` with an aria-label and three horizontal lines drawn as `<span>` blocks. State (open/closed) lives in a small client component `MobileMenu.tsx` that wraps both the trigger and the overlay.

### Overlay

A new client component `apps/web/app/components/MobileMenu.tsx`. Renders:

- A `<button>` (the trigger) — passed the open state.
- A portal-style fixed-position overlay (`fixed inset-0 z-50`) that's `display: none` when closed.
- The overlay has a darkened backdrop (`bg-bg-primary/95 backdrop-blur-sm`) and content laid out top-to-bottom: header strip with × button, then the nav stack.

The overlay is *not* a React portal — it's just a sibling fixed element, which is enough for our z-index needs. The header is `z-30`; the overlay is `z-50`.

### Nav content

The component receives optional `docsNav` content (the rendered `DocsSidebar`) as a prop. When present, the overlay shows:

```
[ × Close ]
─────────────
SITE
  Docs
  GitHub ↗
  Read the Docs

DOCUMENTATION
  Search
  ── START
    Getting Started (active)
  ── CORE CONCEPTS
    Routes / Tools / State / Middleware / Retry
  ── WORKFLOW
    Testing / Dev Server / Deployment
  ── REFERENCE
    CLI
```

When the user is not on a docs page, `docsNav` is null and the overlay shows just the Site section.

The trigger is rendered globally in the site `Header`. The docs layout passes the rendered `<DocsSidebar>` element to the menu via a prop (or the menu reads it from a context). For simplicity and to avoid prop drilling, the docs layout renders an additional `<MobileMenu>` instance that includes the `<DocsSidebar>`; the site header's `<MobileMenu>` instance only includes site nav. Both are full-viewport overlays — the second one (docs) just renders inside the docs layout subtree, which is fine because the overlay is `fixed inset-0`.

This keeps the implementation simple: there are effectively two overlay components mounted on docs pages, but only one trigger button visible (the docs layout's mobile menu reuses the header's hamburger via DOM portal won't work without React portal). Refined approach: a single `<MobileMenu>` component lives in `Header.tsx`, and it accepts a `docsContent?: ReactNode` prop. The docs layout imports the component and renders the docs version of it; the landing pages render the simple version.

The simplest approach is actually: render `<MobileMenu>` in the site header always, and the docs layout uses a portal/context to inject the docs sidebar HTML when applicable. Implementation detail to settle in plan; spec defaults to the simplest: render MobileMenu only in `Header.tsx` and have it call `usePathname()` + import the docs nav config directly.

### Open/close behavior

- `useState(false)` for `isOpen`.
- `onClick` on the hamburger toggles open.
- `onClick` on the × button or any link inside sets to closed.
- `useEffect`: when `isOpen` changes:
  - If true: `document.body.style.overflow = "hidden"`; focus the close button via ref.
  - If false: restore `document.body.style.overflow = ""`; return focus to the hamburger via ref.
- `useEffect` for `keydown` Esc → close.
- `useEffect` for `pathname` changes → close (handles `<Link>` navigation auto-closing).

### Styling

- Overlay backdrop: `bg-bg-primary/95 backdrop-blur-sm`. Matches the cosmic dark of the header.
- Section labels (`SITE`, `DOCUMENTATION`): 10px uppercase mono muted (matches the desktop sidebar treatment from the recent chrome polish).
- Links: `text-text-secondary hover:text-text-primary`. Active link: `text-accent-amber bg-accent-amber/8`.
- Close button: top-right of overlay header strip, 44px tap target with × icon.

### Animation

- `transition: opacity 200ms ease-out`. Open → fade in. Closed → fade out then `display: none` after the transition.
- No slide. The user picked A explicitly — full-screen fade.

### Responsive behavior

- The hamburger button appears only at `md:hidden`. The full nav (Docs / GitHub / Read the Docs) appears only at `hidden md:flex`. So:
  - Below 768px: logo + hamburger
  - 768px+: logo + nav links

The overlay itself is `fixed inset-0` so it always covers the full viewport when open. If a user resizes from mobile to desktop while the menu is open, the overlay covers the desktop view too — which is fine; closing it via Esc or × works at any size. (We could also auto-close on resize past `md`, but that's polish for later.)

### Accessibility

- Hamburger has `aria-label="Open menu"` (or "Close menu" when open) and `aria-expanded={isOpen}` and `aria-controls="mobile-menu"`.
- Overlay has `role="dialog" aria-modal="true" aria-label="Site menu"` and `id="mobile-menu"`.
- Close button has `aria-label="Close menu"`.
- Focus moves into the overlay on open (target: the close button). On close, focus returns to the hamburger.
- Esc closes. Tab cycling works because the overlay is a normal sibling DOM node (no focus trap library — the user can tab out of the overlay back to the body, which is a graceful degradation).

## Architecture

```
apps/web/app/components/
├── Header.tsx          # adds <MobileMenu /> + hides desktop nav below md
├── MobileMenu.tsx      # NEW — trigger + overlay
└── DocsMobileNav.tsx   # NEW — docs section content (uses DOCS_NAV directly)
```

`MobileMenu.tsx` decides whether to render the docs section by calling `usePathname()` and checking for the `/docs` prefix. When matched, it imports `DOCS_NAV` from `components/docs/nav.ts` and renders the section directly (no need to drill `<DocsSidebar>` into the menu — both share the same `DOCS_NAV` const).

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes.
- **Manual smoke at 390px:**
  - Header shows logo + hamburger; no Docs / GitHub / Read the Docs links visible.
  - Tap hamburger → full-screen overlay fades in.
  - Overlay shows Site section + (on docs pages) Documentation section.
  - Tap a link → navigates and overlay closes.
  - Tap × → overlay closes.
  - Esc → overlay closes.
  - Body doesn't scroll behind the overlay.
- **Manual smoke at 1440px:**
  - No hamburger visible.
  - Header shows logo + Docs / GitHub / Read the Docs as before.
- **Keyboard smoke:** Tab into the hamburger from the page, Enter to open, Tab through links, Esc to close, focus returns to hamburger.

## Migration risk

Low. The header gains one new child (the mobile menu) and one CSS class change (`hidden md:flex` on the desktop nav). The new `MobileMenu` component is self-contained.

The biggest risk is body-scroll-lock cleanup: if a user navigates while the menu is open and the cleanup `useEffect` doesn't fire correctly, the body could remain scroll-locked. Mitigation: the cleanup runs on `isOpen` flipping to false (which is what the pathname-change handler does), so the lock is always released cleanly.

## Open items deferred to plan

- Whether to use a React portal (`createPortal`) for the overlay. Default: no — `fixed inset-0` works without it because the parent stacking context (the page wrapper) doesn't constrain the fixed child.
- Whether to add a "page X of Y" or "navigate to next/previous" hint inside the menu. Out of scope for this pass.
