# Docs Chrome Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Dawn docs chrome — full-width layout with two sticky scrolling asides, OpenAI-flat sidebar (no active left border), tighter code blocks, visible amber-tint inline code.

**Architecture:** Four-file edit. The docs layout becomes a 3-column CSS grid with sticky asides; `DocsSidebar` drops its outer wrapper and gets a flatter active state; the MDX `<Pre>` tightens code typography; `globals.css` rewrites `.mdx-inline-code` to amber tint and tightens shiki line padding.

**Tech Stack:** Next.js 16, Tailwind v4 (CSS-first config), React 19, MDX.

**Spec:** `docs/superpowers/specs/2026-05-08-docs-chrome-polish-design.md`

---

## File structure

**Modified:**
- `apps/web/app/docs/layout.tsx` — full-width grid + sticky asides
- `apps/web/app/components/docs/DocsSidebar.tsx` — drop outer aside, remove left-border on active, tighten section header
- `apps/web/app/components/mdx/CodeBlock.tsx` — `<Pre>` typography pass
- `apps/web/app/globals.css` — `.mdx-inline-code` amber tint, `[data-line]` padding

That's the whole footprint.

---

## Task 1: Rewrite the docs layout

**Files:**
- Modify: `apps/web/app/docs/layout.tsx`

- [ ] **Step 1: Replace the file**

Overwrite `apps/web/app/docs/layout.tsx` with:

```tsx
import type { ReactNode } from "react"
import { DocsSidebar } from "../components/docs/DocsSidebar"
import { DocsTOC } from "../components/docs/DocsTOC"
import { DOCS_INDEX } from "../components/docs/search-index"

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)_240px] xl:grid-cols-[280px_minmax(0,1fr)_240px]">
      <aside className="hidden md:block sticky top-16 self-start h-[calc(100vh-4rem)] overflow-y-auto px-6 py-8 border-r border-border-subtle">
        <DocsSidebar searchIndex={DOCS_INDEX} />
      </aside>
      <section className="min-w-0 px-6 md:px-12 py-12 max-w-[760px] mx-auto w-full">
        {children}
      </section>
      <aside className="hidden lg:block sticky top-16 self-start h-[calc(100vh-4rem)] overflow-y-auto px-6 py-8 border-l border-border-subtle">
        <DocsTOC />
      </aside>
    </div>
  )
}
```

- [ ] **Step 2: Verify type-check**

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/app/docs/layout.tsx
git commit -m "feat(web): full-width docs layout with sticky scrolling asides"
```

---

## Task 2: Tighten DocsSidebar

**Files:**
- Modify: `apps/web/app/components/docs/DocsSidebar.tsx`

- [ ] **Step 1: Replace the file**

Overwrite `apps/web/app/components/docs/DocsSidebar.tsx` with:

```tsx
"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { DocsSearch } from "./DocsSearch"
import { DOCS_NAV } from "./nav"
import type { DocsSearchEntry } from "./search-index"

interface Props {
  readonly searchIndex: readonly DocsSearchEntry[]
}

