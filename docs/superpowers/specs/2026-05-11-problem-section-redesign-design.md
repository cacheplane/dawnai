# Problem Section Redesign — Design

**Date:** 2026-05-11
**Status:** Approved
**Scope:** apps/web — `apps/web/app/components/landing/ProblemSection.tsx` (full rewrite)

## Problem

The current `ProblemSection.tsx` on the landing page is too wordy and the pain points don't land. It opens with a corporate "The Problem" eyebrow, a long explainer paragraph, four pain cards (each with title + body), a side-by-side code comparison, and a closing paragraph — roughly 250 words and 60 lines of code on screen at once.

The reader scrolls past it without feeling anything. The pain doesn't hit. The org-wide fragmentation pain (the strongest insight: every team in an org has a different agent codebase shape) is buried.

## Goals

- Make the pain land in under 10 seconds of reading.
- Lead with the strongest, most universal pain: **fragmentation across projects/teams**.
- Voice shifts from corporate to friendly ("we've all been here"). The section should feel like commiseration, not a sales pitch.
- Pain points are grounded in actual developer complaints (HN, Reddit, Medium, Mastra blog) — no invented pains.
- Cut total copy from ~250 words to ~50 words.

## Non-goals

- Not a redesign of any other landing section. Existing "Pattern", "BigReveal", "CodeExample", and others stay as they are.
- No code-comparison block in this section. That story lives in "Pattern" and "CodeExample" later in the page.
- Not a wholesale visual-design change — fits the existing landing palette (`landing-text`, `accent-amber`, dark theme).

## Approach

### Section flow (top to bottom)

1. **Eyebrow** — "Sound familiar?" (friendly, replaces formal "The Problem")
2. **Headline** — "Five projects in your org. Five different shapes." (concrete, empathetic — names the strongest universal pain)
3. **Sub-line** — "We've watched this in every company we've worked at. It hurts." (commiserating)
4. **Fragmentation visual** — 5 mini file trees side-by-side, each labelled like a real org project, with visibly different shapes; below them, a single Dawn tree labelled "Or — one shape."
5. **Pain one-liners** — 3 stacked one-liners (no card grid, just lines with subtle separators)
6. **Closer** — single sentence: "Dawn is the convention that makes it stop."

Total copy: ~50 words.

### The fragmentation visual — concrete spec

Five file trees in a horizontal grid (responsive: 5 columns on `lg:`, 2-3 columns on `md:`, 1 column stacked on mobile). Each tree is ~6-8 lines of ASCII / monospace text inside a small card with:

- Tiny eyebrow with the "project name" label (e.g., `project-alpha`, `team-x-agent`)
- File tree below it, visibly different from its neighbors
- Small caption with one stat (e.g., `12 tools · 4 graphs`)

The visible differences across the five trees should be obvious at a glance:

- One has flat `agents/` directory
- One has `src/graphs/` + `src/tools/`
- One has `lib/llm/` + `chains/`
- One has Python-style structure with `main.py`
- One has a single `index.ts` with everything inline

Below the row of five, a single line: "Or — one shape." Then one canonical Dawn tree, slightly larger / amber-tinted to draw the eye, with:

```
src/app/
  (public)/
    hello/[tenant]/
      index.ts
      state.ts
      tools/
        greet.ts
```

### Pain one-liners (final copy)

Three lines, one per visible row, separated by subtle horizontal rules. Each is grounded in researched complaints:

