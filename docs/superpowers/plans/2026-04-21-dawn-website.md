# Dawn Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing placeholder website at `apps/web/` with a marketing landing page and Getting Started docs page that positions Dawn as "The App Router for AI agents."

**Architecture:** Rewrite the existing Next.js App Router app in-place at `apps/web/`. Add Tailwind CSS and `@next/mdx` for styling and docs content. The landing page is built from 10 focused section components. Docs use MDX rendered via Next.js `@next/mdx` integration. All design tokens live in Tailwind config.

**Tech Stack:** Next.js 16 (App Router), Tailwind CSS 4, `@next/mdx`, TypeScript 6, React 19

---

## File Structure

```
apps/web/
├── next.config.ts                    # MDX plugin config
├── tailwind.config.ts                # Design tokens, custom theme
├── postcss.config.mjs                # PostCSS for Tailwind
├── package.json                      # Add tailwindcss, @next/mdx, @tailwindcss/postcss
├── mdx-components.tsx                # MDX component mappings (required by @next/mdx)
├── content/
│   └── docs/
│       └── getting-started.mdx       # Getting Started doc content
├── app/
│   ├── layout.tsx                    # Root layout (dark theme, Inter + JetBrains Mono fonts)
│   ├── page.tsx                      # Landing page (composes section components)
│   ├── globals.css                   # Tailwind directives + custom utilities
│   └── docs/
│       ├── layout.tsx                # Docs layout (sidebar + content)
│       └── getting-started/
│           └── page.tsx              # Renders getting-started.mdx
└── components/
    ├── Header.tsx                    # Shared nav bar
    ├── Footer.tsx                    # Shared footer
    └── landing/
        ├── HeroSection.tsx           # Hero with badge, headline, CTAs, trust strip
        ├── ProblemSection.tsx         # Pain points grid
        ├── ComparisonTable.tsx        # Next.js vs Dawn convention table
        ├── SolutionSection.tsx        # Three pillars (Convention, Type Safety, Tooling)
        ├── CodeExample.tsx            # Project tree + code panels + CLI output
        ├── DeploySection.tsx          # Deployment pipeline visual
        ├── FeatureGrid.tsx            # 2x3 feature cards
        ├── HowItWorks.tsx             # 4-step vertical flow
        ├── EcosystemSection.tsx       # LangChain ecosystem package cards
        └── CtaSection.tsx             # Final CTA with install command
```

**Files removed** (replaced by new implementation):
- `app/docs/app-graph/page.tsx`
- `app/docs/cli/page.tsx`
- `app/docs/examples/page.tsx`
- `app/docs/packages/page.tsx`
- `app/docs/page.tsx`
- `app/robots.ts`
- `app/sitemap.ts`

---

### Task 1: Install dependencies and configure Tailwind + MDX

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/postcss.config.mjs`
- Modify: `apps/web/next.config.ts`
- Modify: `apps/web/tsconfig.json`
- Create: `apps/web/mdx-components.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Install Tailwind CSS v4, @next/mdx, and PostCSS**

Run from repo root:
```bash
cd apps/web && pnpm add tailwindcss @tailwindcss/postcss @next/mdx @mdx-js/mdx @mdx-js/react
```

- [ ] **Step 2: Create PostCSS config**

Create `apps/web/postcss.config.mjs`:
```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
}

export default config
```

- [ ] **Step 3: Replace globals.css with Tailwind directives and design tokens**

Replace the entire contents of `apps/web/app/globals.css` with:
```css
@import "tailwindcss";

@theme {
  --color-bg-primary: #000000;
  --color-bg-secondary: #050505;
  --color-bg-card: #0a0a0a;
  --color-border: #1a1a1a;
  --color-border-subtle: #111111;
  --color-text-primary: #ffffff;
  --color-text-secondary: #888888;
  --color-text-muted: #555555;
  --color-text-dim: #444444;
  --color-accent-green: #00a67e;
  --color-accent-blue: #3178c6;
  --color-accent-purple: #646cff;

  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace;
}

body {
  @apply bg-bg-primary text-text-primary font-sans antialiased;
  margin: 0;
  min-height: 100vh;
}

a {
  color: inherit;
  text-decoration: none;
}
```

- [ ] **Step 4: Update next.config.ts with MDX plugin**

Replace `apps/web/next.config.ts` with:
```typescript
import createMDX from "@next/mdx"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "md", "mdx"],
}

const withMDX = createMDX({})

export default withMDX(nextConfig)
```

- [ ] **Step 5: Create MDX components file**

Create `apps/web/mdx-components.tsx`:
```tsx
import type { MDXComponents } from "mdx/types"

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => (
      <h1 className="text-3xl font-bold text-text-primary mb-4">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-2xl font-bold text-text-primary mt-10 mb-4">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-lg font-semibold text-text-primary mt-8 mb-3">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="text-text-secondary leading-7 mb-4">{children}</p>
    ),
    code: ({ children }) => (
      <code className="bg-bg-card border border-border rounded px-1.5 py-0.5 text-sm font-mono text-text-secondary">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="bg-bg-card border border-border rounded-lg p-4 overflow-x-auto mb-4 text-sm font-mono leading-relaxed">
        {children}
      </pre>
    ),
    ul: ({ children }) => (
      <ul className="list-disc list-inside text-text-secondary leading-7 mb-4 space-y-1">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal list-inside text-text-secondary leading-7 mb-4 space-y-1">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="text-text-secondary">{children}</li>,
    strong: ({ children }) => (
      <strong className="text-text-primary font-semibold">{children}</strong>
    ),
    ...components,
  }
}
```

- [ ] **Step 6: Add mdx type to tsconfig**

