# SaaS Rebrand PR 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the visual foundation for the SaaS-style rebrand — new color + type tokens, reusable primitives (Button, Eyebrow, Card, CodeFrame, ScreenshotFrame, Accordion, StarBadge, ProviderMark), refreshed Header and Footer, and a rewritten `/brand` page that documents the new system. The home page still renders the existing cosmic landing; visible change is limited to chrome and the brand page.

**Architecture:** Add new tokens to `app/globals.css` alongside the existing cream/cosmic system using collision-free names (`--color-page`, `--color-divider`, etc.). New primitives live under `apps/web/app/components/ui/`. Header drops the `landing-dark` scope and adopts the new system; Footer is rebuilt three-column. `/brand` page is rewritten to demo the new tokens, type scale, and primitives. CI stays green throughout.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (`@theme` directive), Biome (lint), tsc (typecheck). No new test infrastructure — verification is typecheck + build + manual visual walk on dev server.

**Spec:** [docs/superpowers/specs/2026-05-12-saas-rebrand-design.md](../specs/2026-05-12-saas-rebrand-design.md)

**Token naming note:** The spec proposed `--color-bg`, `--color-border`, etc. To avoid collisions with the existing cream theme (which uses `--color-bg-primary`, `--color-border`), this PR uses `--color-page`, `--color-divider`, etc. Renaming to the spec names is deferred to PR 6 when the cosmic system is removed.

---

## File Structure

**New files:**
- `apps/web/app/components/ui/Button.tsx` — primary/secondary button primitive
- `apps/web/app/components/ui/Eyebrow.tsx` — uppercase tracked label
- `apps/web/app/components/ui/Card.tsx` — bordered surface primitive
- `apps/web/app/components/ui/CodeFrame.tsx` — browser-chrome frame around content (used for shiki output)
- `apps/web/app/components/ui/ScreenshotFrame.tsx` — image variant of CodeFrame
- `apps/web/app/components/ui/Accordion.tsx` — keyboard-accessible disclosure list
- `apps/web/app/components/ui/StarBadge.tsx` — GitHub star count badge (server component, build-time fetch)
- `apps/web/app/components/ui/ProviderMark.tsx` — inline word+mark for ecosystem rows
- `apps/web/lib/github-stars.ts` — build-time GitHub star count fetcher

**Modified files:**
- `apps/web/app/globals.css` — add new color tokens, font-size tokens; keep cream/cosmic tokens intact
- `apps/web/app/components/Header.tsx` — passthrough, but updated repoUrl handling unchanged
- `apps/web/app/components/HeaderInner.tsx` — drop `landing-dark` className, switch to new tokens, install-chip variant of nav action
- `apps/web/app/components/Footer.tsx` — three-column SaaS-style rebuild on new tokens
- `apps/web/app/brand/page.tsx` — rewrite as v2 system documentation
- `apps/web/app/layout.tsx` — remove `className="dark"` on `<html>`

**Untouched in this PR (delete or update in later PRs):**
- `apps/web/app/page.tsx` and all `app/components/landing/*` — old cosmic landing still ships
- `app/components/PaletteScroller.tsx`, `app/components/CreamSurface.tsx`, `app/components/ScrollReveal.tsx` — kept; deleted in PR 6
- `apps/web/app/globals.css` cosmic-only declarations (`landing-dark` scope, `--landing-*` vars, body landing background) — kept; cleaned in PR 6
- `apps/web/app/docs/**`, `apps/web/app/blog/**` — re-tokened in PR 7

---

## Verification Commands

Run from the **repo root**:

- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Lint: `pnpm lint`
- Dev server (for visual review): `pnpm --filter @dawn-ai/web dev` then open `http://localhost:3000` and `http://localhost:3000/brand`

CI runs all of the above (per repo CI memory: build-before-typecheck ordering).

---

## Task 1: Add new color and type tokens to globals.css

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Read current globals.css**

Run: open the file in your editor. Locate the existing `@theme { ... }` block at the top.

- [ ] **Step 2: Add new tokens inside the existing `@theme` block**

Insert the following declarations *after* the existing `--color-accent-amber-deep` line and *before* the `--font-sans` line so the cosmic/cream tokens stay untouched:

```css
  /* SaaS rebrand tokens (PR 1) — additive, do not modify existing cosmic/cream tokens.
     Renamed to spec names in PR 6 cleanup. */
  --color-page: #ffffff;
  --color-surface: #fafaf7;
  --color-surface-sunk: #f4f2ec;
  --color-ink: #14110d;
  --color-ink-muted: #5a554c;
  --color-ink-dim: #8a857b;
  --color-divider: #e6e3da;
  --color-divider-strong: #cfcabd;
  --color-accent-saas: #d97706;
  --color-accent-saas-ink: #ffffff;
  --color-accent-saas-soft: #fef3c7;
```

Display-type tokens (`text-display-xl`, `text-display-l`) are deferred to PR 2 when the Hero actually consumes them — the brand page uses arbitrary `text-[72px]` for the showcase.

- [ ] **Step 3: Verify typecheck and build**

