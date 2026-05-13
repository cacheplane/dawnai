# SaaS Rebrand PR 2 — Hero Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the cosmic-themed hero stack (`HeroSection` + `HeroEarthParallax` + `HeroCodeShowcase`) with a single cream-palette `Hero.tsx` that lives above the remaining cosmic landing. No parallax, no starfield, no sun bloom. The rest of the landing keeps its cosmic look until PR 3+.

**Architecture:** New `Hero.tsx` is a server component that renders a Fraunces display headline, supporting paragraph, primary `CopyCommand` + "Read the docs" link, and a `CodeFrame` containing one shiki-highlighted code snippet. A new `highlightLight` helper uses shiki's bundled `github-light` theme so the code is readable on the cream surface. The Hero sits outside the `landing-dark` wrapper in `page.tsx`; the cosmic sections continue rendering below as before, with a visible cream→navy transition at the seam (an accepted "mid-rebrand" state per the spec).

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4, shiki 4 (bundled `github-light` theme), Biome.

**Spec:** [docs/superpowers/specs/2026-05-12-saas-rebrand-design.md](../specs/2026-05-12-saas-rebrand-design.md) § Page IA · Hero, § Visual System · Typography

---

## File Structure

**New files:**
- `apps/web/app/components/landing-v2/Hero.tsx` — new cream-palette hero
- `apps/web/lib/shiki/highlight-light.ts` — light-theme shiki helper using `github-light`

**Modified files:**
- `apps/web/app/globals.css` — add Display XL and Display L type tokens (Tailwind v4 `--text-*` syntax)
- `apps/web/app/page.tsx` — replace `HeroSection` import with `Hero`, move it outside the `landing-dark` wrapper

**Untouched (deleted in PR 6):**
- `apps/web/app/components/landing/HeroSection.tsx`
- `apps/web/app/components/landing/HeroCodeShowcase.tsx`
- `apps/web/app/components/landing/HeroEarthParallax.tsx`
- `apps/web/lib/shiki/highlight.ts` and `dawn-theme.ts` (still consumed by other cosmic sections)

---

## Verification

Run from repo root:
- `pnpm typecheck`
- `pnpm --filter @dawn-ai/web build`
- `pnpm lint`

CI runs `pnpm ci:validate`.

---

## Task 1: Add display-type tokens

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add two display-type tokens inside the existing `@theme` block, after the `--color-accent-saas-soft` line and before the `--font-sans` line:**

```css
  /* Display sizes used by the SaaS-rebrand Hero (PR 2). */
  --text-display-xl: 4.5rem;
  --text-display-xl--line-height: 4.75rem;
  --text-display-l: 3.5rem;
  --text-display-l--line-height: 3.75rem;
```

This generates Tailwind utility classes `text-display-xl` and `text-display-l` paired with their line-heights.

- [ ] **Step 2: Verify and commit**

```bash
pnpm --filter @dawn-ai/web typecheck && pnpm --filter @dawn-ai/web build
git add apps/web/app/globals.css
git commit -m "feat(web): add display-type tokens for SaaS-rebrand Hero"
```

---

## Task 2: Light shiki highlight helper

**Files:**
- Create: `apps/web/lib/shiki/highlight-light.ts`

- [ ] **Step 1: Write the file**

```ts
import { createHighlighter, type BundledLanguage } from "shiki"

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light"],
      langs: ["typescript", "bash", "tsx"],
    })
  }
  return highlighterPromise
}

/**
 * Highlight code with shiki's bundled `github-light` theme. Intended for the
 * cream SaaS-rebrand surfaces where the existing dark `dawnTheme` would be
 * unreadable. Background is owned by the surrounding container (transparent).
 */
export async function highlightLight(
  code: string,
  lang: BundledLanguage
): Promise<string> {
  const highlighter = await getHighlighter()
  return highlighter.codeToHtml(code, {
    lang,
    theme: "github-light",
  })
}
```

