# Hero + Identity Rewrite — Design

**Date:** 2026-05-11
**Status:** Approved
**Scope:** apps/web — `HeroSection.tsx`, root `layout.tsx` (SEO), small consistency fixes

## Problem

Dawn's current landing hero positions the framework generically ("The App Router for AI agents.") and doesn't name LangGraph anywhere visible. GTM research recommends a sharper positioning: Dawn is the TypeScript meta-framework for LangGraph.js, not "another agent framework." Without the LangGraph anchor in the headline, the hero misses its highest-intent audience (developers already using LangGraph.js who feel the boilerplate pain) and competes vaguely with broader agent frameworks (Mastra, VoltAgent, Vercel AI SDK).

Additional drift: the install command in the hero (`npx create-dawn-app my-agent`) doesn't match the canonical command used in the docs (`pnpm create dawn-ai-app my-agent`); the page `<title>` is generic; the ecosystem badge overlaps the new headline signal.

## Goals

- Lead the hero with the explicit positioning: **"Build LangGraph agents like Next.js apps."**
- Enumerate Dawn's concrete additions in the sub-headline so readers can self-qualify before they scroll.
- Anchor the abstraction in a small, canonical code example below the install command.
- Fix the install-command inconsistency. The whole site uses one command.
- Update the SEO `<title>` and meta description to match the new positioning.

## Non-goals

- "Who Dawn is for" and "Dawn is not…" sections — those land in batch B (separate brainstorm).
- Migration-as-primary-CTA — batch C.
- Comparison pages (`/compare/dawn-vs-X`) — separate work.
- Character/dialog landing section — a separate, later brainstorm.
- Any product/API changes — the canonical state shape stays as `state.ts` exporting a Zod schema. The hero code follows the actual API.

## Approach

### New hero structure

Top to bottom inside `HeroSection.tsx`:

1. ~~Ecosystem badge~~ — **removed**. Headline does the same work; LogoWall below the hero carries the ecosystem signal visually.
2. **Headline** (display, large):
   > **Build LangGraph agents like Next.js apps.**
3. **Sub-headline** (~max-w-2xl, leading-relaxed):
   > Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. **Keep the runtime. Drop the boilerplate.**
   The "Keep the runtime. Drop the boilerplate." sentence is bolded (or carries weight via `text-text-primary` vs the muted body) — addresses lock-in fear inline.
4. **CTAs** (centered row):
   - Primary: **Copy prompt** (current `CopyPromptButton` with `variant="hero"`, scaffold prompt — unchanged)
   - Secondary: **Read the docs** — replaces the current GitHub link. Links to `/docs/getting-started`. GitHub remains accessible via the navbar icon (already shipped).
5. **Install command** (`CopyCommand`):
   - `pnpm create dawn-ai-app my-agent` (canonical — fixes the current `npx create-dawn-app my-agent` inconsistency)
6. **Two-file `CodeGroup`** (NEW — below the install command, max-w container, centered):
   - Tab 1 — `state.ts`:
     ```ts
     import { z } from "zod"

     export default z.object({
       tenant: z.string(),
       question: z.string(),
     })
     ```
   - Tab 2 — `index.ts`:
     ```ts
     import { agent } from "@dawn-ai/sdk"

     export default agent({
       model: "openai:gpt-4o-mini",
       systemPrompt: "Answer for {tenant}.",
     })
     ```
   - Tab labels are the file paths (`src/app/(public)/support/state.ts` / `src/app/(public)/support/index.ts`) — same `<CodeGroup>` pattern already established across docs.
   - The two files demonstrate Dawn's canonical convention: state is a Zod default-export sibling to the agent file; the agent itself doesn't reference state — Dawn discovers it via folder co-location.

### SEO updates

`apps/web/app/layout.tsx` metadata:

- `<title>`: `"Dawn — TypeScript meta-framework for LangGraph.js"`
- Meta description: `"Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate."`
- Open Graph + Twitter card meta should also pick up the new headline and description.

### Voice rules

- Short, declarative sentences
- No hedge words
- No marketing superlatives ("blazingly fast", "magical")
- Anti-lock-in kicker ("Keep the runtime. Drop the boilerplate.") earns its place — answers the implicit question "is this a wrapper that traps me?"

