# Positioning & Messaging Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Dawn's positioning across the README/npm, landing page, and docs — leaning into durable-by-default and surfacing the workflow/agent route duality — without changing any runtime behavior.

**Architecture:** Copy + two new static landing-section React components. Four canonical messaging constants (M1–M4, from the design spec) are reused verbatim across surfaces. The website hero headline is preserved; durability and the route-shape duality are layered in as new sections + a hero subhead tweak. The unused `CopyPromptButton` is wired into the hero and registered for docs. No source/runtime code under `packages/*/src` changes.

**Tech Stack:** Markdown (README/docs), MDX (`apps/web/content/docs`), React + Tailwind (Next.js `apps/web`), Biome, `next build`, `tsc --noEmit`, `node scripts/check-docs.mjs`, `pnpm pack:check`.

**Design spec:** `docs/superpowers/specs/2026-06-19-positioning-messaging-refresh-design.md`

**Testing note:** This is a copy/marketing-component change. There is no meaningful unit-test surface — do **not** invent render tests for static copy. Verification is: the affected workspace typechecks, lints, and builds; the docs/link gate and pack check pass; and grep guardrails confirm the accuracy constraints. Those gates are Task 6.

**Canonical constants (use verbatim):**

- **M4 (coding-agent scaffold prompt):**
  `Scaffold a new Dawn app and help me build an agent. Dawn is the TypeScript meta-framework for LangGraph — agents and workflows are file-system routes with route-local tools, generated types, and durable threads. Run \`pnpm create dawn-ai-app\` to scaffold, then read https://dawnai.org/AGENTS.md and https://dawnai.org/llms-full.txt for the full framework reference before writing any routes.`

---

## Task 1: Root README + Tier-1 npm READMEs — unified messaging

**Files:**
- Modify: `README.md`
- Modify: `packages/sdk/README.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/create-dawn-app/README.md`
- Modify: `packages/langchain/README.md`

- [ ] **Step 1: Replace the root README tagline (line 11)**

Replace this exact line:

```md
The TypeScript meta-framework for LangGraph. Author AI agents and workflows as filesystem routes, get end-to-end types and a local dev server for free, and deploy to LangSmith with one command.
```

with (M1):

```md
Build LangGraph agents like Next.js apps. Dawn is the TypeScript meta-framework for LangGraph — author AI agents and workflows as filesystem routes with route-local tools, generated types, durable threads, and an HMR dev server. Keep the runtime, drop the boilerplate.
```

- [ ] **Step 2: Add durability + duality to the root README "Why Dawn?" list**

In `README.md`, the `## Why Dawn?` list currently has four bullets ending with the `**Typed end to end (TypeScript).**` bullet. Insert these two new bullets immediately after the `**Typed end to end (TypeScript).**` bullet:

```md
- **Durable by default.** Every Dawn app ships a working SQLite checkpointer and thread store — no setup. Threads survive a `dawn dev` restart, and an agent that pauses for human input resumes exactly where it left off. LangGraph defines the checkpoint interface; Dawn ships the default implementation.
- **Two ways to drive the model.** A route exports one of `agent` (LLM picks tools at runtime, can pause for a human), `workflow` (deterministic typed async function when you own the order), `graph`, or `chain`. Same routing, same types, same dev loop — you choose who's in charge.
```

- [ ] **Step 3: Realign each Tier-1 package README opening sentence**

Apply these exact replacements (one descriptive sentence each; do not touch the rest of these files):

`packages/sdk/README.md` — replace:

```md
The author-facing TypeScript SDK for Dawn, the meta-framework for LangGraph. Use it to declare AI agent routes, define request middleware, and type the runtime context, tools, and route metadata that the Dawn CLI consumes. Ships small runtime helpers (`agent()`, `defineMiddleware()`, `allow()`, `reject()`, `isDawnAgent()`) alongside the type primitives — it is the canonical entry point for authoring Dawn routes.
```

with:

```md
The author-facing TypeScript SDK for Dawn, the meta-framework for LangGraph that lets you build LangGraph agents like Next.js apps. Use it to declare AI agent and workflow routes, define request middleware, and type the runtime context, tools, and route metadata that the Dawn CLI consumes. Ships small runtime helpers (`agent()`, `defineMiddleware()`, `allow()`, `reject()`, `isDawnAgent()`) alongside the type primitives — it is the canonical entry point for authoring Dawn routes.
```