- [ ] **Step 2: Verify and commit**

```bash
pnpm --filter @dawn-ai/web typecheck
git add apps/web/lib/shiki/highlight-light.ts
git commit -m "feat(web): add github-light shiki helper for cream surfaces"
```

---

## Task 3: Hero component

**Files:**
- Create: `apps/web/app/components/landing-v2/Hero.tsx`

- [ ] **Step 1: Create directory and write file**

```bash
mkdir -p apps/web/app/components/landing-v2
```

Path: `apps/web/app/components/landing-v2/Hero.tsx`

```tsx
import Link from "next/link"
import { highlightLight } from "../../../lib/shiki/highlight-light"
import { CodeFrame } from "../ui/CodeFrame"
import { CopyCommand } from "../CopyCommand"

const ROUTE_CODE = `import { agent } from "@dawn-ai/sdk"
import { z } from "zod"

export const state = z.object({
  tenant: z.string(),
  question: z.string(),
})

export default agent({
  model: "openai:gpt-4o-mini",
  systemPrompt: "Answer for {tenant}.",
})`

export async function Hero() {
  const codeHtml = await highlightLight(ROUTE_CODE, "typescript")

  return (
    <section className="relative bg-page border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 pt-20 md:pt-28 pb-20 md:pb-28">
        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
          {/* Left: copy + actions */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim">
              TypeScript meta-framework · for LangGraph.js
            </p>
            <h1
              className="font-display font-semibold text-ink mt-4 text-[40px] leading-[44px] md:text-[56px] md:leading-[60px] lg:text-[72px] lg:leading-[76px]"
              style={{
                fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
                letterSpacing: "-0.015em",
              }}
            >
              Build LangGraph agents
              <br className="hidden md:inline" />
              {" "}like Next.js apps.
            </h1>
            <p className="mt-6 text-lg text-ink-muted leading-[30px] max-w-[44ch]">
              Dawn adds file-system routing, route-local tools, generated types,
              and HMR to your existing LangGraph.js stack.{" "}
              <strong className="text-ink font-medium">
                Keep the runtime. Drop the boilerplate.
              </strong>
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <CopyCommand command="pnpm create dawn-ai-app my-agent" />
              <Link
                href="/docs/getting-started"
                className="text-sm font-medium text-ink hover:text-accent-saas transition-colors inline-flex items-center gap-1.5"
              >
                Read the docs <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>

          {/* Right: code visual */}
          <div className="w-full">
            <CodeFrame label="src/app/(public)/support/index.ts">
              <div
                className="px-4 py-4 text-sm font-mono leading-[22px] overflow-x-auto"
                // shiki output is sanitized; safe to dangerouslySetInnerHTML
                dangerouslySetInnerHTML={{ __html: codeHtml }}
              />
            </CodeFrame>
          </div>
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Verify**

```bash
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web build
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/landing-v2/Hero.tsx
git commit -m "feat(web): add SaaS-rebrand Hero with cream palette and shiki-light code"
```

---

## Task 4: Update `page.tsx`

**Files:**
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Replace the file with this content**

```tsx
import { Hero } from "./components/landing-v2/Hero"
import { ArchitectureSection } from "./components/landing/ArchitectureSection"
import { BigReveal } from "./components/landing/BigReveal"
import { CodeExample } from "./components/landing/CodeExample"
import { ComicStrip } from "./components/landing/ComicStrip"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { CtaSection } from "./components/landing/CtaSection"
import { DeploySection } from "./components/landing/DeploySection"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HowItWorks } from "./components/landing/HowItWorks"
import { MigrateCta } from "./components/landing/MigrateCta"
import { NotAReplacement } from "./components/landing/NotAReplacement"
import { ProblemSection } from "./components/landing/ProblemSection"
import { SolutionSection } from "./components/landing/SolutionSection"
import { StarsSection } from "./components/landing/StarsSection"
import { WhoItsFor } from "./components/landing/WhoItsFor"
import { PaletteScroller } from "./components/PaletteScroller"
import { ScrollReveal } from "./components/ScrollReveal"

