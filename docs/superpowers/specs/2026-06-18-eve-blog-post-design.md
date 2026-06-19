# Blog post design — "Eve validates the shape. Now pick your runtime."

**Date:** 2026-06-18
**Type:** Marketing / philosophy blog post for the Dawn site (`apps/web/content/blog/`)
**Author voice:** Brian Love (see `docs/marketing/author-persona.md`)

## Goal

Respond to Vercel's launch of **eve** (open-source agent framework, June 17 2026) with a
gracious, builder-to-builder post that (1) celebrates eve, (2) frames the convergence as
validation of Dawn's thesis, (3) gives an honest side-by-side including where eve leads,
and (4) lands a CTA toward Dawn for teams outside the Vercel ecosystem.

## Decisions (from brainstorm)

- **Posture:** Gracious + honest side-by-side. Warm toward eve; name differences calmly,
  including where eve is stronger.
- **Sandbox gap:** Name it honestly. eve ships sandboxed compute as a first-class
  capability today; Dawn offers a permission-gated, path-jailed `ctx.fs` (explicitly *not*
  a security sandbox) and is heading toward pluggable execution backends.
- **CTA:** Try Dawn if you love this shape but aren't building on Vercel — same file-based
  conventions on LangChain's Agent Protocol / LangGraph.js, deployable to LangSmith.

## Verified facts

### eve (Vercel)
- Open-source (Apache 2.0), TypeScript, filesystem-first. Launched at Ship 26, June 17 2026.
- Agent = a directory of files. `agent.ts` (model), `instructions.md` (personality),
  optional dirs for tools, skills, subagents, channels, schedules. "Add a tool, skill,
  channel, or schedule by adding a file."
- Six built-in capabilities: durable execution, sandboxed compute, human-in-the-loop
  approvals, subagents, OpenTelemetry tracing, built-in evals.
- Sandbox backend is an adapter: Vercel Sandbox (deployed), Docker / microsandbox /
  just-bash (local).
- Model-agnostic ("any model, any MCP server"); launch demo uses Claude Opus 4.8.
- Channels: Slack, Discord, GitHub. Deploy: `vercel deploy` ships an ordinary Vercel
  project unchanged. Current version at launch eve@0.11.4; `npx eve@latest init`.

### Dawn (for accuracy)
- TypeScript meta-framework for LangGraph.js. Routes under `src/app/`; `agent()` descriptor;
  route-local tools with types inferred from TS; `state.ts`; `dawn dev` local loop.
- Runtime speaks LangGraph's **Agent Protocol** (`POST /threads/{id}/runs/stream`, etc.).
  `dawn build` emits `langgraph.json` → deploy to LangSmith.
- Built-in agent behavior: memory (`AGENTS.md`), planning (`plan.md`), skills
  (`skills/<name>/SKILL.md`), subagents.
- Sandbox posture: `ctx.fs` is permission-gated + path-jailed + timeout-capped, explicitly
  **not** a security sandbox; real sandbox isolation is the planned pluggable-backend path.

## Outline

1. **Hook — the news.** eve shipped; it looks great; I like it. Not a threat — validation.
2. **Why it's good news (personal trigger).** Dawn is built on this same thesis: agent apps
   need application *structure*. Independent convergence = signal the shape is right.
3. **Where eve and Dawn agree (shared thesis).** Short list of shared conventions.
4. **Honest side-by-side.** File conventions (near-identical); sandboxed compute (eve leads
   today — name the boundary); runtime & deploy (Vercel-native vs Agent Protocol/LangSmith);
   ecosystem (Vercel/AI SDK vs LangChain/LangGraph).
5. **The differentiator — the open-ecosystem bet.** eve's unchanged `vercel deploy` is its
   strength and its gravity well. Dawn's bet: Agent Protocol, self-hostable, vendor-neutral.
6. **Close + CTA.** Validation as the emotional close; practical next step is the Dawn
   scaffold + doc links. Link eve's launch sources so readers can judge for themselves.

## Constraints

- ~900–1,100 words, matching existing posts.
- No marketing superlatives unless tied to a concrete outcome. Don't say "no boilerplate."
- Don't overstate Dawn's production parity. Name the sandbox boundary plainly.
- Link to eve sources (Vercel changelog, docs, The New Stack, MarkTechPost).

## Sources

- https://vercel.com/changelog/introducing-eve-an-open-source-agent-framework
- https://vercel.com/docs/eve
- https://thenewstack.io/vercel-launches-eve-an-open-source-framework-that-treats-agents-as-directories/
- https://www.marktechpost.com/2026/06/17/vercel-releases-eve/
