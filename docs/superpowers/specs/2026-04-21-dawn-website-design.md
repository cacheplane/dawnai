# Dawn Website Design

## Goal

Build a Dawn framework website with a marketing landing page and skeleton documentation, living inside the monorepo at `apps/website/`. The site establishes Dawn's positioning as "The App Router for AI agents" and provides a Getting Started guide for new users.

## Problem

Dawn has no web presence. Developers discovering the framework have only the README and source code. There's no landing page to communicate what Dawn is, how it compares to what they already know, or how to get started. The LangChain ecosystem relationship and meta-framework positioning need a visual home.

## Design

### Positioning

Everything on the site orbits this sentence:

> **Dawn is the App Router for AI agents.**

Expanded: Dawn is a TypeScript-first framework for building and deploying graph-based AI systems with the ergonomics of Next.js.

This framing targets: frontend engineers, full-stack TypeScript developers, and teams already using LangGraph but struggling with structure.

### Tech Stack

| Choice | Rationale |
|--------|-----------|
| **Next.js App Router** | Mirrors Dawn's own conventions; dogfooding the mental model |
| **Tailwind CSS** | Rapid styling, design token consistency |
| **MDX via @next/mdx** | Docs content as Markdown with embedded components |
| **TypeScript** | Matches the monorepo |

The website lives at `apps/website/` in the Dawn monorepo. It is a standalone Next.js app with no dependency on Dawn packages — it's a marketing site, not a Dawn app.

### Visual Style

**Clean & Minimal** — Vercel/Linear aesthetic:
- Dark mode default (`#000` background)
- Monochrome palette with white text on dark
- Single accent color: LangChain green (`#00a67e`) for ecosystem trust signals
- Sharp typography, generous whitespace
- Monospace code blocks with One Dark syntax highlighting
- Subtle borders (`#1a1a1a`), no heavy shadows

### Landing Page Structure

10 sections in a single-page story arc:

#### Section 1: Hero
- "Built for the LangChain ecosystem" badge
- "The App Router for AI agents." headline
- Expanded subtitle with key value props
- Get Started + GitHub CTAs
- `npx create-dawn-app my-agent` install command
- Trust strip: LangGraph, LangChain, TypeScript, Vite

#### Section 2: Problem
- "Building agents with raw LangGraph is like building React apps before Next.js."
- Four pain-point cards: project structure, tool typing, local testing, deployment

#### Section 3: Meta-Framework Comparison
- "You already know this story." — React got Next.js, Svelte got SvelteKit, LangGraph got Dawn
- Side-by-side comparison table: Next.js conventions vs Dawn conventions
  - File-system routing: `app/page.tsx` ↔ `src/app/index.ts`
  - Dynamic segments: `[slug]` ↔ `[tenant]`
  - Route groups: `(marketing)` ↔ `(public)`
  - Generated types: `.next/types/` ↔ `dawn.generated.d.ts`
  - Dev server: `next dev` ↔ `dawn dev`
  - Scaffold CLI: `create-next-app` ↔ `create-dawn-app`
  - Dawn-only: Co-located tools with type inference, built-in scenario testing

#### Section 4: Solution
- "Dawn gives your agents the structure they deserve."
- Three pillars: Convention, Type Safety, Tooling

#### Section 5: Code Example
- Annotated project tree showing `src/app/` structure with route groups, dynamic segments, co-located tools, generated types
- Side-by-side code panels: route entry (`index.ts`) and tool (`greet.ts`) with generated type declarations
- CLI output showing `dawn run '/hello/acme'`
- Code uses real Dawn template code, not pseudocode

#### Section 6: Deployment Story
- "Build locally. Deploy to LangSmith."
- Three-step pipeline visual: Develop (`dawn dev/run/test`) → Validate (`dawn check/typegen/routes`) → Deploy (LangGraph Platform / LangSmith Assistants)
- Callout: Dawn's dev server speaks the LangGraph Platform protocol natively (`/runs/wait`, `/runs/stream`, `assistant_id` routing)
- Honest framing: Dawn owns local development lifecycle; deployment uses the LangGraph Platform infrastructure