`packages/cli/README.md` — replace:

```md
The `dawn` CLI for Dawn, the TypeScript meta-framework for LangGraph — a local development runtime, route execution, validation and typegen, and the build step that produces LangSmith deployment artifacts. It is the primary tool for working on a Dawn agent app from first scaffold through deploy.
```

with:

```md
The `dawn` CLI for Dawn, the TypeScript meta-framework for LangGraph that lets you build LangGraph agents like Next.js apps — a local HMR development runtime with durable threads, route execution, validation and typegen, and the build step that produces LangSmith deployment artifacts. It is the primary tool for working on a Dawn agent app from first scaffold through deploy.
```

`packages/create-dawn-app/README.md` — replace:

```md
Scaffold a new Dawn app — the fastest way to start building TypeScript AI agents on LangGraph. Generates a working application from the supported starter templates with Dawn's canonical `src/app` route layout, an `agent()` route, and the Dawn packages wired up for local development.
```

with:

```md
Scaffold a new Dawn app — the fastest way to start building LangGraph agents like Next.js apps. Generates a working application from the supported starter templates with Dawn's canonical `src/app` route layout, an `agent()` route, durable threads, and the Dawn packages wired up for local development.
```

`packages/langchain/README.md` — replace:

```md
LangChain backend adapters for Dawn, the TypeScript meta-framework for LangGraph. Dawn uses this package to materialize `chain` routes and provider-aware `agent` routes — handling tool conversion, streaming, and retry.
```

with:

```md
LangChain backend adapters for Dawn, the TypeScript meta-framework for LangGraph that lets you build LangGraph agents like Next.js apps. Dawn uses this package to materialize `chain` routes and provider-aware `agent` routes — handling tool conversion, streaming, and retry.
```

- [ ] **Step 4: Verify the README edits**

Run: `grep -c "Build LangGraph agents like Next.js apps" README.md`
Expected: `1`

Run: `grep -c "Durable by default\|Two ways to drive the model" README.md`
Expected: `2`

Run: `grep -rl "build LangGraph agents like Next.js apps\|like Next.js apps" packages/sdk/README.md packages/cli/README.md packages/create-dawn-app/README.md packages/langchain/README.md`
Expected: all four paths listed.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/sdk/README.md packages/cli/README.md packages/create-dawn-app/README.md packages/langchain/README.md
git commit -m "docs(readme): unify tagline to hero, add durable-by-default + route-shape duality"
```

---

## Task 2: New landing section — "Two ways to drive the model"

**Files:**
- Create: `apps/web/app/components/landing/DriveTheModel.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Create the `DriveTheModel` component**

Create `apps/web/app/components/landing/DriveTheModel.tsx` with exactly:

```tsx
import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"

const SHAPES = [
  {
    name: "agent",
    tagline: "Let the model decide.",
    body: "An LLM-driven route that picks tools at runtime and can pause for a human. Reach for it when you want the model to choose what to do.",
  },
  {
    name: "workflow",
    tagline: "You own the order.",
    body: "A deterministic, typed async function. Reach for it when you control the sequence of operations and want predictable, step-by-step execution.",
  },
] as const

export function DriveTheModel() {
  return (
    <section className="bg-surface border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Route shapes</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px] max-w-[22ch]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Two ways to drive the model.
        </h2>

        <p className="mt-5 text-lg text-ink-muted leading-[30px] max-w-[60ch]">
          Same routing, same types, same dev loop — you choose who's in charge. A route's{" "}
          <code className="text-sm font-mono text-ink bg-page px-1.5 py-0.5 rounded border border-divider">
            index.ts
          </code>{" "}
          exports exactly one shape.
        </p>

        <div className="mt-10 grid sm:grid-cols-2 gap-6">
          {SHAPES.map((s) => (
            <Card key={s.name} className="p-6 md:p-7">
              <code className="text-sm font-mono font-semibold text-accent-saas">{s.name}</code>
              <p className="mt-3 text-base font-medium text-ink">{s.tagline}</p>
              <p className="mt-2 text-sm text-ink-muted leading-[22px]">{s.body}</p>
            </Card>
          ))}
        </div>

        <p className="mt-6 text-sm text-ink-dim leading-[22px] max-w-[60ch]">
          Need raw LangGraph? Export a{" "}
          <code className="text-xs font-mono text-ink-muted">graph</code> or{" "}
          <code className="text-xs font-mono text-ink-muted">chain</code> and instantiate anything
          you want.
        </p>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Wire it into the landing page**

In `apps/web/app/page.tsx`, add the import (keep imports alphabetical):

```tsx
import { DriveTheModel } from "./components/landing/DriveTheModel"
```

Then place `<DriveTheModel />` immediately **after** `<WhyDawn />` and **before** `<FeatureRouting />` in the returned fragment:

```tsx
      <WhyDawn />
      <DriveTheModel />
      <FeatureRouting />
