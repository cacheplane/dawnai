# Flow + Ecosystem Sections — Design

**Date:** 2026-05-08
**Status:** Draft
**Scope:** apps/web — landing page rewrites of `HowItWorks.tsx` (The Flow) and `EcosystemSection.tsx` (The Ecosystem)

## Problem

Two daylight-section refreshes that have been on the punch list since the broader Pass 3:

**The Flow (`HowItWorks.tsx`)** currently renders four numbered steps in a 600px column with a single shiki snippet at step 2. It states a claim ("Up and running in 30 seconds") but doesn't *show* it. The reader has no concrete picture of what each command produces — no project tree, no run output, no HMR feedback. The 30-second framing also slightly distracts from the broader "this is a simple getting-started flow" message.

**The Ecosystem (`EcosystemSection.tsx`)** currently renders three small package cards. It reads as a footnote rather than a value statement. The compatibility breadth ("works with everything LangChain does") is invisible: a reader doesn't see which providers / vector stores / tracing tools are supported.

## Goals

### The Flow

- Drop the 30-second claim from the headline. Replace with a broader claim about a "simple getting-started flow."
- Each step shows **proof**: the actual output / file contents / log lines that result from running the command. The reader sees what each step produces, not just what to type.
- Keep the four-step structure: Scaffold · Write a route · Run it · Iterate.
- Editorial layout: large serif numerals (01, 02, 03, 04), serif step headlines, prose, command chip(s), and a proof block per step.
- All proof blocks render on a fixed dark code surface (matches the docs/CodeExample/CodeBlock discipline).

### The Ecosystem

- Replace the three small cards with a 12-cell compatibility wall plus a 3-card first-party adapter row beneath.
- Compatibility wall shows real logos for: OpenAI, Anthropic, Google, AWS Bedrock, Cohere, Mistral, LangChain, LangGraph, LangSmith, Pinecone, Tavily, plus a "+ more via LCEL" tile.
- Logo sourcing: try CopilotKit CDN first (`cdn.copilotkit.ai/docs/copilotkit/icons/<name>.png`); fall back to simpleicons.org (the source already used by `LogoWall`) for any that 403; commit downloaded files to `apps/web/public/logos/providers/`.
- Below the wall: divider labeled "FIRST-PARTY ADAPTERS" and three adapter cards (`@dawn-ai/langgraph`, `@dawn-ai/langchain`, `@dawn-ai/sdk`) — same structure as today, but visually demoted to the smaller "below the wall" beat.

## Non-goals

- No animation in either section — both stay static. The 100vh BigReveal already carries the kinetic moment.
- Not adding more steps to The Flow. Four is correct.
- Not changing the section vertical positions in `page.tsx`. Both stay between their current siblings.
- Not building a generic logo grid component. The `EcosystemSection` carries a one-off layout; we don't ship a `<ProviderGrid>` for reuse.
- Not adding more adapters (e.g., `@dawn-ai/langsmith` doesn't exist; we don't claim it).

## Approach

### The Flow

**Component layout, per moment:**

```
[80px gutter]                    [content column]
  ┌────────┐                     ┌──────────────────────────────────┐
  │   01   │   <- 56px serif     │ Scaffold the project.            │
  │  gold  │      numeral         │ One command writes a working agent…│
  └────────┘                     │ [ $ npx create-dawn-app my-agent ] │
                                 │ ┌─ proof ─────────────────────┐  │
                                 │ │ project tree, ✓ ready in 4.2s│  │
                                 │ └──────────────────────────────┘  │
                                 └──────────────────────────────────┘
```

The first numeral (`01`) is filled gold; subsequent ones (`02`, `03`, `04`) are amber-at-30%-opacity for visual hierarchy. The proof block lives directly below the command chip and visually anchors each moment.

**Headline:** *From zero to running agent.* with "zero" italic-gold.

**Lede:** "A simple getting-started loop. Four commands; each one shows you exactly what it did."

**Per-step content:**

| # | Title | Command(s) | Proof block content |
|---|---|---|---|
| 01 | Scaffold the project. | `npx create-dawn-app my-agent` | Project tree (yellow folder names, purple dynamic segment, blue index, green tool) + `✓ ready in 4.2s` |
| 02 | Write a route. | filename chip: `src/app/(public)/hello/[tenant]/index.ts` | Shiki-highlighted TypeScript snippet of the workflow export |
| 03 | Run it. | `dawn run '/hello/acme'` | Run output: route, mode, tenant, `✓ { greeting: "Hello, acme!" }`, elapsed ms |
| 04 | Iterate. | `dawn dev` and `dawn test --watch` | HMR log + scenarios passed (3/3) + types regenerated |