export function DocsSidebar({ searchIndex }: Props) {
  const pathname = usePathname()

  return (
    <div>
      <p className="text-xs text-text-muted uppercase tracking-widest mb-4 inline-flex items-center gap-2">
        <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
        Documentation
      </p>
      <DocsSearch index={searchIndex} />
      <nav className="space-y-6 mt-4">
        {DOCS_NAV.map((section) => (
          <div key={section.label}>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted mb-1.5 px-3">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block text-sm px-3 py-1.5 rounded-md transition-colors ${
                        active
                          ? "text-accent-amber bg-accent-amber/8"
                          : "text-text-secondary hover:text-text-primary hover:bg-bg-card"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  )
}
```

- [ ] **Step 2: Verify type-check**

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/app/components/docs/DocsSidebar.tsx
git commit -m "feat(web): flatten DocsSidebar — drop active left-border, tighten section headers"
```

---

## Task 3: Tighten the MDX Pre code block

**Files:**
- Modify: `apps/web/app/components/mdx/CodeBlock.tsx`

- [ ] **Step 1: Edit the `<Pre>` component**

Find this line:

```tsx
        className={`overflow-x-auto px-4 py-3 text-sm leading-6 font-mono ${className ?? ""}`}
```

Replace with:

```tsx
        className={`overflow-x-auto px-3 py-2 text-[13px] leading-[1.55] font-mono ${className ?? ""}`}
```

(The line appears once, on the inner `<pre>` element rendered by the `Pre` function.)

- [ ] **Step 2: Verify type-check**

```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/app/components/mdx/CodeBlock.tsx
git commit -m "feat(web): tighten code-block typography (text-13/leading-1.55/px-3-py-2)"
```

---

## Task 4: Inline code + line container styles

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Replace the `.mdx-inline-code` rule**

Find:

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

Replace with:

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

- [ ] **Step 2: Tighten the `[data-line]` padding**

Find:

```css
[data-line] {
  display: block;
  padding: 0 1rem;
  border-left: 2px solid transparent;
}
```

Replace with:

```css
[data-line] {
  display: block;
  padding: 0 0.75rem;
  border-left: 2px solid transparent;
}
```

- [ ] **Step 3: Verify build + lint**

```
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web lint
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add apps/web/app/globals.css
git commit -m "feat(web): amber-tint inline code, tighten shiki line padding"
```

---

## Task 5: Verification

- [ ] **Step 1: Manual visual smoke at desktop**

Restart the dev server if needed. Visit `http://localhost:3000/docs/getting-started` at a 1440×900 window. Verify:

- Page spans the full viewport (no max-w-7xl gutters).
- Left sidebar is 280px wide (xl breakpoint), right TOC is 240px.
- Center content is centered with ~720px reading width.
- Active sidebar link "Getting Started" shows amber text + soft amber bg, **no vertical accent line on the left edge**.
- Section labels in the sidebar are 10px monospace uppercase muted.
- Code blocks (e.g., the `pnpm create dawn-ai-app my-agent` block on the page) are visibly tighter — no double-spaced feel.
- Inline code (e.g., `pnpm`, `dawn run`) shows amber tint chip with faint border.

- [ ] **Step 2: Scroll behavior**

Scroll the page to the bottom of `/docs/getting-started`. Verify:

- The center content scrolls.
- The left sidebar stays anchored under the header.
- The right TOC stays anchored under the header.
- Each aside has its own scrollbar if its content overflows.

- [ ] **Step 3: Responsive breakpoints**

Resize the window:

- 1024px: right TOC disappears, layout still uses left sidebar + content.
- 768px: left sidebar also disappears, content reflows full-width.

- [ ] **Step 4: Confirm other docs pages**

Visit `/docs/routes` and `/docs/cli`. Spot-check that the chrome looks right — code blocks, inline code, sidebar all consistent.

- [ ] **Step 5: Tweak commit (only if needed)**

If smoke testing surfaced a regression that needed fixing, commit it:

```
git add apps/web
git commit -m "chore(web): tune docs chrome after smoke test"
```

If nothing needed adjusting, skip.

---

## Verification checklist

After all tasks complete:

- [ ] `apps/web/app/docs/layout.tsx` is a full-width 3-col grid with sticky asides.
- [ ] `DocsSidebar` no longer wraps in its own `<aside>` and active links have no left border.
- [ ] `<Pre>` uses `text-[13px] leading-[1.55] px-3 py-2`.
- [ ] `.mdx-inline-code` is amber-tinted with a faint border and `white-space: nowrap`.
- [ ] `[data-line]` padding is `0 0.75rem`.
- [ ] `pnpm --filter @dawn-ai/web build && typecheck && lint` all PASS.
- [ ] Manual scroll smoke at 1440×900 confirms layout, sidebar, code, and inline code all match the spec.