```

- [ ] **Step 3: Typecheck + lint the web app**

Run: `pnpm --filter web typecheck`
Expected: exits 0.

Run: `pnpm --filter web lint`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/landing/DriveTheModel.tsx apps/web/app/page.tsx
git commit -m "feat(web): add 'Two ways to drive the model' landing section"
```

---

## Task 3: New landing section — "Durable by default"

**Files:**
- Create: `apps/web/app/components/landing/DurableByDefault.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Create the `DurableByDefault` component**

Create `apps/web/app/components/landing/DurableByDefault.tsx` with exactly:

```tsx
import { Card } from "../ui/Card"
import { Eyebrow } from "../ui/Eyebrow"

const PAYOFFS = [
  "Threads survive a dawn dev restart — no lost state between edits.",
  "Agents that pause for human input resume exactly where they left off.",
  "A working SQLite checkpointer and thread store ship by default — zero setup.",
] as const

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      className="w-4 h-4 mt-1 text-accent-saas shrink-0"
    >
      <path d="M3 8.5l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function DurableByDefault() {
  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Durability</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px] max-w-[20ch]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Durable by default.
        </h2>

        <div className="mt-8 grid lg:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16">
          <div className="space-y-5 text-lg text-ink-muted leading-[30px] max-w-[58ch]">
            <p>
              Every Dawn app ships a working checkpointer and thread store — no setup. Runs
              checkpoint to SQLite between turns, so threads survive a{" "}
              <code className="text-sm font-mono text-ink bg-surface px-1.5 py-0.5 rounded border border-divider">
                dawn dev
              </code>{" "}
              restart and an agent that pauses for human input resumes exactly where it left off.
            </p>
            <p>
              LangGraph defines the checkpoint interface; Dawn ships the default implementation. So
              durability is the path of least resistance — not a wiring task.
            </p>
          </div>

          <Card className="p-6 md:p-7">
            <ul className="space-y-3">
              {PAYOFFS.map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-sm text-ink leading-[22px]">
                  <CheckIcon />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </section>
  )
}
```

> **Accuracy guardrail (from the spec):** the "resumes after human input" line is an
> agent-route property. Do not add copy here implying `workflow`/`graph`/`chain` routes
> are interrupt-resumable.

- [ ] **Step 2: Wire it into the landing page**

In `apps/web/app/page.tsx`, add the import (keep imports alphabetical):

```tsx
import { DurableByDefault } from "./components/landing/DurableByDefault"
```

Then place `<DurableByDefault />` immediately **after** `<FeatureDevLoop />` and **before** `<KeepTheRuntime />`:

```tsx
      <FeatureDevLoop />
      <DurableByDefault />
      <KeepTheRuntime />
```

- [ ] **Step 3: Typecheck + lint the web app**

Run: `pnpm --filter web typecheck`
Expected: exits 0.

Run: `pnpm --filter web lint`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/landing/DurableByDefault.tsx apps/web/app/page.tsx
git commit -m "feat(web): add 'Durable by default' landing section"
```

---

## Task 4: Hero — durable-threads subhead + wire the paste-prompt CTA

**Files:**
- Modify: `apps/web/app/components/landing/Hero.tsx`

- [ ] **Step 1: Add the prompt constant and import**

In `apps/web/app/components/landing/Hero.tsx`, add this import alongside the existing `CopyCommand` import:

```tsx
import { CopyPromptButton } from "../CopyPromptButton"
```

