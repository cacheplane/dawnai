# SaaS Rebrand PR 4 — Feature Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Add four feature sections (Routing, Tools, Types, Dev loop) built on a reusable `FeatureBlock` primitive. Drop `FeatureGrid` and `CodeExample` from `page.tsx` (their content is absorbed into the four feature blocks).

**Architecture:** A single `FeatureBlock.tsx` primitive renders the section shape (eyebrow + H2 + paragraph + bullet list + visual + link), with the visual on the left or right depending on a prop so the page alternates. Each of the four feature sections is a server component that highlights code with `highlightLight` and composes `FeatureBlock`.

**Spec:** § Page IA · #5 Routing, #6 Tools, #7 Types, #8 Dev loop

---

## File Structure

**New (`apps/web/app/components/landing-v2/`):**
- `FeatureBlock.tsx` — reusable section layout (text + visual columns, alternating side)
- `FeatureRouting.tsx`
- `FeatureTools.tsx`
- `FeatureTypes.tsx`
- `FeatureDevLoop.tsx`

**Modified:**
- `apps/web/app/page.tsx` — render the 4 features after WhyDawn; drop `FeatureGrid` and `CodeExample`

---

## Tasks

1. **FeatureBlock primitive** — layout/spacing/typography only, no content. Props: `eyebrow`, `heading`, `paragraph`, `bullets` (string[]), `link` (`{ href, label }`), `visual` (ReactNode), `imageSide` (`"left" | "right"`).
2. **FeatureRouting** — Eyebrow "Routing", H2 "Routes for agents, not just pages.", paragraph + 4 bullets, code-right (file tree comment + route file), link "See routing docs →".
3. **FeatureTools** — Eyebrow "Tools", H2 "Tools that live next to the route that uses them.", code-left (tool snippet with inferred Zod types).
4. **FeatureTypes** — Eyebrow "Types", H2 "Types that follow the data.", code-right (state schema → inferred type usage).
5. **FeatureDevLoop** — Eyebrow "Dev loop", H2 "Edit, save, reload — without restarting the graph.", code-left (terminal-style block).
6. **page.tsx** — wire features in, drop FeatureGrid + CodeExample imports/usages.
7. **Lint, push, PR, merge on green.**

All commit messages follow the same `feat(web): ...` pattern.

---

## Verification

Per task: `pnpm --filter @dawn-ai/web typecheck && pnpm --filter @dawn-ai/web build`. After all tasks: `pnpm lint`.

CI: `pnpm ci:validate`.

---

## Out of scope

- Real VS Code screenshots / terminal recordings (PR 8 calibration may add them).
- HowItWorks removal (PR 5 — replaced by Quickstart).