**Proof block visual:**

- `bg: #14110d` (matches `--color-bg-card`), 1px border `#241f19` (`--color-border`).
- Header strip: small "STDOUT" / "YOUR CODE" / "DEV SERVER" label on the left, status badge on the right (`✓ created` / `200` / `live`).
- Body: `font-mono` 12.5px line-height 1.7, color `#c8c8cc` for default text. Token classes match the existing brand palette: `text-yellow-400` for folder names, `text-purple-400` for dynamic segments, `text-blue-400` for primary route file, `text-green-400` for tools/output, `text-text-muted` (`#5a554c`) for dim metadata, `text-text-dim` for italic comments.
- Step 02's proof block uses the existing `highlight()` helper to render the workflow snippet via shiki (matches the rest of the page's code panels).

The fixed-dark surface is intentional — same discipline as `CodeExample`, `HowItWorks` step 2 today, and the docs `Pre` component. Code is content; it always sits on dark regardless of the engine palette.

### The Ecosystem

**Section structure:**

```
[ Eyebrow • green ] Ecosystem
[ Headline ]      Works with everything LangChain does.
[ Lede ]          Models, tools, tracing, vector stores. Use the providers you already pay for.

[ 6×2 logo grid: 12 cells ]

[ Divider — "FIRST-PARTY ADAPTERS" ]

[ 3-column adapter row ]
```

**Headline:** *Works with everything LangChain does.* with "LangChain does" italic-gold.

**Lede:** "Models, tools, tracing, vector stores. Use the providers you already pay for."

**Logo grid (6×2 = 12 cells):**