## Architecture

```
apps/web/
├── app/
│   ├── components/landing/
│   │   └── HeroSection.tsx           # rewrite
│   └── layout.tsx                    # title + description update
```

`HeroSection.tsx` keeps its current parallax background and outer `<section>` structure. The badge `<div>` is removed. Sub-headline copy is rewritten. CTAs row swaps the GitHub anchor for a `Link` to `/docs/getting-started`. `CopyCommand` prop updated. A `<CodeGroup>` is added below the install command — same component already registered as an MDX component and used across the docs site; here it's imported and used directly as a JSX child (it's a client component, the surrounding `HeroSection` stays a server component as long as nothing else changes — verify during implementation).

If `CodeGroup` requires MDX wrapping (currently registered via `useMDXComponents`), the implementation may need to either:
- Use `CodeGroup` directly as a React component (likely works since it accepts standard React children — verify), or
- Refactor a tiny `HeroCodeShowcase` client component that constructs the same chrome inline (one tab, then two tabs, same TabPill + CopyButton from the shared CodeBlock module).

Default: try direct usage; fall back to the small inline component only if the direct usage hits a render issue.

### Install command consistency sweep

While editing, audit and fix any remaining `npx create-dawn-app` references on the landing or in components. Canonical: `pnpm create dawn-ai-app my-agent`. The docs already use the canonical form (verified during the Getting Started rewrite).

## Testing

- `pnpm --filter @dawn-ai/web build`, `typecheck`, `lint` all pass.
- `scripts/check-docs.mjs` still passes (no doc text removed).
- Manual smoke at `/` desktop (1440x900):
  - Hero shows new headline + sub, no ecosystem badge.
  - Copy prompt + Read the docs CTAs render correctly; Read the docs links to `/docs/getting-started`.
  - Install command shows `pnpm create dawn-ai-app my-agent`.
  - Two-file CodeGroup renders below the install command with both tabs working.
- Mobile (390x844):
  - Headline wraps without breaking layout.
  - Two-file CodeGroup fits and is scrollable horizontally if any line overflows.
- Browser tab title reads "Dawn — TypeScript meta-framework for LangGraph.js".

## Migration risk

Low. Two-file edits to landing + layout. No URL changes. The "Read the docs" CTA points at an existing page. Install command change matches the canonical command already used throughout docs. No other components depend on the hero's current copy.

## Open items deferred to plan

- Whether the two-file `CodeGroup` works imported directly into a server-rendered hero, or needs a small inline wrapper. Default: try direct, fall back if needed.
- Whether the hero looks visually too tall after adding the CodeGroup. Default: ship as-is; tweak via Chrome validation. If it pushes the install command below the fold on common laptop screens, consider reducing vertical paddings or shrinking the CodeGroup typography.
- Whether to surface a small "Open in Codeflow" or "Try in StackBlitz" link near the CodeGroup. Out of scope — defer to a future hero polish.

## Research grounding

GTM positioning recommendations sourced from the user's Dawn GTM & Positioning Research document (in conversation, not yet committed). Top-line claims that this design implements:

1. **Lead positioning** — "Build LangGraph agents like Next.js apps." (research §"Primary Headline")
2. **Sub-headline enumeration** — file-system routes, route-local tools, generated types, HMR (research §"Subheadline")
3. **Canonical install command** — `pnpm create dawn-ai-app my-agent` (research §"Fix CLI Consistency")
4. **Lead with `agent()` not `workflow()`** — the hero code uses `agent({ model, systemPrompt })` (research §"Lead With agent() Not workflow()")
5. **SEO title** — "Dawn — TypeScript meta-framework for LangGraph.js" (research §"Brand Risk")

Items deferred to later batches:
- "Who Dawn is for" section (research §"ICP")
- "Dawn is not…" trust section (research §"What Dawn Should NOT Be")
- Migration CTA promotion (research §"Make Migration a Primary CTA")
- "No Zod boilerplate" wording fix (research §"Clarify the 'No Zod Boilerplate' Messaging")
- Comparison pages and SEO wedge content (research §"SEO Strategy")
- AI Coding Assistant strategy surfaces (research §"AI Coding Assistant Strategy")
