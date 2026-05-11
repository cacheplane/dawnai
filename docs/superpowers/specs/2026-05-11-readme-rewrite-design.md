# README rewrite — sales-first, LangSmith framing

**Date:** 2026-05-11
**Status:** Design approved, pending spec review

## Problem

The current root [README.md](../../../README.md) reads like a contract specification rather than a pitch. A LangGraph user landing on the repo has to read 250+ lines of dense reference material (App Contract, Commands list, Packages list, Current Boundaries, Development) before they understand whether Dawn solves a problem they have. There is no hook, no value prop above the fold, no visual, and the marquee code sample is buried below caveats.

Inspiration: Richard Kim's "[How To Get Thousands of Stars on Your Github Project](https://blog.cwrichardkim.com/how-to-get-hundreds-of-stars-on-your-github-project-345b065e20a2)". Core lesson: most viewers glance and leave; the README has to sell the project to that audience, not document it for committed users (docs site does that).

Additionally, the current README uses outdated branding ("LangGraph Platform") for what LangChain now calls "LangSmith Deployment." Dawn's `dawn build` still emits a `langgraph.json` package — that artifact and the LangGraph framework name are unchanged — but the deploy destination is **LangSmith**.

## Goals

1. Restructure the README so a LangGraph user understands the value prop within 10 seconds of scrolling.
2. Lead with the pain Dawn solves: graph boilerplate and lack of project structure.
3. Show, don't tell: a side-by-side code comparison (raw LangGraph vs Dawn `agent()`).
4. Move reference material (App Contract, full Commands list, Packages list, Development details) off the README and link to [dawn-ai.org/docs](https://dawn-ai.org/docs) and [CONTRIBUTORS.md](../../../CONTRIBUTORS.md).
5. Update LangGraph Platform → LangSmith terminology in the README only. The wider repo sweep is handled by a separate follow-up PR.

## Non-goals

- No demo gif in this PR. A `dawn dev` recording is a follow-up.
- No changes to the docs site, scaffolding templates, or any file outside `README.md`.
- No content changes to CONTRIBUTORS.md, CONTRIBUTING.md, SECURITY.md, or CODE_OF_CONDUCT.md (we only link to them).

## Target audience for the rewrite

LangGraph / LangChain users who are tired of hand-authoring graphs and want authoring ergonomics + a real local dev loop + a build/deploy pipeline. They already know what an agent, a graph, and `langgraph.json` are. The pitch is "framework on top of LangGraph that kills the boilerplate."

## New README structure

Sections, in order:

1. **Logo** — keep `docs/brand/dawn-logo-horizontal-black-on-white.png`.
2. **Badges** — keep CI, OpenSSF Scorecard, License.
3. **Tagline** — one sentence, why-you-want-it.
4. **Why Dawn?** — 4 bullets, pain-driven.
5. **Without Dawn / With Dawn** — side-by-side fenced code blocks.
6. **Quickstart** — keep current 4 steps, lightly polished.
7. **30-Second Route** — keep, lightly trimmed.
8. **Learn more** — the existing bulleted docs.dawn-ai.org links.
9. **Contributing / Security** — collapsed to 2 lines with file links.
10. **License** — one line.

Expected length: ~80 lines (vs ~254 today).

## Content

### Tagline (replaces line 11)

> The meta-framework for LangGraph. Author agents and workflows as filesystem routes, get types and a local dev server for free, and ship to LangSmith with one command.

### Why Dawn? (new section)

- **Kill the graph boilerplate.** Export one `agent({ model, systemPrompt })` descriptor. Dawn discovers it, binds route-local tools, and emits a `langgraph.json` package ready for LangSmith.
- **Real project structure.** Filesystem routes under `src/app/` — colocate state schemas, tools, middleware, and tests next to the route they belong to. No more ad-hoc folders.
- **A local dev loop LangGraph never shipped.** `dawn dev` runs your routes locally with the same semantics as production. Iterate in seconds, not deploys.
- **Typed end to end.** Route params, state, and tool I/O are generated as TypeScript types. `dawn verify` is your pre-deploy gate.

### Without Dawn / With Dawn (new section)

A two-column visual:

> Same `langgraph.json`, deployable to LangSmith. ~4× less code to author.

**Left ("Without Dawn"):** ~25–30 lines of representative LangGraph wiring — `StateGraph`, `add_node`, `add_edge`, a `ToolNode`, `.compile()`, and a hand-authored `langgraph.json` snippet. Should look like real, recognizable LangGraph code. Implementation will pull a realistic minimal example from the LangGraph docs.

**Right ("With Dawn"):** the existing `agent()` example (~8 lines) plus a one-line `tools/greet.ts` reference. The point is volume: Dawn collapses the imperative graph wiring into a declarative descriptor.

If GitHub markdown doesn't render the side-by-side cleanly, fall back to two sequential fenced blocks with `**Without Dawn**` / `**With Dawn**` headers. Decision is made during implementation by previewing the rendered README.

### Quickstart (kept)

Keep the current 4 numbered steps verbatim. They work.

### 30-Second Route (kept, trimmed)

Keep the existing `agent()` code block and the surrounding paragraph. Trim the explanatory sentence after the code block to one line — the side-by-side already does the heavy lifting.

### Learn more (lightly edited)

Keep the existing bullet list of docs.dawn-ai.org links unchanged.

### Footer

Collapse to:

> Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Repo layout and dev commands in [CONTRIBUTORS.md](./CONTRIBUTORS.md). Security: [SECURITY.md](./SECURITY.md). Please follow the [Code of Conduct](./CODE_OF_CONDUCT.md). MIT licensed — see [LICENSE](./LICENSE).

## Content to remove from README

- **Status section** (lines 13–15): caveats fold into tagline / Why bullets, or are dropped. Specifically:
  - "Dawn does not host or run production traffic" → implied by "ship to LangSmith."
  - "not a LangSmith trace replacement" → drop. Negative framing; the docs site can clarify.
  - "not a hosted platform" → drop. Same reason.
- **App Contract section** (lines 63–134): lives on [dawn-ai.org/docs/routes](https://dawn-ai.org/docs/routes) and friends. Reference docs, not marketing.
- **Commands section** (lines 135–190): drop entirely. The Learn more block already links to [dawn-ai.org/docs/cli](https://dawn-ai.org/docs/cli), and `dawn --help` is the canonical surface.
- **Packages section** (lines 191–202): not relevant to a first-time visitor. Move to CONTRIBUTORS.md if not already there, otherwise drop (it can be inferred from the monorepo).
- **Current Boundaries section** (lines 204–208): drop. The tagline + Why bullets carry this implicitly.
- **Development section** (lines 223–243): drop. CONTRIBUTORS.md already covers this; the new footer links there.

## LangGraph Platform → LangSmith terminology updates (README scope only)

Replace within the README:

- Line 11 (current tagline): "LangGraph Platform deployment artifacts" → reframed entirely (see new tagline).
- Line 15 ("LangGraph Platform runs"): section is removed.
- Line 185 ("LangGraph Platform deployment artifacts"): in the new structure the build command, if mentioned at all, says "produces a `langgraph.json` package for LangSmith."
- Line 206 ("LangGraph Platform"): section is removed.

The wider repo sweep is out of scope for this PR — spawned as a separate task.

## Implementation approach

Single edit to [README.md](../../../README.md). The change is large enough that a full rewrite via `Write` is cleaner than incremental `Edit` calls. After writing:

1. Render the README locally (or push to a draft PR and view on GitHub) to confirm:
   - The side-by-side renders acceptably (or fall back to sequential blocks).
   - All links resolve.
   - No broken markdown.
2. Run `node scripts/check-docs.mjs` (the repo's link-check / docs validator). The new README must pass it.
3. Run `pnpm lint` for any markdown linting.

## Risks and mitigations

- **Risk:** Cutting the Packages section removes discoverability for the monorepo layout.
  **Mitigation:** Anyone exploring the monorepo will land in `packages/` directly or in CONTRIBUTORS.md. Marketing real estate is not where this belongs.
- **Risk:** Cutting the Commands list removes a CLI cheat-sheet some users relied on.
  **Mitigation:** `dawn --help` and the CLI docs page cover the same ground; the README pointer to both is sufficient.
- **Risk:** The "Without Dawn" LangGraph snippet could misrepresent typical LangGraph code if too contrived.
  **Mitigation:** Base it on a real example from LangGraph's own quickstart so it can't be dismissed as a straw man.
- **Risk:** "ship to LangSmith with one command" overstates `dawn build` (which produces artifacts; the user still runs `langgraph deploy` or uploads to LangSmith).
  **Mitigation:** The Quickstart and 30-Second Route paragraphs can clarify the exact mechanic without weakening the tagline.

## Out of scope (follow-ups)

1. **Hero gif** of `dawn dev` running a route, added above the side-by-side block. Separate PR.
2. **Repo-wide LangGraph Platform → LangSmith rename** across `docs/`, `apps/web/`, scaffolding. Spawned as a separate task.
3. **Concept graphic** showing `src/app/` → `dawn build` → LangSmith. Nice-to-have, not scheduled.