1. **"Same StateGraph boilerplate. Fifth project running."** (boilerplate fatigue, #1 HN complaint)
2. **"Your tool's Zod schema drifted from its function signature. You found out at runtime."** (schema drift, named research problem)
3. **"Your deploy is a hand-rolled Dockerfile per agent."** (deployment pain, confirmed)

Optional bonus line that lands the 2026 AI-coding-tool angle (will include in the implementation; user can remove if it feels like one too many):

4. **"Even your coding agent gets lost — every agent codebase has a different shape."**

### Voice rules

- Short, declarative sentences
- No hedge words ("you might", "perhaps")
- Direct address ("you", "your") — peer-to-peer, not corporate
- Empathetic acknowledgment in the sub-line and closer ("we've watched this", "makes it stop")
- No marketing language ("blazingly fast", "instant", "magical")
- No exclamation marks
- Friendly but not saccharine — closer to "this kinda sucks" than "we feel your pain!"

## Architecture

Single file rewrite:

```
apps/web/app/components/landing/ProblemSection.tsx   # full rewrite
```

The component remains a server component (no client hooks needed). Loses its current dependency on `shiki/highlight` since the code comparison is removed.

```tsx
// New shape (high level — implementation will fill in)

const FRAGMENTED_PROJECTS = [
  { name: "project-alpha", stat: "12 tools · 4 graphs", tree: `...` },
  { name: "team-x-agent",  stat: "8 tools · 1 graph",  tree: `...` },
  { name: "support-bot",   stat: "...",                tree: `...` },
  { name: "ops-runner",    stat: "...",                tree: `...` },
  { name: "data-pipeline", stat: "...",                tree: `...` },
] as const

const DAWN_TREE = `src/app/
  (public)/
    hello/[tenant]/
      index.ts
      state.ts
      tools/
        greet.ts`

const PAINS = [
  "Same StateGraph boilerplate. Fifth project running.",
  "Your tool's Zod schema drifted from its function signature. You found out at runtime.",
  "Your deploy is a hand-rolled Dockerfile per agent.",
  "Even your coding agent gets lost — every agent codebase has a different shape.",
] as const

export function ProblemSection() {
  return (
    <section>
      {/* eyebrow + headline + sub-line */}
      {/* 5-up fragmented trees grid */}
      {/* "Or — one shape." separator */}
      {/* single Dawn tree */}
      {/* 3-4 stacked pain one-liners with separators */}
      {/* closer line */}
    </section>
  )
}
```

### Visual treatment

- Eyebrow: existing `landing-text-muted text-xs uppercase tracking-widest` style with amber dot
- Headline: existing `font-display text-4xl md:text-5xl font-semibold` style
- Fragmented project cards: muted indigo border (matches the "cool unsolved problem" tone used elsewhere), small monospace text inside
- Dawn tree: warm amber-tinted border, slightly bigger, draws the eye
- Pain one-liners: stacked vertically, separated by `landing-border-subtle` horizontal rules, each line is `text-base landing-text-muted` with the noun bolded in `landing-text`
- Closer: centered, slightly larger, semibold

## Testing

- `pnpm --filter @dawn-ai/web build`, `typecheck`, and `lint` all pass
- Manual smoke at `/` desktop (1440x900):
  - Section reads as friendly + tight — no walls of text
  - Five file trees visibly different at a glance
  - Dawn tree feels like the obvious resolution
  - Three (or four) pain lines land as commiserations, not lectures
- Mobile (390x844):
  - File trees collapse to 1-2 columns stacked, still legible
  - Pain lines stack cleanly with separators
- Scroll feel: section is now noticeably shorter than the current one (target ~40% the vertical height)

## Migration risk

Low — single file rewrite. The component is a leaf in `apps/web/app/page.tsx` already wired with no children. Removing the code-comparison call to `shiki/highlight` is contained inside this file; no other imports need updating.

## Open items deferred to plan

- Whether to keep or drop the bonus 4th pain line (AI-coding-tool angle). Default: keep, decide at chrome-validation step. If it pushes the section past ~50 words total or visually crowds the layout, drop.
- Whether the Dawn tree should be inline with the 5 fragmented trees (6-up grid) or below them as a separate row. Default: separate row below, with "Or — one shape." text between. Decide visually if the 6-up reads better.
- Whether to source the project names from the research (e.g., real-sounding `customer-support-bot`, `ops-incident-agent`) or generic placeholders (`project-alpha`, `project-beta`). Default: real-sounding — feels more authentic.

## Research grounding

Pain themes are validated against:
- HN: ["Sick of AI Agent Frameworks"](https://news.ycombinator.com/item?id=42691946), ["Why we no longer use LangChain"](https://news.ycombinator.com/item?id=40739982)
- ["Challenges & Criticisms of LangChain" (Medium)](https://shashankguda.medium.com/challenges-criticisms-of-langchain-b26afcef94e7)
- ["Why Developers Say LangChain Is Bad" (Designveloper)](https://www.designveloper.com/blog/is-langchain-bad/)
- ["Current limitations of LangChain/LangGraph 2025" (Latenode)](https://community.latenode.com/t/current-limitations-of-langchain-and-langgraph-frameworks-in-2025/30994)
- ["How to Structure Projects for AI Agents" (Mastra)](https://mastra.ai/blog/how-to-structure-projects-for-ai-agents-and-llms)

Top three themes (abstraction overload, schema drift, project fragmentation) all map directly to the new pain lines and the fragmentation visual.