Then add this constant directly below the existing `ROUTE_CODE` constant:

```tsx
const HERO_PROMPT = `Scaffold a new Dawn app and help me build an agent. Dawn is the TypeScript meta-framework for LangGraph — agents and workflows are file-system routes with route-local tools, generated types, and durable threads. Run \`pnpm create dawn-ai-app\` to scaffold, then read https://dawnai.org/AGENTS.md and https://dawnai.org/llms-full.txt for the full framework reference before writing any routes.`
```

- [ ] **Step 2: Add "durable threads" to the subhead**

Replace this exact text in the subhead `<p>`:

```tsx
              Dawn adds file-system routing, route-local tools, generated types, and HMR to your
              existing LangGraph.js stack.{" "}
```

with:

```tsx
              Dawn adds file-system routing, route-local tools, generated types, durable threads,
              and HMR to your existing LangGraph.js stack.{" "}
```

- [ ] **Step 3: Wire the CTA button into the hero actions**

Replace this exact block:

```tsx
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <CopyCommand command="pnpm create dawn-ai-app" />
              <Link
                href="/docs/getting-started"
                className="text-sm font-medium text-ink hover:text-accent-saas transition-colors inline-flex items-center gap-1.5"
              >
                Read the docs <span aria-hidden="true">→</span>
              </Link>
            </div>
```

with:

```tsx
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <CopyCommand command="pnpm create dawn-ai-app" />
              <CopyPromptButton
                prompt={HERO_PROMPT}
                label="Copy agent prompt"
                ariaLabel="Copy a prompt to scaffold Dawn with your coding agent"
              />
              <Link
                href="/docs/getting-started"
                className="text-sm font-medium text-ink hover:text-accent-saas transition-colors inline-flex items-center gap-1.5"
              >
                Read the docs <span aria-hidden="true">→</span>
              </Link>
            </div>
```

- [ ] **Step 4: Typecheck + lint the web app**

Run: `pnpm --filter web typecheck`
Expected: exits 0.

Run: `pnpm --filter web lint`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/landing/Hero.tsx
git commit -m "feat(web): durable-threads subhead + wire paste-prompt CTA into hero"
```

---

## Task 5: Docs — register the CTA component + promote durability/duality

**Files:**
- Modify: `apps/web/mdx-components.tsx`
- Modify: `apps/web/content/docs/getting-started.mdx`
- Modify: `apps/web/content/docs/mental-model.mdx`

- [ ] **Step 1: Register `CopyPromptButton` for MDX**

In `apps/web/mdx-components.tsx`, add this import next to the other component imports at the top:

```tsx
import { CopyPromptButton } from "./app/components/CopyPromptButton"
```

Then add `CopyPromptButton,` to the object returned by `useMDXComponents`, next to the existing `RelatedCards,` entry:

```tsx
    RelatedCards,
    CopyPromptButton,
```

- [ ] **Step 2: Add the docs CTA to Getting Started**

In `apps/web/content/docs/getting-started.mdx`, insert this block immediately after the second intro paragraph (the one beginning "By the end of this guide you'll have a working deep-research assistant") and before the `## 1. Install` heading:

```mdx
<CopyPromptButton
  variant="docs"
  label="Copy agent prompt"
  prompt={`Scaffold a new Dawn app and help me build an agent. Dawn is the TypeScript meta-framework for LangGraph — agents and workflows are file-system routes with route-local tools, generated types, and durable threads. Run \`pnpm create dawn-ai-app\` to scaffold, then read https://dawnai.org/AGENTS.md and https://dawnai.org/llms-full.txt for the full framework reference before writing any routes.`}
/>

Prefer to build with a coding agent? Copy the prompt above and paste it into Claude Code, Cursor, or your agent of choice.
```

- [ ] **Step 3: Add a "Durable by default" callout to the mental model**

In `apps/web/content/docs/mental-model.mdx`, find the paragraph in the "## The runtime" section that begins "Runs execute on a thread. Between turns, Dawn checkpoints the LangGraph state to SQLite". Immediately after that paragraph, insert:

```mdx
<Callout>
  **Durable by default.** Every Dawn app ships a working checkpointer and thread store — no
  setup. Threads survive a `dawn dev` restart, and an `agent` route that pauses for human input
  resumes exactly where it left off. LangGraph defines the checkpoint interface; Dawn ships the
  default implementation (`@dawn-ai/sqlite-storage`), so durability is the path of least
  resistance — not a wiring task.
