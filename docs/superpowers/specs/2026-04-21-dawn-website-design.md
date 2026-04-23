# Dawn Website Design

## Goal

Build the Dawn framework website — a marketing landing page plus a skeleton documentation experience — that positions Dawn as "The App Router for AI agents" and gives the brand a distinctive visual identity in the LangChain/AI-tooling space. The site lives in the monorepo at `apps/web/`.

## Problem

Dawn has no web presence. Developers discovering the framework have only the README and source code. There's no landing page to communicate what Dawn is, how it compares to what they already know, or how to get started. It also needs a visual identity — every dev-tool landing is dark-neutral with one cold accent, and that aesthetic is entirely interchangeable. Dawn deserves to stand out from the monoculture.

## Design

### Positioning

Everything on the site orbits this sentence:

> **Dawn is the App Router for AI agents.**

Expanded: Dawn is a TypeScript-first framework for building and deploying graph-based AI systems with the ergonomics of Next.js.

Target audience: frontend engineers, full-stack TypeScript developers, and teams already using LangGraph but struggling with structure.

### Visual Identity — The Whisper

The brand name is poetic (dawn = new beginning, light breaking, emergence). The positioning is technical. Rather than ignore the poetry (pure dev-tool-dark) or commit fully to it (warm light-mode), we resolve the tension with a **whisper** — technical dev-tool discipline, warmed from the inside by a temperature shift and kept honest by a single amber.

Three core moves:

1. **Color whisper: pinpoint amber over warm-tinted neutrals.** The "black" palette subtly warms — `#0a0806` instead of pure `#000`, neutrals shift toward brown undertones. Imperceptible per-pixel; collectively the whole page *feels* warmer. Amber appears only where it means something: primary CTAs, the `$` prompt in code blocks, active accents, key highlights.
2. **Signature hero — "sunrise over Earth from space."** Rather than a generic radial-gradient bloom, the hero renders as a literal ISS-style photograph: starfield above, Earth's curvature at the bottom, an atmospheric limb blooming amber where the sun is cresting, tiny city lights glowing on the dark nightside. This is the single distinctive visual moment in the AI-tooling landscape.
3. **Typographic counterpoint.** Inter for UI/body (non-negotiable for dense technical content). **Fraunces Variable** (open-source, optical-size axis) for every display headline and the wordmark — warm, editorial, distinctive. JetBrains Mono for code.

### Color System

**Warm-tinted neutrals** (baked into the whole page):

| Token | Hex |
|---|---|
| `bg-primary` | `#0a0806` |
| `bg-secondary` | `#0f0c09` |
| `bg-card` | `#14110d` |
| `border` | `#241f19` |
| `border-subtle` | `#19150f` |
| `text-primary` | `#f8f5ef` |
| `text-secondary` | `#8a857b` |
| `text-muted` | `#5a554c` |
| `text-dim` | `#3f3b35` |

**Amber primary accent** (pinpoint):

| Token | Hex | Role |
|---|---|---|
| `accent-amber` | `#f59e0b` | Primary CTAs, terminal `$`, CLI `✓`, highlights |
| `accent-amber-deep` | `#d97706` | Hover/active states, the atmospheric limb's terminator color |

**Ecosystem-only colors** (green reserved, never bleeds outside Ecosystem section):

| Token | Hex | Role |
|---|---|---|
| `accent-green` | `#00a67e` | LangChain ecosystem trust signal — hero badge, Ecosystem section only |
| `accent-blue` | `#3178c6` | TypeScript trust strip |
| `accent-purple` | `#646cff` | Vite trust strip |

### Typography

- **Fraunces Variable** (`next/font/google`), `opsz 144, SOFT 50`, weight 600. Used for: hero H1, every section H2, docs H1/H2, the "dawn" wordmark in header. Google Fonts, SIL OFL license.
- **Inter Variable**, variable weight 400–700. Body text, nav, UI, eyebrow labels, card H3s. Unchanged from baseline.
- **JetBrains Mono**, variable weight 400–700. Code blocks, CLI output, install command.

### Hero Composition — The Sunrise Over Earth

Three SVG layers, composed Polaris-style with heavy `feGaussianBlur`:

1. **`dawn-stars.svg`** — sparse scatter of ~20 small pale-blue dots across the cosmic dark. Densest at top, thinning toward the horizon. One slightly-brighter signature star with a blurred halo.
2. **`dawn-earth.svg`** — pinned to the bottom at `bg-bottom` with a fixed 180px height. Contains:
   - **Earth disc** — very deep navy (`#020617`), positioned far below the viewBox so only the top curvature shows as a gentle arc.
   - **Atmospheric limb** (stacked concentric radial gradients with Gaussian blur): outer pale periwinkle → mid rose/coral → tight bright amber → hairline terminator edge.
   - **Terminator bloom** — a localized brighter amber ellipse at center-bottom where the sun is actually cresting, diffusing outward.
   - **City lights** — 12 small warm-amber pinpricks + 6 paler highlights, scattered across the visible earth surface.

