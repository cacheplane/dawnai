# Positioning & Messaging Refresh — Design

**Date:** 2026-06-19
**Status:** Approved (design), pending spec review
**Scope:** Sub-project A of the eve/flue competitive-learnings sequence (items 3 + 4 + 5).

## Goal

Sharpen and unify Dawn's positioning across all three GTM surfaces, foreground
durability as a headline benefit, and make the workflow-vs-agent route duality
visible. Bring the README/npm in line with the website's stronger hero, wake the
unused paste-prompt CTA, and add two landing sections.

This is a **copy + light-component** change. No runtime/source behavior changes.

## Background & grounding

Three competitive learnings from eve (Vercel) and flue (Astro) — see
`memory/project_competitors_eve_flue.md`:

- **Item 3 (positioning + CTA):** the README tagline (*"The TypeScript
  meta-framework for LangGraph…"*) is weaker than and inconsistent with the
  website hero (*"Build LangGraph agents like Next.js apps. / Keep the runtime.
  Drop the boilerplate."*). The `CopyPromptButton` component exists with
  `hero`/`docs` variants but is **imported nowhere** — flue's
  paste-prompt-to-your-coding-agent acquisition tactic is one wiring change away,
  and `/AGENTS.md` + `llms-full.txt` routes already exist to point it at.
- **Item 4 (durability):** flue/eve sell durability directly because they *are*
  the runtime. Dawn deliberately says "not a runtime." Resolution (user
  decision): **lean in harder**, but honestly. Durability is a real `Dawn owns`
  deliverable — `mental-model.mdx` and `packages/cli/src/lib/runtime` confirm
  Dawn ships the default SQLite checkpointer + thread store
  (`@dawn-ai/sqlite-storage`, `.dawn/checkpoints.sqlite`, `.dawn/threads.sqlite`),
  so threads survive a `dawn dev` restart and an agent that pauses for human
  input resumes where it left off (`interruptCapable: kind === "agent"`). The
  claim is "Dawn makes durability the zero-config default path," NOT "Dawn is the
  durability runtime" — LangGraph still defines the checkpoint interface.
- **Item 5 (workflow/agent duality):** a real, shipped route model. A route's
  `index.ts` exports exactly one of `agent`, `workflow`, `graph`, `chain`
  (`packages/cli/src/lib/runtime/load-route-kind.ts`). Per `agents.mdx` /
  `routes.mdx`: **agent** = LLM-driven, picks tools at runtime, can pause for a
  human; **workflow** = deterministic typed async function when you control the
  order; **graph/chain** = raw-LangGraph escape hatches. This is flue's
  Workflows-vs-Agents duality, expressed as one consistent routing/typing/dev-loop
  model. It is currently buried in a `mental-model.mdx` tl;dr bullet and absent
  from the landing page.

## Approach

**Approach A — Layer onto the winning hero** (chosen over a durability-forward or
dual-mode hero rewrite). Keep the hero headline as the anchor; layer durability
and the duality in as strong secondary messages; unify the README to the hero.
This preserves existing brand equity and keeps the sharpest line
(*"Build LangGraph agents like Next.js apps"*) intact while giving durability
headline-adjacent prominence.

## Canonical messaging constants (reused verbatim across surfaces)

**M1 — Unified lead (README opening, realigned to the hero):**
> Build LangGraph agents like Next.js apps. Dawn adds file-system routing,
> route-local tools, generated types, durable threads, and an HMR dev server to
> your existing LangGraph.js stack — keep the runtime, drop the boilerplate.

**M2 — Durability paragraph ("Durable by default"):**
> Every Dawn app ships a working checkpointer and thread store — no setup. Runs
> checkpoint to SQLite between turns, so threads survive a `dawn dev` restart and
> an agent that pauses for human input resumes exactly where it left off.
> LangGraph defines the checkpoint interface; Dawn ships the default
> implementation, so durability is the path of least resistance — not a wiring
> task.

**M3 — Duality paragraph ("Two ways to drive the model"):**
> Export an `agent` when the model should decide what to do — it picks tools at
> runtime and can pause for a human. Export a `workflow` when you own the order
> of operations — a deterministic, typed async function. Same routing, same
> types, same dev loop; you choose who's in charge. Drop to `graph` or `chain`
> for raw LangGraph anytime.

**M4 — Coding-agent scaffold prompt (the CTA payload):**
> Scaffold a new Dawn app and help me build an agent. Dawn is the TypeScript
> meta-framework for LangGraph: agents and workflows are file-system routes with
> route-local tools, generated types, and durable threads. Run
> `pnpm create dawn-ai-app` to start, then read https://dawnai.org/AGENTS.md and
> https://dawnai.org/llms-full.txt for the full framework reference before
> writing any routes.

(M4 wording is finalized during implementation against the live `/AGENTS.md` and
`llms-full.txt` content; the intent — scaffold + point the agent at the canonical
machine docs — is fixed here.)

## Surface 1 — Website landing (`apps/web`)

Components live in `apps/web/app/components/landing/`; the order is set in
`apps/web/app/page.tsx`. New sections follow the existing section conventions
(`Eyebrow` + display `<h2>` + `text-ink-muted` body; see `WhyDawn.tsx`,
`KeepTheRuntime.tsx`).

1. **Hero subhead (`Hero.tsx`)** — add `durable threads` to the existing
   capability list (apply M1's list). Headline unchanged. Add a **secondary CTA**:
   wire the existing `CopyPromptButton` (`variant="hero"`) next to the
   `CopyCommand`, copying **M4**. Keep "Read the docs" link.
2. **New `DurableByDefault.tsx`** — eyebrow "Durability", heading
   "Durable by default.", body **M2**. Optionally a small `Card` listing the
   three concrete payoffs (survives dev restart / resumes after human interrupt /
   zero-config SQLite checkpointer). Insert in `page.tsx` **after
   `FeatureDevLoop`, before `KeepTheRuntime`** (so "what Dawn does NOT do" still
   immediately precedes the Ecosystem/Quickstart close).
3. **New `DriveTheModel.tsx`** — eyebrow "Route shapes", heading
   "Two ways to drive the model.", body **M3**, with a compact two-column
   `agent` vs `workflow` comparison and a one-line `graph`/`chain` footnote.
   Insert in `page.tsx` **after `WhyDawn`, before `FeatureRouting`** (it frames
   the core model choice before the authoring-feature trio).

Resulting `page.tsx` order: Hero → ProofStrip → WhyDawn → **DriveTheModel** →
FeatureRouting → FeatureTools → FeatureTypes → FeatureDevLoop →
**DurableByDefault** → KeepTheRuntime → Ecosystem → Quickstart → Faq → FinalCta.

**Accuracy guardrail:** the "resumes after human interrupt" claim is an
**agent-route** property (`interruptCapable: kind === "agent"`). Copy must not
imply workflow/graph/chain routes are interrupt-resumable. Between-turn
SQLite checkpointing applies to threaded runs generally.

## Surface 2 — README + npm package READMEs

- **Root `README.md`:** replace the current tagline line (line 11) with **M1**.
  Add durability to the "Why Dawn?" list (a bullet derived from M2) and a short
  duality note (derived from M3) — either a new bullet or a one-paragraph
  "Choose your route shape" block above/below the existing
  "Without Dawn / With Dawn". Keep the existing CTA band, Quickstart, live
  `dawnai.org/docs` links, and Learn-more list unchanged.
- **Tier-1 package READMEs** (`packages/sdk`, `packages/cli`,
  `packages/create-dawn-app`, `packages/langchain`): realign only the opening
  descriptive sentence to the unified M1 framing (lead with the Next.js analogy
  / keep the "meta-framework for LangGraph" anchor phrase for SEO), and mention
  durable threads where natural. Do **not** restructure these READMEs; the
  CTA band, links, and bodies from the prior GTM refresh stay.

## Surface 3 — Docs (`apps/web/content/docs`)

- **`mental-model.mdx`:** promote the buried duality. Add a short
  "Two ways to drive the model" subsection (body **M3**) near the existing
  route-kinds tl;dr, and expand the existing "The runtime" / "Where Dawn ends and
  LangGraph begins" durability lines into an explicit **"Durable by default"**
  callout (body **M2**), cross-linking `agents.mdx` and `routes.mdx` (which
  already define the shapes — no change needed there).
- No new docs pages; `agents.mdx` and `routes.mdx` already carry accurate
  per-shape definitions and are the link targets.

## Out of scope (YAGNI)

- No hero **headline** rewrite (Approaches B/C rejected).
- No new docs pages, no blog post (a launch post can follow separately).
- No changes to `agents.mdx` / `routes.mdx` content (already accurate).
- No Tier-2 package README changes.
- No new brand assets / OG image changes.
- The bundled-docs/SKILL.md work (item 2) and blueprints (item 1) are separate
  sub-projects B and C.

## Testing & verification

- `apps/web` builds (`pnpm --filter web build` or repo build) with the two new
  components and updated `page.tsx`.
- `node scripts/check-docs.mjs` passes (doc links / retired-domain gate).
- `pnpm pack:check` passes (packaged READMEs valid).
- Manual: landing renders both new sections in the specified order; hero
  "Copy prompt" button copies M4; README tagline matches the hero.
- Grep guardrail: no copy claims workflow/graph/chain routes resume after a
  human interrupt.

## Risks

- **Overclaim risk on durability** — mitigated by the accuracy guardrail and by
  crediting LangGraph with the checkpoint interface in M2.
- **Live-site copy change** — the hero headline is preserved; changes are
  additive sections + a subhead list item, minimizing regression surface.