</Callout>
```

- [ ] **Step 4: Add a "Two ways to drive the model" subsection to the mental model**

In `apps/web/content/docs/mental-model.mdx`, find the "## The pieces" section's paragraph that begins "A *route entry* is the route's default behavior. Each route has exactly one `index.ts` that exports an `agent`, a `workflow`, a `graph`, or a `chain`." Immediately after that paragraph, insert:

```mdx
**Two ways to drive the model.** Export an `agent` when the model should decide what to do — it
picks tools at runtime and can pause for a human. Export a `workflow` when you own the order of
operations — a deterministic, typed async function. Same routing, same types, same dev loop; you
choose who's in charge. Drop to `graph` or `chain` for raw LangGraph anytime. See
[Agents](/docs/agents) and [Routes](/docs/routes) for each shape.
```

- [ ] **Step 5: Typecheck + lint + docs gate**

Run: `pnpm --filter web typecheck`
Expected: exits 0.

Run: `pnpm --filter web lint`
Expected: exits 0.

Run: `node scripts/check-docs.mjs`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/mdx-components.tsx apps/web/content/docs/getting-started.mdx apps/web/content/docs/mental-model.mdx
git commit -m "docs(web): register paste-prompt CTA, promote durability + route-shape duality in mental model"
```

---

## Task 6: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Build the web app**

Run: `pnpm --filter web build`
Expected: `next build` completes successfully; the home page and `/docs/getting-started` and `/docs/mental-model` render without errors.

- [ ] **Step 2: Accuracy guardrail — no over-claim on interrupt resumability**

Run:
```bash
grep -rniE "(workflow|graph|chain) route.{0,40}(resume|interrupt)" apps/web/app/components/landing apps/web/content/docs README.md
```
Expected: no matches (only `agent` routes are described as interrupt-resumable).

- [ ] **Step 3: Confirm the new sections are wired in order**

Run:
```bash
grep -nE "WhyDawn|DriveTheModel|FeatureRouting|FeatureDevLoop|DurableByDefault|KeepTheRuntime" apps/web/app/page.tsx
```
Expected order of `<...>` usages: `WhyDawn` → `DriveTheModel` → `FeatureRouting` → … → `FeatureDevLoop` → `DurableByDefault` → `KeepTheRuntime`.

- [ ] **Step 4: Confirm the CTA is wired (no longer dead code)**

Run: `grep -rl "CopyPromptButton" apps/web/app/components/landing/Hero.tsx apps/web/mdx-components.tsx`
Expected: both paths listed.

- [ ] **Step 5: Pack check (packaged READMEs valid)**

Run: `pnpm pack:check`
Expected: passes. If it fails for a reason unrelated to README content, note it — this plan only touches READMEs among packaged files.

- [ ] **Step 6: Final commit if any fixes were made**

```bash
git add -A
git commit -m "docs: verification fixes for positioning & messaging refresh"
```

(If no fixes were needed, skip this step.)

---

## Self-Review Notes

- **Spec coverage:** Surface 1 (landing) → Tasks 2, 3, 4. Surface 2 (README + npm) → Task 1. Surface 3 (docs) → Task 5. Constants M1 → Task 1; M2 → Tasks 3 (section) + 5 (callout) + 1 (bullet); M3 → Tasks 2 (section) + 5 (subsection) + 1 (bullet); M4 → Tasks 4 (hero) + 5 (docs). Accuracy guardrail → Task 3 note + Task 6 Step 2. Verification → Task 6.
- **No placeholders:** every new component is shown in full; every edit is an exact find/replace or a precisely-anchored insertion with complete content.
- **Type/name consistency:** component names `DriveTheModel` / `DurableByDefault` and the `CopyPromptButton` props (`prompt`, `label`, `variant`, `ariaLabel`) match the existing `CopyPromptButton.tsx` signature; `Card`/`Eyebrow` props match their definitions.
- **Out of scope (held):** no hero headline rewrite, no Tier-2 README changes, no new docs pages, no `agents.mdx`/`routes.mdx` edits, no brand/OG changes.
