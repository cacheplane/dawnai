# SaaS Rebrand PR 7 — Docs/Blog Re-token Plan

> superpowers:subagent-driven-development.

**Goal:** Migrate all docs/blog/shared component consumers off the cream-theme tokens (`bg-bg-primary`, `text-text-primary`, etc.) onto the SaaS tokens introduced in PR 1 (`bg-page`, `text-ink`, etc.). After this PR, no consumer references the cream-theme tokens, and the `CreamSurface` wrapper is removed.

**Out of scope (PR 8):** shiki theme change for MDX (next.config.ts/dawn-theme.ts), deletion of legacy cream-theme tokens and dawn accents from globals.css, amber CTA contrast tuning, copy polish.

---

## Token swap map (mechanical, replace_all per file)

```
text-text-primary        → text-ink
text-text-secondary      → text-ink-muted
text-text-muted          → text-ink-dim
text-text-dim            → text-ink-dim
bg-bg-primary            → bg-page
bg-bg-secondary          → bg-surface
bg-bg-card               → bg-surface
border-border-subtle     → border-divider
border-border            → border-divider
bg-accent-amber-deep     → bg-accent-saas
bg-accent-amber          → bg-accent-saas
text-accent-amber-deep   → text-accent-saas
text-accent-amber        → text-accent-saas
hover:text-accent-amber-deep → hover:text-accent-saas
hover:text-accent-amber  → hover:text-accent-saas
hover:bg-accent-amber-deep   → hover:bg-accent-saas
hover:bg-accent-amber    → hover:bg-accent-saas
```

`text-accent-green`, `text-accent-blue`, `text-accent-purple` and their `bg-`/`border-` variants stay as-is (callouts retain semantic colors — these tokens are still in `@theme`).

`/8`, `/10`, `/20` opacity modifiers on amber become opacity modifiers on saas (e.g., `bg-accent-amber/10` → `bg-accent-saas-soft` if the soft tone fits, otherwise `bg-accent-saas/10`).

## Files to swap

24 files (per `grep -rl` audit):
- `apps/web/mdx-components.tsx`
- `apps/web/app/blog/page.tsx`
- `apps/web/app/blog/tags/[tag]/page.tsx`
- `apps/web/app/components/BrandLogo.tsx`
- `apps/web/app/components/CopyPromptButton.tsx`
- `apps/web/app/components/ReadingLayout.tsx`
- `apps/web/app/components/mdx/{Steps,Tabs,CodeGroup,CodeBlock,Callout}.tsx`
- `apps/web/app/components/docs/{DocsPrevNext,RelatedCards,DocsSearch,DocsSidebar,PageActions,DocsTOC,DocsBreadcrumb}.tsx`
- `apps/web/app/components/blog/{PostCard,PostHeader,PostMeta,TagChips,FeaturedPostCard}.tsx`

Plus `apps/web/app/globals.css` (.mdx-inline-code chip, prose-dawn link, @layer base body).

## CreamSurface deletion

After the bulk swap, `CreamSurface.tsx` and the `<CreamSurface>{children}</CreamSurface>` wrap in `layout.tsx` are no longer needed (the new tokens resolve to cream values site-wide, and individual sections own their backgrounds). Remove the wrapper from `layout.tsx`, delete `CreamSurface.tsx`.

## Tasks

1. **Bulk token swap** — one commit per file or one batch commit; mechanical.
2. **globals.css updates** — `.mdx-inline-code` chip and `body @layer base` move to new tokens.
3. **layout.tsx** — remove `<CreamSurface>` wrapper.
4. **Delete CreamSurface.tsx**.
5. **Verify** (typecheck, build, lint).
6. **Push + PR + merge on green.**

After this PR, the only remaining cosmic artifacts are: cream-theme tokens still declared in `@theme` (unused but kept for safety until PR 8) and `lib/shiki/dawn-theme.ts` (used by `next.config.ts` rehype-pretty-code). PR 8 swaps shiki to a light theme and prunes unused tokens.