Run from repo root:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass without new errors. The build will compile globals.css with the new tokens; existing pages keep rendering because no consumer references the new tokens yet.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): add SaaS rebrand color and display-type tokens"
```

---

## Task 2: Button primitive

**Files:**
- Create: `apps/web/app/components/ui/Button.tsx`

- [ ] **Step 1: Create the directory**

Run: `mkdir -p apps/web/app/components/ui`

- [ ] **Step 2: Write `Button.tsx`**

Path: `apps/web/app/components/ui/Button.tsx`

```tsx
import Link from "next/link"
import type { ComponentPropsWithoutRef, ReactNode } from "react"

type ButtonVariant = "primary" | "secondary"

interface BaseProps {
  readonly variant?: ButtonVariant
  readonly children: ReactNode
}

type ButtonAsLink = BaseProps & {
  readonly href: string
  readonly external?: boolean
} & Omit<ComponentPropsWithoutRef<"a">, "href" | "children">

type ButtonAsButton = BaseProps & {
  readonly href?: undefined
} & Omit<ComponentPropsWithoutRef<"button">, "children">

export type ButtonProps = ButtonAsLink | ButtonAsButton

const baseClasses =
  "inline-flex items-center gap-1.5 font-medium text-sm rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-page focus-visible:ring-divider-strong"

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "px-4 py-2 bg-accent-saas text-accent-saas-ink hover:opacity-90 active:opacity-80",
  secondary:
    "px-4 py-2 text-ink hover:text-accent-saas border border-divider hover:border-divider-strong bg-page",
}