#### Section 7: Feature Grid
- 2-column grid, 6 features:
  1. File-system Routing — same conventions as Next.js App Router
  2. Type-safe Tools — inferred via TypeScript compiler API
  3. Vite Dev Server — hot reload, parent-child process architecture
  4. Scenario Testing — co-located test scenarios with expected outputs
  5. Pluggable Backends — LangGraph graphs/workflows, LangChain LCEL chains
  6. Dawn CLI — check, routes, typegen, run, test, dev

#### Section 8: How It Works
- Vertical 4-step flow: Scaffold → Write a route → Run it → Test & iterate

#### Section 9: Ecosystem Trust
- "Built for the LangChain ecosystem."
- Three package cards showing Dawn's adapter architecture:
  - `@dawn/langgraph` — backend adapter for LangGraph graphs and workflows
  - `@dawn/langchain` — adapter for LCEL chains, automatic tool conversion
  - `@dawn/sdk` — backend-neutral contract (RuntimeContext, tools, route config)

#### Section 10: Footer CTA
- "Ready to build?" with Get Started + GitHub buttons
- Repeated install command

### Documentation

**Scope: Getting Started page only.** The docs skeleton is intentionally minimal — just enough to onboard a new user. More docs pages will be added as the framework matures.

#### Docs Layout
- `/docs` route with a sidebar navigation component
- Sidebar shows section headings (just "Getting Started" initially, expandable later)
- Main content area renders MDX

#### Getting Started Content
Located at `content/docs/getting-started.mdx`, covers:

1. **Install** — `npx create-dawn-app my-agent` with prerequisites (Node.js, pnpm)
2. **Project structure** — annotated tree of the scaffolded app
3. **Write a route** — explain `index.ts` exports (`workflow`, `graph`, `chain`), the `state.ts` convention, and `tools/` directory
4. **Add a tool** — create a tool in `tools/`, show how types are auto-generated
5. **Run it** — `dawn run '/hello/acme'` with expected output
6. **Dev server** — `dawn dev` for hot reload development
7. **Next steps** — links to GitHub, API reference (future)

#### Docs Components
- `DocsSidebar` — navigation with active state, expandable sections
- `MdxRenderer` — renders MDX content with custom component mappings (code blocks, callouts)
- Shared `Header` component between landing and docs

### File Structure

```
apps/website/
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── public/
├── content/
│   └── docs/
│       └── getting-started.mdx
└── src/
    └── app/
        ├── layout.tsx              # Root layout (dark theme, fonts)
        ├── page.tsx                # Landing page
        ├── globals.css             # Tailwind imports + custom tokens
        └── docs/
            ├── layout.tsx          # Docs layout (sidebar + content area)
            └── getting-started/
                └── page.tsx        # Renders getting-started.mdx
    └── components/
        ├── Header.tsx              # Shared nav (dawn logo, Docs, GitHub, Get Started)
        ├── Footer.tsx              # Shared footer
        ├── landing/
        │   ├── HeroSection.tsx
        │   ├── ProblemSection.tsx
        │   ├── ComparisonTable.tsx
        │   ├── SolutionSection.tsx
        │   ├── CodeExample.tsx
        │   ├── DeploySection.tsx
        │   ├── FeatureGrid.tsx
        │   ├── HowItWorks.tsx
        │   ├── EcosystemSection.tsx
        │   └── CtaSection.tsx
        └── docs/
            ├── DocsSidebar.tsx
            └── MdxRenderer.tsx
```

### Design Tokens

Defined in `globals.css` or Tailwind config:

```
--bg-primary: #000000
--bg-secondary: #050505
--bg-card: #0a0a0a
--border: #1a1a1a
--border-subtle: #111111
--text-primary: #ffffff
--text-secondary: #888888
--text-muted: #555555
--text-dim: #444444
--accent-green: #00a67e          (LangChain ecosystem)
--accent-blue: #3178c6           (TypeScript)
--font-mono: JetBrains Mono, monospace
```

### Code Syntax Theme

One Dark-inspired palette for inline code examples:
- Keywords: `#c678dd` (purple)
- Functions: `#61afef` (blue)
- Strings: `#98c379` (green)
- Types: `#e5c07b` (yellow)
- Comments: `#546e7a` (gray)

## Out of Scope

- Multiple docs pages beyond Getting Started
- Search functionality
- Blog or changelog
- Analytics or telemetry
- Custom domain or deployment config
- Dark/light mode toggle (dark only)
- Mobile-responsive design (desktop-first, basic mobile support via Tailwind)
- i18n