In `apps/web/tsconfig.json`, the existing config extends `../../packages/config-typescript/nextjs.json` which should work. No changes needed unless the build fails — verify by running:

```bash
cd apps/web && pnpm typecheck
```

If `mdx/types` is not found, add `@mdx-js/react` types. The `@next/mdx` package should handle this.

- [ ] **Step 7: Verify the build works**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds (the page content will be wrong since we haven't updated components yet, but the toolchain works).

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json apps/web/postcss.config.mjs apps/web/next.config.ts apps/web/mdx-components.tsx apps/web/app/globals.css pnpm-lock.yaml
git commit -m "feat(web): add Tailwind CSS v4 and MDX support"
```

---

### Task 2: Root layout and shared Header/Footer components

**Files:**
- Modify: `apps/web/app/layout.tsx`
- Create: `apps/web/app/components/Header.tsx`
- Create: `apps/web/app/components/Footer.tsx`

- [ ] **Step 1: Create Header component**

Create `apps/web/app/components/Header.tsx`:
```tsx
import Link from "next/link"

export function Header() {
  return (
    <header className="flex justify-between items-center px-8 py-4 border-b border-border-subtle">
      <Link href="/" className="font-bold text-text-primary tracking-tight">
        dawn
      </Link>
      <nav className="flex items-center gap-6 text-sm text-text-secondary">
        <Link href="/docs/getting-started" className="hover:text-text-primary transition-colors">
          Docs
        </Link>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-primary transition-colors"
        >
          GitHub
        </a>
        <Link
          href="/docs/getting-started"
          className="text-text-primary bg-[#181818] px-3 py-1.5 rounded-md hover:bg-[#222] transition-colors"
        >
          Get Started
        </Link>
      </nav>
    </header>
  )
}
```

- [ ] **Step 2: Create Footer component**

Create `apps/web/app/components/Footer.tsx`:
```tsx
export function Footer() {
  return (
    <footer className="flex justify-between items-center px-8 py-6 border-t border-border-subtle text-xs text-text-dim">
      <span>dawn</span>
      <nav className="flex gap-4">
        <a href="/docs/getting-started" className="hover:text-text-secondary transition-colors">
          Docs
        </a>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-secondary transition-colors"
        >
          GitHub
        </a>
        <a
          href="https://www.npmjs.com/org/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-secondary transition-colors"
        >
          npm
        </a>
      </nav>
    </footer>
  )
}
```

- [ ] **Step 3: Rewrite root layout**

Replace the entire contents of `apps/web/app/layout.tsx` with:
```tsx
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { Header } from "./components/Header"
import { Footer } from "./components/Footer"
import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: "Dawn — The App Router for AI Agents",
    template: "%s | Dawn",
  },
  description:
    "A TypeScript-first framework for building and deploying graph-based AI systems with the ergonomics of Next.js.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <div className="min-h-screen flex flex-col">
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  )
}
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/layout.tsx apps/web/app/components/Header.tsx apps/web/app/components/Footer.tsx
git commit -m "feat(web): add root layout with Header and Footer components"
```

---

### Task 3: Landing page — Hero and Problem sections

**Files:**
- Create: `apps/web/app/components/landing/HeroSection.tsx`
- Create: `apps/web/app/components/landing/ProblemSection.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Create HeroSection component**

Create `apps/web/app/components/landing/HeroSection.tsx`:
```tsx
import Link from "next/link"

export function HeroSection() {
  return (
    <section className="pt-24 pb-16 text-center bg-gradient-to-b from-bg-primary to-bg-secondary">
      {/* Ecosystem badge */}
      <div className="inline-flex items-center gap-2 px-3.5 py-1.5 border border-[#222] rounded-full text-xs text-text-secondary mb-6">
        <span className="text-text-muted">Built for the</span>
        <span className="text-accent-green font-semibold">LangChain</span>
        <span className="text-text-muted">ecosystem</span>
      </div>

      <h1 className="text-5xl md:text-6xl font-extrabold text-text-primary tracking-tight leading-[1.1]">
        The App Router
        <br />
        for AI agents.
      </h1>

      <p className="text-text-secondary mt-4 text-lg max-w-xl mx-auto leading-relaxed">
        A TypeScript-first framework for building and deploying graph-based AI systems with the
        ergonomics of Next.js. File-system routing, type-safe tools, zero boilerplate.
      </p>

      <div className="mt-8 flex gap-3 justify-center">
        <Link
          href="/docs/getting-started"
          className="px-6 py-2.5 bg-text-primary text-bg-primary rounded-md text-sm font-semibold hover:bg-gray-200 transition-colors"
        >
          Get Started
        </Link>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="px-6 py-2.5 border border-[#333] text-text-secondary rounded-md text-sm hover:border-[#555] transition-colors"
        >
          GitHub
        </a>
      </div>

      <div className="mt-6 font-mono text-sm text-text-muted bg-bg-card inline-block px-4 py-2 rounded-md border border-border">
        npx create-dawn-app my-agent
      </div>

      {/* Trust strip */}
      <div className="mt-12 flex justify-center gap-10 opacity-50">
        {[
          { name: "LangGraph", color: "text-accent-green" },
          { name: "LangChain", color: "text-accent-green" },
          { name: "TypeScript", color: "text-accent-blue" },
          { name: "Vite", color: "text-accent-purple" },
        ].map((item) => (
          <span key={item.name} className={`text-xs ${item.color}`}>
            {item.name}
          </span>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Create ProblemSection component**

Create `apps/web/app/components/landing/ProblemSection.tsx`:
```tsx
const painPoints = [
  {
    title: "Where do agents live?",
    body: "No standard project structure. Every repo is a snowflake.",
  },
  {
    title: "How do tools get typed?",
    body: "Manual type wiring everywhere. Zod schemas disconnected from tool functions.",
  },
  {
    title: "How do I test locally?",
    body: "No dev server, no hot reload, no scenario runner. console.log debugging.",
  },
  {
    title: "How do I deploy?",
    body: "Each team hand-rolls Docker, infra, and server config from scratch.",
  },
]