| Cell | Name | Role | Source plan |
|---|---|---|---|
| 1 | OpenAI | model | CopilotKit CDN, fall back simpleicons `openai.svg` |
| 2 | Anthropic | model | CopilotKit CDN, fall back simpleicons `anthropic.svg` |
| 3 | Google | model | CopilotKit CDN, fall back simpleicons `google.svg` |
| 4 | Bedrock | model | CopilotKit `amazon-aws.png`, fall back simpleicons `amazonaws.svg` |
| 5 | Cohere | model | simpleicons `cohere.svg` (CopilotKit doesn't have it) |
| 6 | Mistral | model | simpleicons `mistralai.svg` |
| 7 | LangChain | runtime | already in `public/logos/langchain.svg` |
| 8 | LangGraph | runtime | already in `public/logos/langgraph.svg` |
| 9 | LangSmith | tracing | simpleicons `langsmith` if exists, else placeholder |
| 10 | Pinecone | vector | simpleicons `pinecone.svg` |
| 11 | Tavily | search | simpleicons (likely missing — fall back to wordmark text cell) |
| 12 | "+ more via LCEL" | adapter | text-only cell, no logo |

Logo files are downloaded into `apps/web/public/logos/providers/<name>.svg`. Each cell renders a 28×28 logo at center plus the brand name and role label below. Logos are masked monochrome (single color via `mask-image`) to keep the wall visually unified — same treatment as the existing `LogoWall` component on the cosmic-dark portion of the page.

**Cell layout:**

```
┌───────────────┐
│      [logo]      │  <- 28x28 monochrome via mask-image
│   Provider Name  │  <- 12.5px sans semibold
│      role        │  <- 9.5px mono uppercase, muted
└───────────────┘
```

Cell background uses `rgba(33,24,12,0.04)` with a 1px `rgba(33,24,12,0.10)` border. On hover, border + bg shift toward green to signal interactivity (no actual link — the wall is decorative until/unless we add deep links to docs).

**Divider:** A horizontal line on each side of the text "FIRST-PARTY ADAPTERS" (uppercase, letter-spaced, green).

**Adapter cards (3-column grid):**

| Card | Border + bg | Content |
|---|---|---|
| @dawn-ai/langgraph | green-tinted | "Native LangGraph runtime adapter. StateGraph wiring, conditional edges, persistence + resume." |
| @dawn-ai/langchain | green-tinted | "LCEL chain adapter. Auto-converts Dawn tools to LangChain tools, with LangSmith tracing." |
| @dawn-ai/sdk | neutral | "Backend-neutral contract. RuntimeContext, ToolRegistry, route config. Build a custom adapter in ~200 lines." |

The first two are accented (Dawn's brand answer to the LangChain ecosystem); the third is the foundation card and stays neutral.

### Logo download approach

A small one-shot script (or manual Chrome session via the Chrome MCP, depending on what works) probes each provider's CDN URLs in this order:

1. `https://cdn.copilotkit.ai/docs/copilotkit/icons/<name>.png` — earlier curl tests showed 403 from a raw HTTP client; Chrome's request from a real origin may succeed. If yes, download and save.
2. `https://cdn.simpleicons.org/<slug>` — the source we already use for the `LogoWall` set. Returns 200 for nearly every brand.
3. If both fail, ship a placeholder text cell (the "+ more via LCEL" cell pattern) so the layout still renders.

Files commit under `apps/web/public/logos/providers/`. The `EcosystemSection` references them by relative path (`/logos/providers/openai.svg` etc.). License/usage check: simpleicons content is CC0; CopilotKit's CDN logos are presumably their own brand-asset re-encodings — the spec defers to the lawyer-not-this-LLM rule and notes that we're using these as nominative trademark uses ("Dawn integrates with X"), which is the standard practice across the entire web.

### Palette discipline

- Both sections sit in daylight palette — text uses `landing-text` / `landing-text-muted`.
- The Flow's proof blocks are the only fixed-dark surfaces (matching the rest of the page's code surfaces).
- The Ecosystem's logo cells and adapter cards sit on the engine palette (cream daylight at this scroll position).
- The amber + green accents in adapter cards / "FIRST-PARTY ADAPTERS" divider are static colors carrying meaning, not theme.

### Typography

Both sections share the established hierarchy:
- Eyebrow: `text-xs uppercase tracking-widest`, amber for The Flow / green for The Ecosystem
- Headline: `font-display`, `clamp(36px, 5vw, 48px)` weight 700 with letter-spacing -0.025em
- Lede: 17px body color, max-width ~600px
- Step numerals (Flow only): 56px serif, gold for the active first step, amber 30% for the rest
- Step h4 (Flow): 22px serif weight 700
- Card text (both): 13–14.5px body
- Mono surfaces: 12.5px monospace, 1.7 line-height

### Responsive

- The Flow: at narrow widths (<640px), the 80px numeral gutter shrinks to 56px and the numeral to 40px. Proof blocks remain full-width within the column. Already responsive.
- The Ecosystem: 6-column logo grid → 4 cols at md, 3 cols at sm, 2 cols at narrow. Adapter row 3-col → 1-col stack at <640px. Standard Tailwind breakpoints.

## Architecture

```
apps/web/
├── app/components/landing/
│   ├── HowItWorks.tsx           # full rewrite — 4 moments with proof blocks
│   └── EcosystemSection.tsx     # full rewrite — logo wall + adapter row
└── public/logos/providers/      # NEW — provider logo SVGs/PNGs (12 files max)
```

Optional new helper: `apps/web/lib/palette/logos.ts` exporting the providers array — one source of truth for cell name + role + src. Skipped in spec; will inline the constant in `EcosystemSection.tsx` for now (one consumer, no reuse pressure).

## Testing

- **Build & typecheck:** `pnpm --filter @dawn-ai/web build && typecheck` pass.
- **Lint:** `pnpm --filter @dawn-ai/web lint` passes.
- **Visual smoke (manual):** scroll to each section. Confirm:
  - **Flow:** four numbered moments with proof blocks beneath each command. Step 02's proof block has shiki-highlighted TS. Step 04 shows HMR + scenario log. No "30 seconds" claim anywhere.
  - **Ecosystem:** 6×2 logo grid renders all twelve provider cells. Adapter row below shows three cards. "FIRST-PARTY ADAPTERS" divider visible.
- **Mobile:** at 390px both sections collapse cleanly per the responsive notes above.
- **Reduced motion:** no animation in either section, unaffected.

## Migration risk

Low. Both rewrites are self-contained; no shared types or imports outside their own files. The vertical positions in `page.tsx` stay identical, so palette engine progress at these scroll positions is unchanged.

The biggest concrete risk is the logo download. If CopilotKit's CDN refuses Chrome requests too and simpleicons doesn't have one of the brands (Tavily is the most likely miss), the fallback is to render that cell as a text-only "Tavily" wordmark — still readable, just less visual.

## Open items deferred to plan

- Whether to add a small "View all integrations →" link below the logo grid pointing at a docs page. Skipped — we don't yet have an integrations page. Reconsider when docs grow.
- Whether to render adapter cards with a tiny code snippet showing the import (the "code-first proof" idea from earlier brainstorm). Skipped — the cards are already information-dense, and `ArchitectureSection` carries the import-mapping job.