export default function HomePage() {
  return (
    <>
      <Hero />
      <div className="landing-dark relative isolate">
        <PaletteScroller />
        <ProblemSection />
        <ScrollReveal>
          <WhoItsFor />
        </ScrollReveal>
        <ScrollReveal>
          <ComicStrip />
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
          <EcosystemSection />
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
          <MigrateCta />
        </ScrollReveal>
        <ScrollReveal>
          <CtaSection />
        </ScrollReveal>
      </div>
    </>
  )
}
```

Changes vs. previous:
- Import `Hero` from `./components/landing-v2/Hero`.
- Drop `HeroSection` import.
- Wrap returned JSX in a fragment.
- `<Hero />` rendered first; `<div className="landing-dark">` wraps everything below.
- Drop the now-stale comment about "seamless navy bleed across hero/problem."

- [ ] **Step 2: Verify**

```bash
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web build
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/page.tsx
git commit -m "feat(web): wire SaaS-rebrand Hero into landing page above cosmic sections"
```

---

## Task 5: Lint, push, PR, merge on green

- [ ] **Step 1: Lint**

```bash
pnpm lint
```

If failures, apply `pnpm lint:fix`, re-run, and commit any auto-formats:

```bash
git add -A
git commit -m "chore(web): biome auto-format"
```

- [ ] **Step 2: Push**

```bash
git push -u origin claude/saas-rebrand-pr2-hero
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat(web): SaaS rebrand PR 2 — Hero replacement" --body "$(cat <<'EOF'
## Summary

PR 2 of the SaaS-style rebrand sequence. Replaces the cosmic hero stack (HeroSection + HeroEarthParallax + HeroCodeShowcase) with a single cream-palette Hero that sits above the remaining cosmic landing.

Spec: [docs/superpowers/specs/2026-05-12-saas-rebrand-design.md](https://github.com/cacheplane/dawnai/blob/main/docs/superpowers/specs/2026-05-12-saas-rebrand-design.md)
Plan: [docs/superpowers/plans/2026-05-12-saas-rebrand-pr2-hero.md](https://github.com/cacheplane/dawnai/blob/main/docs/superpowers/plans/2026-05-12-saas-rebrand-pr2-hero.md)

### What's in
- `landing-v2/Hero.tsx` — server component, Fraunces display H1, supporting paragraph, install + docs CTAs, CodeFrame with a single typed route file
- `lib/shiki/highlight-light.ts` — `github-light` theme helper so code is readable on cream
- Display-type tokens in globals.css (`text-display-xl`, `text-display-l`)
- `page.tsx` — new Hero rendered above the cosmic `landing-dark` wrapper

### What's not in
- Removal of `HeroSection`, `HeroCodeShowcase`, `HeroEarthParallax`, parallax/starfield, palette scroller — these stay until PR 6 cleanup
- All other landing sections (PR 3-5)

### Mid-transition state
The page now has a visible seam between the cream hero and the navy cosmic sections below. This is the accepted "mid-rebrand" state called out in the spec — the navy goes away in PR 6.

## Test plan
- [x] pnpm typecheck — green
- [x] pnpm build — green
- [x] pnpm lint — green
- [ ] CI green
- [ ] Visual: / renders new Hero above cosmic sections; both readable
- [ ] Visual: mobile width — Hero stacks vertically
- [ ] Visual: code in CodeFrame is readable

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI**

```bash
gh pr checks <PR_NUMBER> --watch --interval 15
```

- [ ] **Step 5: Merge on green**

```bash
gh pr merge <PR_NUMBER> --squash --admin --delete-branch
```

Admin override is per the user's standing "merge on green" directive — branch protection requires 1 review but `enforce_admins: false`.
