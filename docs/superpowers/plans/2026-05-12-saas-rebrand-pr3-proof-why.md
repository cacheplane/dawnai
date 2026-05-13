# SaaS Rebrand PR 3 — ProofStrip + WhyDawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Add two new sections below the Hero: a `ProofStrip` band with LangGraph provenance + GitHub star/contributor counts + model providers, and a `WhyDawn` editorial section that frames the gap Dawn fills. Remove `ProblemSection`, `WhoItsFor`, and `SolutionSection` from `page.tsx` since their content is absorbed into `WhyDawn`.

**Architecture:** Both components are server components on the cream palette. A new `github-contributors.ts` fetcher mirrors the existing `github-stars.ts`. `page.tsx` renders Hero → ProofStrip → WhyDawn before the remaining cosmic wrapper.

**Spec:** [docs/superpowers/specs/2026-05-12-saas-rebrand-design.md](../specs/2026-05-12-saas-rebrand-design.md) § Page IA · #3 Proof strip, #4 Why Dawn

---

## File Structure

**New:**
- `apps/web/app/components/landing-v2/ProofStrip.tsx`
- `apps/web/app/components/landing-v2/WhyDawn.tsx`
- `apps/web/lib/github-contributors.ts`

**Modified:**
- `apps/web/app/page.tsx` — import new sections, drop `ProblemSection` / `WhoItsFor` / `SolutionSection`

**Untouched (deleted later):** the cosmic section files themselves stay on disk until PR 6.

---

## Task 1: Contributor count fetcher

Create `apps/web/lib/github-contributors.ts`:

```ts
const REPO = "cacheplane/dawnai"
const FALLBACK = 5

/**
 * Fetches the contributor count for the Dawn repo via the GitHub API.
 * Mirrors getGitHubStars: 1-hour ISR cache, optional GITHUB_TOKEN, graceful
 * fallback on any error. Uses the `contributors?per_page=1&anon=true` endpoint
 * and parses the `Link` header `last` page number to avoid pulling the whole
 * list.
 */
export async function getGitHubContributors(): Promise<number> {
  try {
    const headers: HeadersInit = { Accept: "application/vnd.github+json" }
    const token = process.env.GITHUB_TOKEN
    if (token !== undefined && token !== "") {
      headers.Authorization = `Bearer ${token}`
    }
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/contributors?per_page=1&anon=true`,
      { headers, next: { revalidate: 3600 } }
    )
    if (!response.ok) return FALLBACK
    const link = response.headers.get("link") ?? ""
    const match = link.match(/[?&]page=(\d+)>; rel="last"/)
    if (match?.[1] !== undefined) {
      const last = Number.parseInt(match[1], 10)
      if (Number.isFinite(last) && last > 0) return last
    }
    // Single page — count items
    const data = (await response.json()) as readonly unknown[]
    return Array.isArray(data) ? data.length : FALLBACK
  } catch {
    return FALLBACK
  }
}
```

Commit: `feat(web): add GitHub contributors fetcher`

## Task 2: ProofStrip

Create `apps/web/app/components/landing-v2/ProofStrip.tsx`:

```tsx
import { getGitHubStars } from "../../../lib/github-stars"
import { getGitHubContributors } from "../../../lib/github-contributors"
import { ProviderMark } from "../ui/ProviderMark"

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${n}`
}

function StarIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4"
    >
      <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

export async function ProofStrip() {
  const [stars, contributors] = await Promise.all([
    getGitHubStars(),
    getGitHubContributors(),
  ])

  return (
    <section className="bg-surface border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-8 md:py-10">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6 md:gap-10">

          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim">
              Built on
            </span>
            <a
              href="https://www.langchain.com/langgraph"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-ink hover:text-accent-saas transition-colors"
            >
              LangGraph.js
            </a>
          </div>

          <div className="flex items-center gap-5 md:gap-6">
            <a
              href="https://github.com/cacheplane/dawnai"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Star Dawn on GitHub — ${stars} stars`}
              className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors"
            >
              <StarIcon />
              <span className="tabular-nums">{formatCount(stars)}</span>
              <span className="text-ink-dim">stars</span>
            </a>
            <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
              <UsersIcon />
              <span className="tabular-nums">{contributors}</span>
              <span className="text-ink-dim">contributors</span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim hidden md:inline">
              Works with
            </span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ProviderMark name="OpenAI" href="https://openai.com" />
              <ProviderMark name="Anthropic" href="https://www.anthropic.com" />
              <ProviderMark name="Google" />
              <ProviderMark name="Ollama" />
            </div>
          </div>

        </div>
      </div>
    </section>
  )
}
```

Commit: `feat(web): add ProofStrip section (LangGraph + stars + contributors + providers)`

## Task 3: WhyDawn

Create `apps/web/app/components/landing-v2/WhyDawn.tsx`:

```tsx
import { Eyebrow } from "../ui/Eyebrow"

export function WhyDawn() {
  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[920px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Why Dawn</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          LangGraph is powerful. Writing real agents in it is tedious.
        </h2>

        <div className="mt-8 space-y-5 text-lg text-ink-muted leading-[30px] max-w-[64ch]">
          <p>
            LangGraph.js gives you a graph runtime, durable state, and a
            production-grade execution model — the right primitives. What it
            doesn't give you is structure. Real agents drift into a single
            file, hand-rolled tool plumbing, types that don't follow the data,
            and a dev loop that means restarting the graph every time you
            change a prompt.
          </p>
          <p>
            Dawn is a meta-framework for LangGraph in the same shape Next.js is
            for React. File-system routes for agents, route-local tools with
            inferred argument types, end-to-end generated types from your
            state schema, and an HMR dev server that doesn't lose graph state
            between edits.
          </p>
          <p>
            <strong className="text-ink font-medium">
              Dawn is not a runtime, an LLM router, or a hosting product.
            </strong>{" "}
            Your graphs stay valid LangGraph code. Your model calls stay your
            model calls. Your deployment target stays yours. Dawn is the
            scaffolding between you and the runtime.
          </p>
        </div>
      </div>
    </section>
  )
}
```

Commit: `feat(web): add WhyDawn editorial section`

## Task 4: Update page.tsx

Replace `apps/web/app/page.tsx` with EXACTLY:

```tsx
import { Hero } from "./components/landing-v2/Hero"
import { ProofStrip } from "./components/landing-v2/ProofStrip"
import { WhyDawn } from "./components/landing-v2/WhyDawn"
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
import { StarsSection } from "./components/landing/StarsSection"
import { PaletteScroller } from "./components/PaletteScroller"
import { ScrollReveal } from "./components/ScrollReveal"

export default function HomePage() {
  return (
    <>
      <Hero />
      <ProofStrip />
      <WhyDawn />
      <div className="landing-dark relative isolate">
        <PaletteScroller />
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

Removed: `ProblemSection`, `WhoItsFor`, `SolutionSection` imports + usage (absorbed into WhyDawn).

Commit: `feat(web): wire ProofStrip and WhyDawn into landing; drop redundant cosmic sections`

## Task 5: Lint, push, PR, merge

Standard sequence — `pnpm lint` (fix and commit if needed), push to `origin`, open PR titled "feat(web): SaaS rebrand PR 3 — ProofStrip + WhyDawn", watch CI, `gh pr merge --squash --admin --delete-branch` on green.