export function Button(props: ButtonProps) {
  const variant = props.variant ?? "primary"
  const className = `${baseClasses} ${variantClasses[variant]}`

  if (props.href !== undefined) {
    const { href, external, children, variant: _v, ...rest } = props
    if (external) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
          {...rest}
        >
          {children}
        </a>
      )
    }
    return (
      <Link href={href} className={className} {...rest}>
        {children}
      </Link>
    )
  }

  const { children, variant: _v, ...rest } = props
  return (
    <button type="button" className={className} {...rest}>
      {children}
    </button>
  )
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass. (Build is not strictly required here since nothing imports the primitive yet, but typecheck catches API mistakes.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/ui/Button.tsx
git commit -m "feat(web): add Button primitive for SaaS rebrand"
```

---

## Task 3: Eyebrow primitive

**Files:**
- Create: `apps/web/app/components/ui/Eyebrow.tsx`

- [ ] **Step 1: Write `Eyebrow.tsx`**

Path: `apps/web/app/components/ui/Eyebrow.tsx`

```tsx
import type { ReactNode } from "react"

interface EyebrowProps {
  readonly children: ReactNode
  readonly tone?: "default" | "accent"
}

export function Eyebrow({ children, tone = "default" }: EyebrowProps) {
  const colorClass = tone === "accent" ? "text-accent-saas" : "text-ink-dim"
  return (
    <p
      className={`text-xs font-semibold uppercase tracking-[0.06em] ${colorClass}`}
    >
      {children}
    </p>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/ui/Eyebrow.tsx
git commit -m "feat(web): add Eyebrow primitive"
```

---

## Task 4: Card primitive

**Files:**
- Create: `apps/web/app/components/ui/Card.tsx`

- [ ] **Step 1: Write `Card.tsx`**

Path: `apps/web/app/components/ui/Card.tsx`

```tsx
import type { ReactNode } from "react"

interface CardProps {
  readonly children: ReactNode
  readonly tone?: "surface" | "page" | "sunk"
  readonly className?: string
}

const toneClasses: Record<NonNullable<CardProps["tone"]>, string> = {
  page: "bg-page",
  surface: "bg-surface",
  sunk: "bg-surface-sunk",
}

export function Card({ children, tone = "surface", className = "" }: CardProps) {
  return (
    <div
      className={`rounded-xl border border-divider ${toneClasses[tone]} ${className}`}
      style={{
        boxShadow:
          "0 1px 2px rgba(20,17,13,0.04), 0 8px 24px -8px rgba(20,17,13,0.08)",
      }}
    >
      {children}
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/ui/Card.tsx
git commit -m "feat(web): add Card primitive"
```

---

## Task 5: CodeFrame primitive

**Files:**
- Create: `apps/web/app/components/ui/CodeFrame.tsx`

- [ ] **Step 1: Write `CodeFrame.tsx`**

Path: `apps/web/app/components/ui/CodeFrame.tsx`

```tsx
import type { ReactNode } from "react"

interface CodeFrameProps {
  readonly children: ReactNode
  readonly label?: string
  readonly className?: string
}

/**
 * Browser-chrome frame for code or product visuals.
 * Renders a top bar with traffic-light dots and an optional filename label,
 * then the children below in a sunk surface.
 */
export function CodeFrame({ children, label, className = "" }: CodeFrameProps) {
  return (
    <div
      className={`rounded-xl border border-divider bg-page overflow-hidden ${className}`}
      style={{
        boxShadow:
          "0 1px 2px rgba(20,17,13,0.04), 0 8px 24px -8px rgba(20,17,13,0.08)",
      }}
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider bg-surface-sunk">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
        {label !== undefined ? (
          <span className="ml-3 text-xs text-ink-muted font-mono truncate">{label}</span>
        ) : null}
      </div>
      <div>{children}</div>
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/ui/CodeFrame.tsx
git commit -m "feat(web): add CodeFrame primitive"
```

---

## Task 6: ScreenshotFrame primitive

**Files:**
- Create: `apps/web/app/components/ui/ScreenshotFrame.tsx`

- [ ] **Step 1: Write `ScreenshotFrame.tsx`**

Path: `apps/web/app/components/ui/ScreenshotFrame.tsx`

```tsx
import Image from "next/image"

interface ScreenshotFrameProps {
  readonly src: string
  readonly alt: string
  readonly width: number
  readonly height: number
  readonly caption?: string
  readonly label?: string
  readonly className?: string
}

/**
 * Image variant of CodeFrame — browser-chrome top bar plus a next/image inside.
 * Used for tooling screenshots (VS Code, terminal, file tree, etc.).
 */
export function ScreenshotFrame({
  src,
  alt,
  width,
  height,
  caption,
  label,
  className = "",
}: ScreenshotFrameProps) {
  return (
    <figure className={className}>
      <div
        className="rounded-xl border border-divider bg-page overflow-hidden"
        style={{
          boxShadow:
            "0 1px 2px rgba(20,17,13,0.04), 0 8px 24px -8px rgba(20,17,13,0.08)",
        }}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider bg-surface-sunk">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
          {label !== undefined ? (
            <span className="ml-3 text-xs text-ink-muted font-mono truncate">{label}</span>
          ) : null}
        </div>
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="block w-full h-auto"
        />
      </div>
      {caption !== undefined ? (
        <figcaption className="mt-2 text-xs text-ink-muted text-center">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/ui/ScreenshotFrame.tsx
git commit -m "feat(web): add ScreenshotFrame primitive"
```

---

## Task 7: Accordion primitive

**Files:**
- Create: `apps/web/app/components/ui/Accordion.tsx`

- [ ] **Step 1: Write `Accordion.tsx`**

Path: `apps/web/app/components/ui/Accordion.tsx`

```tsx
"use client"

import { useState, type ReactNode } from "react"

interface AccordionItem {
  readonly id: string
  readonly question: string
  readonly answer: ReactNode
}

interface AccordionProps {
  readonly items: readonly AccordionItem[]
  readonly defaultOpenId?: string
}

export function Accordion({ items, defaultOpenId }: AccordionProps) {
  const [openId, setOpenId] = useState<string | null>(defaultOpenId ?? null)

  return (
    <ul className="divide-y divide-divider border-y border-divider">
      {items.map((item) => {
        const isOpen = openId === item.id
        const panelId = `accordion-panel-${item.id}`
        const buttonId = `accordion-button-${item.id}`
        return (
          <li key={item.id}>
            <h3>
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenId(isOpen ? null : item.id)}
                className="w-full flex items-center justify-between gap-4 py-5 text-left text-ink font-medium hover:text-accent-saas transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-divider-strong rounded"
              >
                <span>{item.question}</span>
                <span
                  aria-hidden="true"
                  className="text-ink-dim text-xl leading-none select-none"
                >
                  {isOpen ? "−" : "+"}
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              hidden={!isOpen}
              className="pb-5 pr-8 text-ink-muted text-sm leading-relaxed"
            >
              {item.answer}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/ui/Accordion.tsx
git commit -m "feat(web): add Accordion primitive"
```

---

## Task 8: GitHub star count fetcher

**Files:**
- Create: `apps/web/lib/github-stars.ts`

- [ ] **Step 1: Write the fetcher**

Path: `apps/web/lib/github-stars.ts`

```ts
const REPO = "cacheplane/dawnai"
const FALLBACK = 100

/**
 * Fetches the GitHub star count for the Dawn repo.
 * Uses Next.js fetch revalidation (1 hour) so the value is cached during
 * production builds and refreshed during ISR. Returns a fallback on error.
 */
export async function getGitHubStars(): Promise<number> {
  try {
    const headers: HeadersInit = { Accept: "application/vnd.github+json" }
    const token = process.env.GITHUB_TOKEN
    if (token !== undefined && token !== "") {
      headers.Authorization = `Bearer ${token}`
    }
    const response = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers,
      next: { revalidate: 3600 },
    })
    if (!response.ok) return FALLBACK
    const data = (await response.json()) as { stargazers_count?: number }
    return typeof data.stargazers_count === "number" ? data.stargazers_count : FALLBACK
  } catch {
    return FALLBACK
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/github-stars.ts
git commit -m "feat(web): add GitHub stars fetcher with ISR revalidation"
```

---

## Task 9: StarBadge primitive

**Files:**
- Create: `apps/web/app/components/ui/StarBadge.tsx`

- [ ] **Step 1: Write `StarBadge.tsx`**

Path: `apps/web/app/components/ui/StarBadge.tsx`

```tsx
import { getGitHubStars } from "../../../lib/github-stars"

interface StarBadgeProps {
  readonly repoUrl?: string
  readonly className?: string
}

function StarIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="w-3.5 h-3.5"
    >
      <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
    </svg>
  )
}

function formatStars(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
  }
  return `${count}`
}

export async function StarBadge({
  repoUrl = "https://github.com/cacheplane/dawnai",
  className = "",
}: StarBadgeProps) {
  const stars = await getGitHubStars()
  return (
    <a
      href={repoUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Star Dawn on GitHub — ${stars} stars`}
      className={`inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors ${className}`}
    >
      <StarIcon />
      <span className="tabular-nums">{formatStars(stars)}</span>
    </a>
  )
}
```

- [ ] **Step 2: Verify typecheck and build**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass. The `StarBadge` is a server component that fetches at build time; the build must complete the fetch (or fall back) without error.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/ui/StarBadge.tsx
git commit -m "feat(web): add StarBadge primitive"
```

---

## Task 10: ProviderMark primitive

**Files:**
- Create: `apps/web/app/components/ui/ProviderMark.tsx`

- [ ] **Step 1: Write `ProviderMark.tsx`**

Path: `apps/web/app/components/ui/ProviderMark.tsx`

```tsx
import type { ReactNode } from "react"

interface ProviderMarkProps {
  readonly name: string
  readonly icon?: ReactNode
  readonly href?: string
}

/**
 * Inline word+mark for ecosystem rows. Renders the provider name with an
 * optional icon to its left, optionally wrapped in an external link.
 */
export function ProviderMark({ name, icon, href }: ProviderMarkProps) {
  const content = (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
      {icon !== undefined ? (
        <span aria-hidden="true" className="inline-flex w-4 h-4">
          {icon}
        </span>
      ) : null}
      <span>{name}</span>
    </span>
  )
  if (href !== undefined) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-ink transition-colors"
      >
        {content}
      </a>
    )
  }
  return content
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/ui/ProviderMark.tsx
git commit -m "feat(web): add ProviderMark primitive"
```

---

## Task 11: Reskin shared chrome primitives (CopyCommand, MobileMenu)

The Header refactor in Task 12 imports `CopyCommand` and `MobileMenu`. Both currently reference cream-theme tokens (`bg-bg-card`, `text-text-primary`, `bg-accent-amber`, `border-border-subtle`) that get removed in PR 6 cleanup. Reskin them now to the new SaaS tokens so the new header is consistent and PR 6 cleanup doesn't break them.

**Files:**
- Modify: `apps/web/app/components/CopyCommand.tsx`
- Modify: `apps/web/app/components/MobileMenu.tsx`

- [ ] **Step 1: Reskin `CopyCommand.tsx`**

Replace the JSX return block in `apps/web/app/components/CopyCommand.tsx` (lines 22–69) with the new-token version. Keep the `"use client"` directive, imports, state, and `handleCopy` logic unchanged.

The old return uses `text-text-muted`, `bg-bg-card`, `border-border`, `text-accent-amber`, `hover:bg-accent-amber/10`. The new version uses `text-ink-muted`, `bg-surface`, `border-divider`, `text-accent-saas`, `hover:bg-accent-saas-soft`.

Replace this block:

```tsx
  return (
    <div
      className={`font-mono text-sm text-text-muted bg-bg-card inline-flex items-center gap-2 pl-4 pr-2 py-2 rounded-md border border-border ${
        className ?? ""
      }`}
    >
      <span>
        <span className="text-accent-amber">$</span> {command}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
        className="ml-1 p-1 rounded hover:bg-accent-amber/10 text-text-muted hover:text-accent-amber transition-colors"
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            role="img"
            className="text-accent-amber"
          >
            <title>Copied</title>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            role="img"
          >
            <title>Copy</title>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
```

with:

```tsx
  return (
    <div
      className={`font-mono text-sm text-ink-muted bg-surface inline-flex items-center gap-2 pl-4 pr-2 py-2 rounded-md border border-divider ${
        className ?? ""
      }`}
    >
      <span>
        <span className="text-accent-saas">$</span> {command}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
        className="ml-1 p-1 rounded hover:bg-accent-saas-soft text-ink-muted hover:text-accent-saas transition-colors"
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            role="img"
            className="text-accent-saas"
          >
            <title>Copied</title>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            role="img"
          >
            <title>Copy</title>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
```

- [ ] **Step 2: Reskin `MobileMenu.tsx`**

In `apps/web/app/components/MobileMenu.tsx`, apply these token swaps. Each `old` string appears once in the file unless noted.

| Old                                                          | New                                                             |
|--------------------------------------------------------------|-----------------------------------------------------------------|
| `text-text-secondary hover:text-text-primary hover:bg-bg-card` | `text-ink-muted hover:text-ink hover:bg-surface` (replace all 4 occurrences) |
| `bg-bg-primary` (overlay)                                    | `bg-page`                                                       |
| `border-border-subtle` (replace all 2 occurrences)           | `border-divider`                                                |
| `text-text-muted` (replace all 4 occurrences)                | `text-ink-dim`                                                  |
| `bg-accent-amber text-bg-primary` (CTA)                      | `bg-accent-saas text-accent-saas-ink`                           |
| `text-accent-amber bg-accent-amber/8` (active docs link)     | `text-accent-saas bg-accent-saas-soft`                          |

After the swaps, the MobileMenu renders on the new SaaS palette with the same structure and behavior.

- [ ] **Step 3: Verify typecheck and build**

Run from repo root:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/CopyCommand.tsx apps/web/app/components/MobileMenu.tsx
git commit -m "feat(web): reskin CopyCommand and MobileMenu to SaaS tokens"
```

---

## Task 12: Refactor Header to new system

**Files:**
- Modify: `apps/web/app/components/HeaderInner.tsx`
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 1: Read `HeaderInner.tsx`**

Open the file. Note the current structure: it uses `className="landing-dark"` on the `<header>` element, `text-text-secondary` and `bg-accent-amber` from the cream/cosmic system, and a "Read the Docs" CTA in the right slot.

- [ ] **Step 2: Replace the file with the refactored version**

Path: `apps/web/app/components/HeaderInner.tsx`

```tsx
"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BrandLogo } from "./BrandLogo"
import { MobileMenu } from "./MobileMenu"
import { CopyCommand } from "./CopyCommand"

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      className="w-5 h-5"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.725-4.042-1.61-4.042-1.61-.547-1.387-1.335-1.757-1.335-1.757-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.775.42-1.305.762-1.605-2.665-.305-5.467-1.335-5.467-5.93 0-1.31.467-2.38 1.235-3.22-.123-.305-.535-1.527.118-3.18 0 0 1.008-.323 3.3 1.23.957-.267 1.98-.4 3-.405 1.02.005 2.043.138 3 .405 2.29-1.553 3.297-1.23 3.297-1.23.655 1.653.243 2.875.12 3.18.77.84 1.233 1.91 1.233 3.22 0 4.61-2.807 5.62-5.48 5.92.43.37.815 1.103.815 2.222 0 1.605-.015 2.898-.015 3.293 0 .32.217.697.825.578C20.565 21.795 24 17.297 24 12c0-6.63-5.37-12-12-12z"
      />
    </svg>
  )
}

interface HeaderInnerProps {
  readonly repoUrl: string
}

export function HeaderInner({ repoUrl }: HeaderInnerProps) {
  const pathname = usePathname()

  const linkClass = (active: boolean) =>
    active
      ? "text-ink transition-colors"
      : "text-ink-muted hover:text-ink transition-colors"

  return (
    <header className="bg-page border-b border-divider">
      <div className="max-w-[1280px] mx-auto flex justify-between items-center px-6 md:px-8 py-4">
        <BrandLogo imageClassName="h-8" />
        <nav className="hidden md:flex items-center gap-6 text-sm">
          <Link href="/docs/getting-started" className={linkClass(pathname.startsWith("/docs"))}>
            Docs
          </Link>
          <Link href="/blog" className={linkClass(pathname.startsWith("/blog"))}>
            Blog
          </Link>
          <Link href="/brand" className={linkClass(pathname === "/brand")}>
            Brand
          </Link>
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
            className="inline-flex items-center gap-1.5 text-ink-muted hover:text-ink transition-colors"
          >
            <GitHubIcon />
          </a>
          <CopyCommand command="pnpm create dawn-ai-app" />
        </nav>
        <MobileMenu />
      </div>
    </header>
  )
}
```

Notes:
- `landing-dark` className is removed.
- The "Read the Docs" CTA is replaced by a `CopyCommand` install chip — Docs is now in the main nav, and the install command is the primary right-side action.
- Static "100+" star count is removed; PR 3 reintroduces a live star count in the ProofStrip section, not in the header.

- [ ] **Step 3: Read `apps/web/app/layout.tsx`**

Locate the `<html lang="en" className={`dark ${...}`}>` line.

- [ ] **Step 4: Remove `dark` class from `<html>`**

Edit `apps/web/app/layout.tsx` line ~80–83. Replace:

```tsx
    <html
      lang="en"
      className={`dark ${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}
    >
```

with:

```tsx
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}
    >
```

- [ ] **Step 5: Verify typecheck, build, and visual review**

Run from repo root:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass.

Then start the dev server: `pnpm --filter @dawn-ai/web dev`. Open `http://localhost:3000` — the cosmic landing should still render correctly under the new header (the `landing-dark` scope on the page wrapper still drives the section colors). Open `http://localhost:3000/docs/getting-started` — the header should now be light with cream-system content below; verify there are no obvious z-index or color regressions. Stop the dev server when satisfied.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/HeaderInner.tsx apps/web/app/layout.tsx
git commit -m "feat(web): refactor Header to SaaS rebrand tokens"
```

---

## Task 13: Refactor Footer to three-column layout

**Files:**
- Modify: `apps/web/app/components/Footer.tsx`

- [ ] **Step 1: Replace the Footer file**

Path: `apps/web/app/components/Footer.tsx`

```tsx
import Link from "next/link"
import { BrandLogo } from "./BrandLogo"

interface LinkItem {
  readonly label: string
  readonly href: string
  readonly external?: boolean
}

interface Column {
  readonly heading: string
  readonly items: readonly LinkItem[]
}

const COLUMNS: readonly Column[] = [
  {
    heading: "Product",
    items: [
      { label: "Docs", href: "/docs/getting-started" },
      { label: "Examples", href: "/docs/recipes" },
      { label: "Blog", href: "/blog" },
      { label: "Brand", href: "/brand" },
    ],
  },
  {
    heading: "Resources",
    items: [
      { label: "GitHub", href: "https://github.com/cacheplane/dawnai", external: true },
      { label: "npm", href: "https://www.npmjs.com/org/dawn-ai", external: true },
      {
        label: "LangGraph.js",
        href: "https://www.langchain.com/langgraph",
        external: true,
      },
      { label: "RSS feed", href: "/blog/rss.xml", external: true },
      { label: "llms.txt", href: "/llms.txt", external: true },
    ],
  },
  {
    heading: "Legal",
    items: [
      {
        label: "MIT License",
        href: "https://github.com/cacheplane/dawnai/blob/main/LICENSE",
        external: true,
      },
      {
        label: "Code of Conduct",
        href: "https://github.com/cacheplane/dawnai/blob/main/CODE_OF_CONDUCT.md",
        external: true,
      },
      {
        label: "Security",
        href: "https://github.com/cacheplane/dawnai/blob/main/SECURITY.md",
        external: true,
      },
    ],
  },
]

function FooterLink({ label, href, external }: LinkItem) {
  const className = "text-sm text-ink-muted hover:text-ink transition-colors block py-0.5"
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
      </a>
    )
  }
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  )
}

export function Footer() {
  return (
    <footer className="bg-surface border-t border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 pt-16 pb-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-8">
          <div className="col-span-2 md:col-span-1">
            <BrandLogo imageClassName="h-7" />
            <p className="text-sm text-ink-muted mt-3 leading-relaxed max-w-[28ch]">
              TypeScript meta-framework for LangGraph.js.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim mb-3">
                {col.heading}
              </p>
              {col.items.map((item) => (
                <FooterLink key={item.label} {...item} />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-12 pt-6 border-t border-divider flex flex-col md:flex-row gap-2 md:justify-between text-xs text-ink-dim">
          <span>{`© ${new Date().getFullYear()} Dawn. MIT-licensed.`}</span>
          <span>Built on the LangChain ecosystem.</span>
        </div>
      </div>
    </footer>
  )
}
```

- [ ] **Step 2: Verify typecheck and build**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass.

- [ ] **Step 3: Visual review**

Start dev server: `pnpm --filter @dawn-ai/web dev`. Open `http://localhost:3000` — the footer should now be light cream with three columns + a brand block. Open `http://localhost:3000/docs/getting-started` — the same light footer should appear under the docs. Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/Footer.tsx
git commit -m "feat(web): rebuild Footer in SaaS three-column layout"
```

---

## Task 14: Rewrite /brand page as v2 system documentation

**Files:**
- Modify: `apps/web/app/brand/page.tsx`

- [ ] **Step 1: Read the current `/brand` page**

Open `apps/web/app/brand/page.tsx`. Note its current shape — it documents the cosmic palette, type, and assets.

- [ ] **Step 2: Replace the brand page**

Path: `apps/web/app/brand/page.tsx`

```tsx
import type { Metadata } from "next"
import { Button } from "../components/ui/Button"
import { Card } from "../components/ui/Card"
import { CodeFrame } from "../components/ui/CodeFrame"
import { Eyebrow } from "../components/ui/Eyebrow"
import { ProviderMark } from "../components/ui/ProviderMark"
import { StarBadge } from "../components/ui/StarBadge"
import { Accordion } from "../components/ui/Accordion"

export const metadata: Metadata = {
  title: "Brand",
  description: "Dawn brand and design system.",
}

interface SwatchProps {
  readonly name: string
  readonly token: string
  readonly value: string
}

function Swatch({ name, token, value }: SwatchProps) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span
        className="inline-block w-10 h-10 rounded-md border border-divider"
        style={{ backgroundColor: value }}
        aria-hidden="true"
      />
      <div className="flex flex-col">
        <span className="text-sm text-ink font-medium">{name}</span>
        <span className="text-xs text-ink-muted font-mono">{token}</span>
        <span className="text-xs text-ink-dim font-mono">{value}</span>
      </div>
    </div>
  )
}

const SWATCHES: readonly SwatchProps[] = [
  { name: "Page", token: "--color-page", value: "#ffffff" },
  { name: "Surface", token: "--color-surface", value: "#fafaf7" },
  { name: "Surface (sunk)", token: "--color-surface-sunk", value: "#f4f2ec" },
  { name: "Ink", token: "--color-ink", value: "#14110d" },
  { name: "Ink (muted)", token: "--color-ink-muted", value: "#5a554c" },
  { name: "Ink (dim)", token: "--color-ink-dim", value: "#8a857b" },
  { name: "Divider", token: "--color-divider", value: "#e6e3da" },
  { name: "Divider (strong)", token: "--color-divider-strong", value: "#cfcabd" },
  { name: "Accent", token: "--color-accent-saas", value: "#d97706" },
  { name: "Accent (soft)", token: "--color-accent-saas-soft", value: "#fef3c7" },
]

export default function BrandPage() {
  return (
    <div className="bg-page">
      <div className="max-w-[1100px] mx-auto px-6 md:px-8 py-16 md:py-24">

        {/* Header */}
        <section className="mb-16 md:mb-24">
          <Eyebrow>Design system · v2 (in progress)</Eyebrow>
          <h1
            className="font-display text-[56px] leading-[60px] md:text-[72px] md:leading-[76px] font-semibold text-ink mt-3"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0", letterSpacing: "-0.01em" }}
          >
            Dawn brand.
          </h1>
          <p className="text-lg text-ink-muted mt-5 max-w-2xl leading-relaxed">
            The visual language for Dawn — a restrained, infrastructure-grade
            system built on off-white surfaces, near-black ink, and a single
            amber accent. This page is the source of truth as the SaaS rebrand
            lands across the site.
          </p>
        </section>

        {/* Color */}
        <section className="mb-16 md:mb-24">
          <Eyebrow>Color</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-6">
            Tokens
          </h2>
          <Card className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-1">
              {SWATCHES.map((s) => (
                <Swatch key={s.token} {...s} />
              ))}
            </div>
          </Card>
        </section>

        {/* Type */}
        <section className="mb-16 md:mb-24">
          <Eyebrow>Type</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-6">
            Scale
          </h2>
          <Card className="p-6 space-y-6">
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Display XL · Fraunces 600 · 72/76</p>
              <p
                className="font-display text-[72px] leading-[76px] font-semibold text-ink"
                style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0", letterSpacing: "-0.01em" }}
              >
                Build LangGraph agents.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">H1 · Fraunces 600 · 40/44</p>
              <p
                className="font-display text-[40px] leading-[44px] font-semibold text-ink"
                style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0" }}
              >
                Routes for agents, not just pages.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Body L · Inter 400 · 18/30</p>
              <p className="text-lg text-ink leading-[30px] max-w-2xl">
                Dawn adds file-system routing, route-local tools, generated
                types, and HMR to your existing LangGraph.js stack.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Body · Inter 400 · 16/26</p>
              <p className="text-base text-ink leading-[26px] max-w-2xl">
                Keep the runtime. Drop the boilerplate.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Small · Inter 400 · 14/22</p>
              <p className="text-sm text-ink-muted leading-[22px] max-w-2xl">
                Production caveats, links, and supporting copy live at this size.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Code · JetBrains Mono 400 · 14/22</p>
              <code className="text-sm text-ink font-mono">pnpm create dawn-ai-app my-agent</code>
            </div>
          </Card>
        </section>

        {/* Primitives */}
        <section className="mb-16 md:mb-24">
          <Eyebrow>Primitives</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-6">
            Components
          </h2>

          <div className="space-y-6">
            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">Button</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" href="/docs/getting-started">
                  Read the docs
                </Button>
                <Button variant="secondary" href="https://github.com/cacheplane/dawnai" external>
                  Star on GitHub
                </Button>
              </div>
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">StarBadge</p>
              <StarBadge />
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">ProviderMark</p>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <ProviderMark name="OpenAI" href="https://openai.com" />
                <ProviderMark name="Anthropic" href="https://www.anthropic.com" />
                <ProviderMark name="Google" />
                <ProviderMark name="Ollama" />
              </div>
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">CodeFrame</p>
              <CodeFrame label="src/app/(public)/support/index.ts">
                <pre className="m-0 px-4 py-4 text-sm font-mono text-ink leading-[22px] overflow-x-auto">
{`import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "openai:gpt-4o-mini",
  systemPrompt: "Answer for {tenant}.",
})`}
                </pre>
              </CodeFrame>
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">Accordion</p>
              <Accordion
                defaultOpenId="ex-1"
                items={[
                  {
                    id: "ex-1",
                    question: "What is this primitive used for?",
                    answer: (
                      <p>
                        The FAQ section on the rebranded landing page uses this
                        primitive. It's keyboard-accessible and respects
                        prefers-reduced-motion.
                      </p>
                    ),
                  },
                  {
                    id: "ex-2",
                    question: "Can multiple items be open at once?",
                    answer: <p>No — only one item is open at a time by design.</p>,
                  },
                ]}
              />
            </Card>
          </div>
        </section>

        {/* Status */}
        <section>
          <Eyebrow>Status</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-3">
            Rebrand progress
          </h2>
          <p className="text-base text-ink-muted leading-relaxed max-w-2xl">
            This page reflects PR 1 of the SaaS-style rebrand: tokens,
            primitives, refreshed Header and Footer. The landing page, docs, and
            blog are migrated in subsequent PRs. See{" "}
            <a
              className="text-accent-saas hover:opacity-80"
              href="https://github.com/cacheplane/dawnai/pulls"
              target="_blank"
              rel="noopener noreferrer"
            >
              open PRs on GitHub
            </a>
            .
          </p>
        </section>

      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify typecheck and build**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both pass. The build will execute the `StarBadge` fetch — verify it completes (or falls back) without error.

- [ ] **Step 4: Visual review**

Start dev server: `pnpm --filter @dawn-ai/web dev`. Open `http://localhost:3000/brand`. Walk every section:
- Color swatches render with correct values and labels.
- Type scale renders at expected sizes and weights.
- Buttons render in both variants and respond to hover.
- StarBadge shows a number (live or fallback `100`).
- ProviderMark row renders inline.
- CodeFrame renders with traffic-light dots and the code block inside.
- Accordion opens/closes on click; keyboard `Tab` reaches the trigger and `Enter`/`Space` toggle it.

Open the page in mobile width (DevTools 375px). Verify the swatch grid, type, and components stack readably with no horizontal scroll.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/brand/page.tsx
git commit -m "feat(web): rewrite /brand as SaaS rebrand v2 documentation"
```

---

## Task 15: Lint pass

**Files:**
- All files modified in PR 1.

- [ ] **Step 1: Run lint**

Run from repo root: `pnpm lint`
Expected: pass. If biome reports issues in new files, fix them inline and re-run.

- [ ] **Step 2: Commit any lint fixes**

If fixes were needed:

```bash
git add -A
git commit -m "chore(web): biome lint pass"
```

If no fixes, skip this step.

---

## Task 16: Push branch and open PR

**Files:** none.

- [ ] **Step 1: Push the branch**

Run from repo root:

```bash
git push -u origin claude/relaxed-morse-fed86b
```

- [ ] **Step 2: Open the PR**

Run from repo root:

```bash
gh pr create --title "feat(web): SaaS rebrand PR 1 — foundation tokens, primitives, chrome" --body "$(cat <<'EOF'
## Summary

PR 1 of the SaaS-style rebrand sequence. Lands the visual foundation: new color and display-type tokens (additive, alongside existing cream/cosmic system), reusable primitives (Button, Eyebrow, Card, CodeFrame, ScreenshotFrame, Accordion, StarBadge, ProviderMark), refreshed Header and Footer, and a rewritten /brand page that documents the system.

Spec: docs/superpowers/specs/2026-05-12-saas-rebrand-design.md
Plan: docs/superpowers/plans/2026-05-12-saas-rebrand-pr1-foundation.md

The home page still renders the existing cosmic landing — that's replaced in PR 2 (hero) and following PRs. Visible change in this PR is limited to header, footer, and /brand.

## Test plan

- [ ] pnpm typecheck — green
- [ ] pnpm build — green
- [ ] pnpm lint — green
- [ ] CI: all checks green
- [ ] Visual: /brand renders all sections with new tokens and primitives
- [ ] Visual: / (landing) still renders cosmic landing correctly under the new header
- [ ] Visual: /docs/getting-started renders under new chrome with no regressions
- [ ] Visual: mobile width (375px) for / and /brand
- [ ] Accordion keyboard-accessible (Tab/Enter/Space)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Capture the PR URL**

The PR URL is returned by `gh pr create`. Save it for the next step.

---

## Task 17: Wait for CI and merge

**Files:** none.

- [ ] **Step 1: Watch CI**

Run from repo root: `gh pr checks --watch`
Expected: all checks complete and pass.

If a check fails, do NOT merge. Fix the underlying issue with a new commit on the same branch and re-run CI.

- [ ] **Step 2: Merge on green**

Once all checks pass:

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 3: Verify main is updated**

```bash
git fetch origin
git log origin/main --oneline -5
```

Expected: the squashed PR 1 commit appears at the top.

---

## Self-Review Summary

- **Spec coverage:** Tokens (Task 1), primitives Button/Eyebrow/Card/CodeFrame/ScreenshotFrame/Accordion/StarBadge/ProviderMark (Tasks 2–10), chrome reskin CopyCommand+MobileMenu (Task 11), Header refactor (Task 12), Footer rebuild (Task 13), /brand rewrite (Task 14), lint/PR/merge (Tasks 15–17). All PR 1 spec items addressed.
- **Placeholder scan:** No TBDs or "implement later." All code is concrete.
- **Token naming:** Plan uses `--color-page`/`--color-divider` instead of spec's `--color-bg`/`--color-border` to avoid collision; rename happens in PR 6 cleanup. Flagged in the header.
- **Test infrastructure:** No new test infra added — vitest is configured for node-only `.ts` files, not React component tests. Verification is typecheck + build + manual dev-server walk, as the spec already permits ("Visual regression is manual").

---

## Trajectory: Subsequent PRs

Each PR below gets its own plan written after the prior PR merges, so each plan is grounded in the actual post-merge code state.

- **PR 2 — Hero replacement.** New `Hero.tsx` replaces the cosmic hero stack. Removes parallax/starfield from the landing.
- **PR 3 — ProofStrip + WhyDawn.** Replaces ProblemSection, WhoItsFor, SolutionSection.
- **PR 4 — Feature blocks.** Reusable FeatureBlock primitive + four section instances (Routing, Tools, Types, Dev loop). Replaces FeatureGrid, CodeExample.
- **PR 5 — KeepTheRuntime + Ecosystem + Quickstart.** Replaces NotAReplacement, ComparisonTable, ArchitectureSection, DeploySection, EcosystemSection, HowItWorks.
- **PR 6 — FAQ + FinalCta + cosmic cleanup.** Adds FAQ and FinalCta. Deletes PaletteScroller, palette stops, ScrollReveal (or replaces), CreamSurface, HeroEarthParallax, StarsSection, BigReveal, ComicStrip, MigrateCta, CtaSection, all cosmic globals/scope. Renames `--color-page` → `--color-bg` and `--color-divider` → `--color-border` if desired.
- **PR 7 — Docs/blog re-token.** New tokens applied to docs/blog chrome and `mdx-components.tsx`.
- **PR 8 — Calibration.** Amber tuning for AA contrast, copy polish, final visual walk.