The hero section has `overflow-hidden isolate` so z-layering works: stars (`-z-20`), earth (`-z-10`), content on top.

### Section-by-Section Treatment

Every section H2 in Fraunces. Every eyebrow label gets a `1×1` amber dot chapter-marker (green dot in Ecosystem section). Specific per-section decisions:

- **Hero** — Fraunces H1 (`opsz 144`), amber CTA pill, amber `$` in install command, trust strip moved between subtitle and CTAs so it floats in cosmic dark above the amber limb.
- **ProblemSection** — Fraunces H2, amber eyebrow dot. Cards already neutral-warm.
- **ComparisonTable** — Dawn column header in amber. Dawn-only row `✓` checks in amber. A hairline amber seam divides Next.js and Dawn columns (the "illuminated" path). Alt rows use `bg-bg-card/60`.
- **SolutionSection** — Fraunces H2. Pillar icons stay monochrome over warm-neutral card backgrounds.
- **CodeExample** — Fraunces H2. Terminal `$` prompt and `✓` success mark both amber. Syntax highlighting (yellow types, green strings, purple keywords, blue functions) preserved as a legitimate dev convention.
- **DeploySection** — Fraunces H2. Deploy step (the 3rd and terminal step) fully ambered: icon stroke, gradient background (`from-[#1a1005] to-[#2a1a08]`), border, label. Arrows between steps in `accent-amber/50`. Protocol note's ⓘ amber.
- **FeatureGrid** — Fraunces H2. The `Dawn CLI` card — the defining differentiating feature — gets an amber border and a small amber corner dot. Other cards neutral.
- **HowItWorks** — Fraunces H2. Step 1's number circle is amber-filled with dark text (the first beat); steps 2–4 are neutral warm cards.
- **EcosystemSection** — Fraunces H2. **Green's only home.** Eyebrow dot green. `@dawnai.org/langgraph` and `@dawnai.org/langchain` cards have green borders with a subtle green radial glow at the bottom. `@dawnai.org/sdk` stays neutral dashed. No amber in this section.
- **CtaSection** — Fraunces H2, amber CTA pill, amber `$` in install command. A subtle starfield echo at the top of the section closes the cosmic loop from hero to CTA.

### Documentation (`/docs/getting-started`)

- H1 and H2 swap to Fraunces via `mdx-components.tsx`.
- Sidebar eyebrow gets the amber chapter-marker dot.
- Code blocks, lists, inline code all inherit warm-neutral tokens.
- Layout unchanged (sidebar + main content).

### File Structure

```
apps/web/
├── next.config.ts                 # MDX plugin config
├── postcss.config.mjs             # Tailwind v4
├── mdx-components.tsx             # MDX → Fraunces H1/H2, Inter body
├── public/
│   └── backgrounds/
│       ├── dawn-stars.svg         # Hero starfield
│       └── dawn-earth.svg         # Hero earth curvature + limb + city lights
├── content/docs/
│   └── getting-started.mdx
└── app/
    ├── layout.tsx                 # Loads Inter, Fraunces, JetBrains Mono via next/font
    ├── globals.css                # @theme tokens (warm neutrals + amber)
    ├── page.tsx                   # Composes 10 landing sections
    ├── docs/
    │   ├── layout.tsx             # Sidebar + content
    │   └── getting-started/page.tsx
    └── components/
        ├── Header.tsx             # dawn wordmark (Fraunces), amber Get Started pill
        ├── Footer.tsx
        └── landing/
            ├── HeroSection.tsx
            ├── ProblemSection.tsx
            ├── ComparisonTable.tsx
            ├── SolutionSection.tsx
            ├── CodeExample.tsx
            ├── DeploySection.tsx
            ├── FeatureGrid.tsx
            ├── HowItWorks.tsx
            ├── EcosystemSection.tsx
            └── CtaSection.tsx
```

### Landing Page Structure (unchanged from prior spec)

Same 10-section narrative arc: Hero → Problem → Comparison → Solution → CodeExample → Deploy → FeatureGrid → HowItWorks → Ecosystem → CTA.

## Rationale for the whisper strategy

- **Pure dev-tool-dark** (Vercel/Linear) would be safe but interchangeable — nothing to remember Dawn by.
- **Fully warm light-mode** would be brave but risks not reading as "serious infra" to the target engineer audience.
- **The whisper** keeps engineering credibility (dark, monospace for code, Inter for body, disciplined information density) while giving the brand a single distinctive thing: warmth baked into the palette + one signature visual (the sunrise-over-Earth hero) + one typographic counterpoint (Fraunces display).

The goal is that someone skimming the site can't point at why it feels different, but they remember it.

## Out of Scope

- Light-mode toggle (dark only).
- Multiple docs pages beyond Getting Started.
- Search functionality.
- Blog or changelog.
- Analytics or telemetry.
- Custom domain or deployment config.
- Animated hero motion (static composition; animation would risk feeling dated).
- i18n.
