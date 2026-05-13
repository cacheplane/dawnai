# SaaS Rebrand PR 5 — KeepTheRuntime + Ecosystem + Quickstart Plan

> superpowers:subagent-driven-development.

**Goal:** Add three cream-palette sections — `KeepTheRuntime` (trust/compatibility editorial), `Ecosystem` (text-and-mark grid grouped by category), `Quickstart` (three-step evaluator path). Drop six cosmic sections (`NotAReplacement`, `ComparisonTable`, `ArchitectureSection`, `DeploySection`, `EcosystemSection`, `HowItWorks`) from `page.tsx` — their content is absorbed.

**Spec:** § Page IA · #9 Keep the runtime, #10 Ecosystem, #11 Quickstart.

---

## File Structure

**New (`apps/web/app/components/landing-v2/`):**
- `KeepTheRuntime.tsx`
- `Ecosystem.tsx`
- `Quickstart.tsx`

**Modified:**
- `apps/web/app/page.tsx` — wire 3 new sections in, drop 6 cosmic imports/usages.

---

## Tasks

1. **KeepTheRuntime** — Eyebrow "Compatibility", H2 "Your bet on LangGraph.js stays your bet.", two paragraphs + "What Dawn does NOT do" list (4 items with × icons).
2. **Ecosystem** — Eyebrow "Ecosystem", H2 "Plays well with your stack.", four category groups (Models / Observability / Vector stores / Deploy targets), each a `ProviderMark` row.
3. **Quickstart** — Eyebrow "Try it", H2 "Three steps to know if Dawn fits.", three numbered Cards: scaffold (with CopyCommand), run an example, port a graph. Closing links to Docs and Examples.
4. **page.tsx** — add the three sections after FeatureDevLoop; drop the 6 cosmic imports/usages.
5. **Lint + push + PR + merge on green.**

---

## Out of scope

- Comic strip, BigReveal, StarsSection, MigrateCta, CtaSection — stay until PR 6.