export function ProblemSection() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">The Problem</p>
        <h2 className="text-3xl font-bold text-text-primary leading-snug">
          Building agents with raw LangGraph
          <br />
          is like building React apps before Next.js.
        </h2>
        <p className="text-text-secondary mt-4 leading-7">
          You get the runtime. But you&apos;re left to figure out project structure, tooling, type
          safety, and deployment on your own. Every team reinvents the same scaffolding.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto mt-10">
        {painPoints.map((point) => (
          <div key={point.title} className="bg-bg-card border border-border rounded-lg p-5">
            <h3 className="text-sm font-semibold text-text-primary">{point.title}</h3>
            <p className="text-sm text-text-muted mt-2 leading-relaxed">{point.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Replace landing page**

Replace the entire contents of `apps/web/app/page.tsx` with:
```tsx
import { HeroSection } from "./components/landing/HeroSection"
import { ProblemSection } from "./components/landing/ProblemSection"

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ProblemSection />
    </>
  )
}
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/components/landing/HeroSection.tsx apps/web/app/components/landing/ProblemSection.tsx
git commit -m "feat(web): add Hero and Problem landing sections"
```

---

### Task 4: Landing page — Comparison table and Solution sections

**Files:**
- Create: `apps/web/app/components/landing/ComparisonTable.tsx`
- Create: `apps/web/app/components/landing/SolutionSection.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Create ComparisonTable component**

Create `apps/web/app/components/landing/ComparisonTable.tsx`:
```tsx
const rows: Array<{ label: string; nextjs: string; dawn: string; dawnOnly?: boolean }> = [
  { label: "File-system routing", nextjs: "app/page.tsx", dawn: "src/app/index.ts" },
  { label: "Dynamic segments", nextjs: "[slug]", dawn: "[tenant]" },
  { label: "Route groups", nextjs: "(marketing)", dawn: "(public)" },
  { label: "Generated types", nextjs: ".next/types/", dawn: "dawn.generated.d.ts" },
  { label: "Dev server", nextjs: "next dev", dawn: "dawn dev" },
  { label: "Scaffold CLI", nextjs: "create-next-app", dawn: "create-dawn-app" },
  { label: "Co-located tools w/ type inference", nextjs: "\u2014", dawn: "\u2713", dawnOnly: true },
  { label: "Built-in scenario testing", nextjs: "\u2014", dawn: "\u2713", dawnOnly: true },
]

export function ComparisonTable() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle bg-bg-secondary">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">The Pattern</p>
        <h2 className="text-3xl font-bold text-text-primary leading-snug">
          You already know this story.
        </h2>
        <p className="text-text-secondary mt-4 leading-7">
          Every runtime gets a framework. React got Next.js. Svelte got SvelteKit. Vue got Nuxt.
          LangGraph just got Dawn.
        </p>
      </div>

      <div className="max-w-[650px] mx-auto mt-10 border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[2fr_1fr_1fr] bg-[#111] px-5 py-3 text-xs text-text-secondary uppercase tracking-wide font-semibold">
          <span>Convention</span>
          <span className="text-center">Next.js</span>
          <span className="text-center text-text-primary">Dawn</span>
        </div>

        {/* Rows */}
        {rows.map((row, i) => (
          <div
            key={row.label}
            className={`grid grid-cols-[2fr_1fr_1fr] px-5 py-2.5 text-sm border-t border-border-subtle ${
              i % 2 === 1 ? "bg-bg-card" : ""
            }`}
          >
            <span className={`text-text-secondary ${row.dawnOnly ? "font-semibold" : ""}`}>
              {row.label}
            </span>
            <span className="text-center text-text-muted font-mono text-xs">{row.nextjs}</span>
            <span
              className={`text-center font-mono text-xs ${
                row.dawnOnly ? "text-accent-green font-semibold text-sm" : "text-text-primary"
              }`}
            >
              {row.dawn}
            </span>
          </div>
        ))}
      </div>

      <p className="text-center mt-5 text-text-muted text-sm">
        Same conventions you already know. Purpose-built for AI agents.
      </p>
    </section>
  )
}
```

- [ ] **Step 2: Create SolutionSection component**

Create `apps/web/app/components/landing/SolutionSection.tsx`:
```tsx
const pillars = [
  {
    title: "Convention",
    body: "Routes, tools, state, config. Everything in the right place. If you know App Router, you know Dawn.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    title: "Type Safety",
    body: "Tool signatures extracted at build time. Full autocomplete. No manual type wiring.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    ),
  },
  {
    title: "Tooling",
    body: "Dev server with hot reload. CLI for running, testing, and validating. Vite-powered.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
]

export function SolutionSection() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">The Solution</p>
        <h2 className="text-3xl font-bold text-text-primary leading-snug">
          Dawn gives your agents
          <br />
          the structure they deserve.
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto mt-10">
        {pillars.map((pillar) => (
          <div key={pillar.title} className="text-center">
            <div className="w-12 h-12 rounded-[10px] bg-[#111] border border-[#222] flex items-center justify-center mx-auto mb-4 text-text-primary">
              {pillar.icon}
            </div>
            <h3 className="text-base font-semibold text-text-primary">{pillar.title}</h3>
            <p className="text-sm text-text-muted mt-2 leading-relaxed">{pillar.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Add sections to landing page**

Replace `apps/web/app/page.tsx` with:
```tsx
import { HeroSection } from "./components/landing/HeroSection"
import { ProblemSection } from "./components/landing/ProblemSection"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { SolutionSection } from "./components/landing/SolutionSection"

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ProblemSection />
      <ComparisonTable />
      <SolutionSection />
    </>
  )
}
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/components/landing/ComparisonTable.tsx apps/web/app/components/landing/SolutionSection.tsx
git commit -m "feat(web): add Comparison Table and Solution landing sections"
```

---

### Task 5: Landing page — Code Example section

**Files:**
- Create: `apps/web/app/components/landing/CodeExample.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Create CodeExample component**

Create `apps/web/app/components/landing/CodeExample.tsx`:
```tsx
export function CodeExample() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle bg-bg-secondary">
      <div className="text-center mb-10">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">See It</p>
        <h2 className="text-3xl font-bold text-text-primary">A Dawn app, typed end to end.</h2>
      </div>

      {/* Project tree */}
      <div className="max-w-3xl mx-auto mb-8">
        <div className="bg-bg-card border border-border rounded-lg p-5 font-mono text-sm leading-8 text-text-muted">
          <p className="text-text-secondary text-xs uppercase tracking-wide mb-2 font-sans font-semibold">
            Project Structure
          </p>
          <div>
            <span className="text-yellow-400">src/app/</span>
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-text-muted">(public)/</span>{" "}
            <span className="text-text-dim text-xs">&larr; route group, excluded from pathname</span>
          </div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;hello/</div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-purple-400">[tenant]/</span>{" "}
            <span className="text-text-dim text-xs">&larr; dynamic segment</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-blue-400">index.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; route entry (workflow | graph)</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-text-secondary">state.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; route state type</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-yellow-400">tools/</span>{" "}
            <span className="text-text-dim text-xs">&larr; co-located tools, auto-discovered</span>
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            <span className="text-green-400">greet.ts</span>{" "}
            <span className="text-text-dim text-xs">
              &larr; typed at build time via compiler API
            </span>
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-text-secondary">dawn.generated.d.ts</span>{" "}
            <span className="text-text-dim text-xs">&larr; auto-generated ambient types</span>
          </div>
          <div>
            <span className="text-text-secondary">dawn.config.ts</span>
          </div>
        </div>
      </div>

      {/* Code panels */}
      <div className="flex flex-col md:flex-row gap-4 max-w-3xl mx-auto">
        {/* Route entry */}
        <div className="flex-1 bg-bg-card border border-border rounded-lg p-4 font-mono text-xs leading-7 text-text-secondary overflow-hidden">
          <p className="text-text-muted text-[0.65rem] mb-3">
            src/app/(public)/hello/[tenant]/index.ts
          </p>
          <div>
            <span className="text-purple-400">import</span>{" "}
            <span className="text-yellow-400">type</span> {"{ "}
            <span className="text-yellow-400">RuntimeContext</span>
            {" } "}
            <span className="text-purple-400">from</span>{" "}
            <span className="text-green-400">&quot;@dawn-ai/sdk&quot;</span>
          </div>
          <div>
            <span className="text-purple-400">import</span>{" "}
            <span className="text-yellow-400">type</span> {"{ "}
            <span className="text-yellow-400">RouteTools</span>
            {" } "}
            <span className="text-purple-400">from</span>{" "}
            <span className="text-green-400">&quot;dawn:routes&quot;</span>
          </div>
          <div>
            <span className="text-purple-400">import</span>{" "}
            <span className="text-yellow-400">type</span> {"{ "}
            <span className="text-yellow-400">HelloState</span>
            {" } "}
            <span className="text-purple-400">from</span>{" "}
            <span className="text-green-400">&quot;./state.js&quot;</span>
          </div>
          <div className="mt-2">
            <span className="text-purple-400">export async function</span>{" "}
            <span className="text-blue-400">workflow</span>(
          </div>
          <div>
            &nbsp;&nbsp;state: <span className="text-yellow-400">HelloState</span>,
          </div>
          <div>
            &nbsp;&nbsp;ctx: <span className="text-yellow-400">RuntimeContext</span>&lt;
            <span className="text-yellow-400">RouteTools</span>&lt;
            <span className="text-green-400">&quot;/hello/[tenant]&quot;</span>&gt;&gt;
          </div>
          <div>{")"} {"{"}</div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">const</span> result ={" "}
            <span className="text-purple-400">await</span> ctx.tools.
            <span className="text-blue-400">greet</span>({"{"})
          </div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;tenant: state.tenant</div>
          <div>&nbsp;&nbsp;{"}"})</div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">return</span> {"{"} ...state, greeting:
            result.greeting {"}"}
          </div>
          <div>{"}"}</div>
        </div>

        {/* Tool + types */}
        <div className="flex-1 bg-bg-card border border-border rounded-lg p-4 font-mono text-xs leading-7 text-text-secondary overflow-hidden">
          <p className="text-text-muted text-[0.65rem] mb-3">tools/greet.ts</p>
          <div>
            <span className="text-purple-400">export default async</span> (input: {"{"}
          </div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">readonly</span> tenant:{" "}
            <span className="text-yellow-400">string</span>
          </div>
          <div>{"}"}) =&gt; {"{"}</div>
          <div>
            &nbsp;&nbsp;<span className="text-purple-400">return</span> {"{"}
          </div>
          <div>
            &nbsp;&nbsp;&nbsp;&nbsp;greeting:{" "}
            <span className="text-green-400">{"`Hello, ${"}</span>input.tenant
            <span className="text-green-400">{"}!`"}</span>
          </div>
          <div>&nbsp;&nbsp;{"}"}</div>
          <div>{"}"}</div>
          <div className="mt-6 border-t border-border pt-3">
            <p className="text-text-muted text-[0.65rem] mb-3">
              dawn.generated.d.ts{" "}
              <span className="text-text-dim">(auto-generated)</span>
            </p>
            <div>
              <span className="text-purple-400">declare module</span>{" "}
              <span className="text-green-400">&quot;dawn:routes&quot;</span> {"{"}
            </div>
            <div>
              &nbsp;&nbsp;<span className="text-purple-400">export type</span>{" "}
              <span className="text-yellow-400">RouteTools</span>&lt;P&gt; =
            </div>
            <div>
              &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-yellow-400">DawnRouteTools</span>[P]
            </div>
            <div>
              &nbsp;&nbsp;<span className="text-gray-500">// greet signature inferred</span>
            </div>
            <div>
              &nbsp;&nbsp;<span className="text-gray-500">// from tools/greet.ts export</span>
            </div>
            <div>{"}"}</div>
          </div>
        </div>
      </div>

      {/* CLI output */}
      <div className="max-w-3xl mx-auto mt-6">
        <div className="bg-bg-card border border-border rounded-lg p-4 font-mono text-sm leading-7">
          <p className="text-text-muted text-[0.65rem] mb-2 font-sans">Terminal</p>
          <div className="text-text-secondary">
            $ <span className="text-text-primary">dawn run &apos;/hello/acme&apos;</span>
          </div>
          <div className="text-text-muted mt-1">
            Route&nbsp;&nbsp;&nbsp; /hello/[tenant]
          </div>
          <div className="text-text-muted">Mode&nbsp;&nbsp;&nbsp;&nbsp; workflow</div>
          <div className="text-text-muted">Tenant&nbsp;&nbsp; acme</div>
          <div className="text-accent-green mt-1">
            &#10003; {"{"} greeting: &quot;Hello, acme!&quot; {"}"}
          </div>
        </div>
      </div>

      <p className="text-center mt-5 text-text-muted text-sm">
        Type-safe tools, inferred automatically. No manual type wiring. No Zod boilerplate.
      </p>
    </section>
  )
}
```

- [ ] **Step 2: Add to landing page**

Update `apps/web/app/page.tsx` to add the import and component:
```tsx
import { HeroSection } from "./components/landing/HeroSection"
import { ProblemSection } from "./components/landing/ProblemSection"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { SolutionSection } from "./components/landing/SolutionSection"
import { CodeExample } from "./components/landing/CodeExample"

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ProblemSection />
      <ComparisonTable />
      <SolutionSection />
      <CodeExample />
    </>
  )
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/components/landing/CodeExample.tsx
git commit -m "feat(web): add Code Example landing section"
```

---

### Task 6: Landing page — Deploy, Feature Grid, How It Works sections

**Files:**
- Create: `apps/web/app/components/landing/DeploySection.tsx`
- Create: `apps/web/app/components/landing/FeatureGrid.tsx`
- Create: `apps/web/app/components/landing/HowItWorks.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Create DeploySection component**

Create `apps/web/app/components/landing/DeploySection.tsx`:
```tsx
const steps = [
  {
    label: "Develop",
    commands: ["dawn dev", "dawn run", "dawn test"],
    accent: false,
  },
  {
    label: "Validate",
    commands: ["dawn check", "dawn typegen", "dawn routes"],
    accent: false,
  },
  {
    label: "Deploy",
    commands: ["LangGraph Platform", "LangSmith Assistants", "Your infrastructure"],
    accent: true,
  },
]

export function DeploySection() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">The Deploy Story</p>
        <h2 className="text-3xl font-bold text-text-primary leading-snug">
          Build locally.
          <br />
          Deploy to LangSmith.
        </h2>
        <p className="text-text-secondary mt-4 leading-7">
          Dawn owns your local development lifecycle. When you&apos;re ready to ship, your routes
          speak the LangGraph Platform protocol natively &mdash; deploy as LangSmith assistants with
          the infrastructure you already trust.
        </p>
      </div>

      {/* Pipeline */}
      <div className="max-w-[650px] mx-auto mt-10 flex items-center justify-center gap-0">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center">
            <div className="text-center flex-1 min-w-[140px]">
              <div
                className={`w-14 h-14 rounded-[10px] flex items-center justify-center mx-auto mb-3 ${
                  step.accent
                    ? "bg-gradient-to-br from-[#0a1a10] to-[#0a200a] border border-[#1a3a1a]"
                    : "bg-[#111] border border-[#222]"
                }`}
              >
                {i === 0 && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={step.accent ? "#00a67e" : "#fff"} strokeWidth="2">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                )}
                {i === 1 && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={step.accent ? "#00a67e" : "#fff"} strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                )}
                {i === 2 && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00a67e" strokeWidth="2">
                    <path d="M22 2L11 13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </div>
              <p className={`text-sm font-semibold ${step.accent ? "text-accent-green" : "text-text-primary"}`}>
                {step.label}
              </p>
              <div className="text-xs text-text-muted mt-1.5 leading-5">
                {step.commands.map((cmd) => (
                  <div key={cmd}>{cmd}</div>
                ))}
              </div>
            </div>
            {i < steps.length - 1 && (
              <span className="text-[#333] text-2xl mb-8 mx-2">&rarr;</span>
            )}
          </div>
        ))}
      </div>

      {/* Protocol note */}
      <div className="max-w-[550px] mx-auto mt-8 bg-bg-card border border-border rounded-lg px-5 py-4 flex gap-4 items-start">
        <span className="text-accent-green text-base mt-0.5">&#9432;</span>
        <p className="text-sm text-text-secondary leading-relaxed">
          Dawn&apos;s dev server speaks the{" "}
          <span className="text-text-primary">LangGraph Platform protocol</span> natively &mdash;{" "}
          <code className="text-xs text-text-secondary font-mono">/runs/wait</code>,{" "}
          <code className="text-xs text-text-secondary font-mono">/runs/stream</code>,{" "}
          <code className="text-xs text-text-secondary font-mono">assistant_id</code> routing. What
          runs locally deploys without translation.
        </p>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Create FeatureGrid component**

Create `apps/web/app/components/landing/FeatureGrid.tsx`:
```tsx
const features = [
  {
    title: "File-system Routing",
    body: "Routes map to directories. Route groups, dynamic segments, catch-all params. Same conventions as Next.js App Router.",
  },
  {
    title: "Type-safe Tools",
    body: "Tool types inferred from source via the TypeScript compiler API. Full autocomplete. Zero manual wiring.",
  },
  {
    title: "Vite Dev Server",
    body: "Hot reload on tool and route changes. Parent-child process architecture for clean restarts.",
  },
  {
    title: "Scenario Testing",
    body: "Co-located test scenarios with expected outputs. Run against in-process, CLI, or dev server.",
  },
  {
    title: "Pluggable Backends",
    body: "LangGraph graphs, LangGraph workflows, LangChain LCEL chains. One framework, multiple execution modes.",
  },
  {
    title: "Dawn CLI",
    body: "check, routes, typegen, run, test, dev. Everything from one command. No config sprawl.",
  },
]

export function FeatureGrid() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle bg-bg-secondary">
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold text-text-primary">Everything you need.</h2>
        <p className="text-text-muted mt-2">And nothing you don&apos;t.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-[650px] mx-auto">
        {features.map((feature) => (
          <div key={feature.title} className="bg-bg-card border border-border rounded-lg p-5">
            <h3 className="text-sm font-semibold text-text-primary">{feature.title}</h3>
            <p className="text-sm text-text-muted mt-2 leading-relaxed">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Create HowItWorks component**

Create `apps/web/app/components/landing/HowItWorks.tsx`:
```tsx
const steps = [
  {
    number: 1,
    title: "Scaffold",
    content: (
      <code className="font-mono text-xs text-text-muted bg-bg-card px-3 py-1.5 rounded border border-border inline-block mt-1.5">
        npx create-dawn-app my-agent
      </code>
    ),
  },
  {
    number: 2,
    title: "Write a route",
    content: (
      <p className="text-sm text-text-muted mt-1.5 leading-relaxed">
        Export a <code className="font-mono text-text-secondary">workflow</code>,{" "}
        <code className="font-mono text-text-secondary">graph</code>, or{" "}
        <code className="font-mono text-text-secondary">chain</code> from your route&apos;s
        index.ts. Add tools in a tools/ directory.
      </p>
    ),
  },
  {
    number: 3,
    title: "Run it",
    content: (
      <code className="font-mono text-xs text-text-muted bg-bg-card px-3 py-1.5 rounded border border-border inline-block mt-1.5">
        dawn run &apos;/hello/acme&apos;
      </code>
    ),
  },
  {
    number: 4,
    title: "Test & iterate",
    content: (
      <>
        <code className="font-mono text-xs text-text-muted bg-bg-card px-3 py-1.5 rounded border border-border inline-block mt-1.5">
          dawn dev
        </code>
        <p className="text-sm text-text-muted mt-1.5 leading-relaxed">
          Hot reload. Change tools, see results instantly.
        </p>
      </>
    ),
  },
]

export function HowItWorks() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle">
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold text-text-primary">Up and running in 30 seconds.</h2>
      </div>

      <div className="max-w-md mx-auto space-y-8">
        {steps.map((step) => (
          <div key={step.number} className="flex gap-5 items-start">
            <div className="w-8 h-8 rounded-full bg-[#181818] text-text-primary flex items-center justify-center text-sm font-bold shrink-0">
              {step.number}
            </div>
            <div>
              <h3 className="text-base font-semibold text-text-primary">{step.title}</h3>
              {step.content}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Add all three to landing page**

Replace `apps/web/app/page.tsx` with:
```tsx
import { HeroSection } from "./components/landing/HeroSection"
import { ProblemSection } from "./components/landing/ProblemSection"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { SolutionSection } from "./components/landing/SolutionSection"
import { CodeExample } from "./components/landing/CodeExample"
import { DeploySection } from "./components/landing/DeploySection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HowItWorks } from "./components/landing/HowItWorks"

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ProblemSection />
      <ComparisonTable />
      <SolutionSection />
      <CodeExample />
      <DeploySection />
      <FeatureGrid />
      <HowItWorks />
    </>
  )
}
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/components/landing/DeploySection.tsx apps/web/app/components/landing/FeatureGrid.tsx apps/web/app/components/landing/HowItWorks.tsx
git commit -m "feat(web): add Deploy, Feature Grid, and How It Works landing sections"
```

---

### Task 7: Landing page — Ecosystem and CTA sections

**Files:**
- Create: `apps/web/app/components/landing/EcosystemSection.tsx`
- Create: `apps/web/app/components/landing/CtaSection.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Create EcosystemSection component**

Create `apps/web/app/components/landing/EcosystemSection.tsx`:
```tsx
const packages = [
  {
    name: "@dawn-ai/langgraph",
    accent: true,
    body: "Backend adapter for LangGraph graphs and workflows. Native execution.",
  },
  {
    name: "@dawn-ai/langchain",
    accent: true,
    body: "Adapter for LCEL chains. Convert Dawn tools to LangChain tools automatically.",
  },
  {
    name: "@dawn-ai/sdk",
    accent: false,
    body: "Backend-neutral contract. RuntimeContext, tools, route config. Bring any adapter.",
  },
]

export function EcosystemSection() {
  return (
    <section className="py-16 px-8 border-t border-border-subtle bg-bg-secondary">
      <div className="text-center max-w-2xl mx-auto">
        <p className="text-text-muted text-xs uppercase tracking-widest mb-3">Ecosystem</p>
        <h2 className="text-xl font-bold text-text-primary leading-snug">
          Built for the LangChain ecosystem.
        </h2>
        <p className="text-text-secondary mt-3 leading-7">
          Dawn is a meta-framework for LangGraph and LangChain. Use the tools and models you already
          know.
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 max-w-[650px] mx-auto mt-8 justify-center">
        {packages.map((pkg) => (
          <div
            key={pkg.name}
            className="flex-1 bg-bg-card border border-border rounded-lg p-5 text-center"
          >
            <p
              className={`text-base font-bold mb-2 ${
                pkg.accent
                  ? "text-accent-green"
                  : "text-text-muted border border-dashed border-[#333] rounded inline-block px-2"
              }`}
            >
              {pkg.name}
            </p>
            <p className="text-sm text-text-muted leading-relaxed">{pkg.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Create CtaSection component**

Create `apps/web/app/components/landing/CtaSection.tsx`:
```tsx
import Link from "next/link"

export function CtaSection() {
  return (
    <section className="py-20 px-8 border-t border-border-subtle text-center">
      <h2 className="text-4xl font-extrabold text-text-primary tracking-tight">Ready to build?</h2>
      <p className="text-text-muted mt-3 text-base max-w-md mx-auto leading-relaxed">
        Give your AI agents the structure they deserve.
      </p>

      <div className="mt-8 flex gap-3 justify-center">
        <Link
          href="/docs/getting-started"
          className="px-8 py-3 bg-text-primary text-bg-primary rounded-md text-sm font-semibold hover:bg-gray-200 transition-colors"
        >
          Get Started
        </Link>
        <a
          href="https://github.com/anthropics/dawn"
          target="_blank"
          rel="noopener noreferrer"
          className="px-8 py-3 border border-[#333] text-text-secondary rounded-md text-sm hover:border-[#555] transition-colors"
        >
          View on GitHub
        </a>
      </div>

      <div className="mt-6 font-mono text-sm text-text-muted bg-bg-card inline-block px-5 py-2.5 rounded-md border border-border">
        npx create-dawn-app my-agent
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Complete the landing page with all 10 sections**

Replace `apps/web/app/page.tsx` with:
```tsx
import { HeroSection } from "./components/landing/HeroSection"
import { ProblemSection } from "./components/landing/ProblemSection"
import { ComparisonTable } from "./components/landing/ComparisonTable"
import { SolutionSection } from "./components/landing/SolutionSection"
import { CodeExample } from "./components/landing/CodeExample"
import { DeploySection } from "./components/landing/DeploySection"
import { FeatureGrid } from "./components/landing/FeatureGrid"
import { HowItWorks } from "./components/landing/HowItWorks"
import { EcosystemSection } from "./components/landing/EcosystemSection"
import { CtaSection } from "./components/landing/CtaSection"

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <ProblemSection />
      <ComparisonTable />
      <SolutionSection />
      <CodeExample />
      <DeploySection />
      <FeatureGrid />
      <HowItWorks />
      <EcosystemSection />
      <CtaSection />
    </>
  )
}
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/components/landing/EcosystemSection.tsx apps/web/app/components/landing/CtaSection.tsx
git commit -m "feat(web): add Ecosystem and CTA landing sections — landing page complete"
```

---

### Task 8: Docs layout and Getting Started page

**Files:**
- Modify: `apps/web/app/docs/layout.tsx`
- Modify: `apps/web/app/docs/getting-started/page.tsx`
- Create: `apps/web/content/docs/getting-started.mdx`
- Delete: `apps/web/app/docs/app-graph/page.tsx`
- Delete: `apps/web/app/docs/cli/page.tsx`
- Delete: `apps/web/app/docs/examples/page.tsx`
- Delete: `apps/web/app/docs/packages/page.tsx`
- Delete: `apps/web/app/docs/page.tsx`
- Delete: `apps/web/app/robots.ts`
- Delete: `apps/web/app/sitemap.ts`

- [ ] **Step 1: Remove old docs pages and utility files**

```bash
rm apps/web/app/docs/app-graph/page.tsx
rm apps/web/app/docs/cli/page.tsx
rm apps/web/app/docs/examples/page.tsx
rm apps/web/app/docs/packages/page.tsx
rm apps/web/app/docs/page.tsx
rm apps/web/app/robots.ts
rm apps/web/app/sitemap.ts
rmdir apps/web/app/docs/app-graph
rmdir apps/web/app/docs/cli
rmdir apps/web/app/docs/examples
rmdir apps/web/app/docs/packages
```

- [ ] **Step 2: Rewrite docs layout**

Replace `apps/web/app/docs/layout.tsx` with:
```tsx
import Link from "next/link"
import type { ReactNode } from "react"

const docsNav = [{ href: "/docs/getting-started", label: "Getting Started" }]

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-5xl mx-auto px-8 py-12 flex gap-12">
      <aside className="w-56 shrink-0">
        <p className="text-xs text-text-muted uppercase tracking-widest mb-4">Documentation</p>
        <nav className="space-y-2">
          {docsNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block text-sm text-text-secondary hover:text-text-primary transition-colors px-3 py-2 rounded-md hover:bg-bg-card"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <section className="flex-1 min-w-0">{children}</section>
    </div>
  )
}
```

- [ ] **Step 3: Create Getting Started MDX content**

Create directory and file:
```bash
mkdir -p apps/web/content/docs
```

Create `apps/web/content/docs/getting-started.mdx`:
```mdx
# Getting Started

Dawn is a TypeScript-first framework for building graph-based AI agent systems. This guide gets you from zero to a running agent route in under a minute.

## Prerequisites

- **Node.js** 22.12.0 or later
- **pnpm** (recommended) or npm

## Scaffold a new app

```bash
npx create-dawn-app my-agent
cd my-agent
pnpm install
```

This creates a project with the standard Dawn structure:

```
my-agent/
├── dawn.config.ts
├── package.json
├── tsconfig.json
└── src/app/
    ├── (public)/
    │   └── hello/
    │       └── [tenant]/
    │           ├── index.ts        # Route entry
    │           ├── state.ts        # Route state type
    │           └── tools/
    │               └── greet.ts    # Co-located tool
    └── dawn.generated.d.ts         # Auto-generated types
```

## Understand the route

Each route is a directory under `src/app/` with an `index.ts` that exports exactly one of:

- **`workflow`** — an async function that receives state and a typed context
- **`graph`** — a LangGraph graph instance
- **`chain`** — a LangChain LCEL Runnable

The scaffolded app uses a `workflow` export:

```typescript
import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>
) {
  const result = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: result.greeting }
}
```

The `RouteTools<"/hello/[tenant]">` type is auto-generated from the tool files in the `tools/` directory. You get full autocomplete for `ctx.tools.greet()` with zero manual wiring.

## Add a tool

Tools live in a `tools/` directory inside a route. Each tool is a TypeScript file with a default export:

```typescript
// src/app/(public)/hello/[tenant]/tools/greet.ts
export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

Dawn extracts the input and output types at build time using the TypeScript compiler API, then writes them to `dawn.generated.d.ts`. No Zod schemas, no manual type declarations.

## Run your agent

```bash
dawn run '/hello/acme'
```

Dawn discovers the route matching `/hello/acme`, resolves `[tenant]` to `"acme"`, and executes the workflow. You should see:

```
Route    /hello/[tenant]
Mode     workflow
Tenant   acme
✓ { greeting: "Hello, acme!" }
```

## Start the dev server

For iterative development with hot reload:

```bash
dawn dev
```

The dev server watches for file changes and restarts automatically. It exposes the same endpoints used by the LangGraph Platform — `/runs/wait` and `/runs/stream` — so what works locally works in production.

## What's next

- Explore the [Dawn GitHub repository](https://github.com/anthropics/dawn) for the full source
- Read the template code in `src/app/` to understand route conventions
- Try adding a new route directory with its own tools
```

- [ ] **Step 4: Update Getting Started page to render MDX**

Replace `apps/web/app/docs/getting-started/page.tsx` with:
```tsx
import type { Metadata } from "next"
import GettingStarted from "../../../content/docs/getting-started.mdx"

export const metadata: Metadata = {
  title: "Getting Started",
}

export default function GettingStartedPage() {
  return (
    <article className="prose-dawn">
      <GettingStarted />
    </article>
  )
}
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds. If the MDX import fails, check that `pageExtensions` in `next.config.ts` includes `"mdx"` and that `mdx-components.tsx` is at the app root.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/app/docs/ apps/web/content/ apps/web/app/robots.ts apps/web/app/sitemap.ts
git commit -m "feat(web): add docs layout and Getting Started page with MDX content"
```

---

### Task 9: Visual polish and dev server verification

**Files:**
- Possibly modify: any component files from Tasks 2-8

- [ ] **Step 1: Start dev server**

```bash
cd apps/web && pnpm dev
```

Open `http://localhost:3000` in a browser.

- [ ] **Step 2: Verify landing page renders all 10 sections**

Scroll through the page and confirm:
1. Hero with badge, headline, CTAs, install command, trust strip
2. Problem with 4 pain-point cards
3. Comparison table (Next.js vs Dawn, 8 rows)
4. Solution with 3 pillars
5. Code example with project tree, code panels, CLI output
6. Deploy pipeline with 3-step visual and protocol callout
7. Feature grid with 6 cards
8. How it works with 4 steps
9. Ecosystem with 3 package cards
10. CTA with buttons and install command

Fix any visual issues (spacing, colors, overflow, broken layouts).

- [ ] **Step 3: Verify docs page**

Navigate to `http://localhost:3000/docs/getting-started`. Confirm:
- Sidebar renders with "Getting Started" link
- MDX content renders with proper typography
- Code blocks render with monospace font and dark background
- Internal links work

Fix any rendering issues.

- [ ] **Step 4: Verify full build succeeds**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web build
```

Expected: Build succeeds with no errors.

- [ ] **Step 5: Verify typecheck passes**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web typecheck
```

Expected: No type errors.

- [ ] **Step 6: Verify lint passes**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/web lint
```

Expected: No lint errors. Fix any that appear.

- [ ] **Step 7: Commit any fixes**

If any fixes were needed:
```bash
git add apps/web/
git commit -m "fix(web): visual polish and build fixes"
```

If no fixes needed, skip this step.

---

### Task 10: Verify CI pipeline passes

- [ ] **Step 1: Run full CI validation**

```bash
cd /Users/blove/repos/dawn && pnpm ci:validate
```

Expected: All steps pass. The website is a new app in the workspace, so turbo should pick it up automatically via the `apps/*` workspace pattern.

- [ ] **Step 2: Fix any CI failures**

If lint, typecheck, build, or test steps fail for the web app, fix the issues and commit.

- [ ] **Step 3: Final commit if needed**

```bash
git add -A
git commit -m "fix(web): resolve CI issues"
```
