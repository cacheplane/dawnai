# Docs Content Pass — Phase B Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the docs sidebar, extract Agents into its own page, trim `routes.mdx` to remove duplication, polish all existing pages for structural consistency.

**Architecture:** Pure content + nav changes. One nav file, one new MDX page, one new route, light edits to 10 existing MDX files. No new components.

**Tech Stack:** MDX, Next.js 16 App Router, TypeScript.

**Spec:** `docs/superpowers/specs/2026-05-10-docs-content-phase-b-design.md`

---

## File structure

**New:**
- `apps/web/content/docs/agents.mdx`
- `apps/web/app/docs/agents/page.tsx`

**Modified:**
- `apps/web/app/components/docs/nav.ts` — relabel sections, add Agents
- `apps/web/content/docs/routes.mdx` — trim duplicated explainers
- `apps/web/content/docs/{getting-started,tools,state,middleware,retry,testing,dev-server,deployment,cli}.mdx` — light polish to fit Lede → Examples → Reference → Related shape

---

## Task 1: Restructure sidebar nav

**Files:**
- Modify: `apps/web/app/components/docs/nav.ts`

- [ ] **Step 1: Replace `DOCS_NAV` const with the restructured version**

In `apps/web/app/components/docs/nav.ts`, find:

```ts
export const DOCS_NAV: readonly DocsNavSection[] = [
  {
    label: "Start",
    items: [{ label: "Getting Started", href: "/docs/getting-started" }],
  },
  {
    label: "Core Concepts",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Middleware", href: "/docs/middleware" },
      { label: "Retry", href: "/docs/retry" },
    ],
  },
  {
    label: "Workflow",
    items: [
      { label: "Testing", href: "/docs/testing" },
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Deployment", href: "/docs/deployment" },
    ],
  },
  {
    label: "Reference",
    items: [{ label: "CLI", href: "/docs/cli" }],
  },
]
```

Replace with:

```ts
export const DOCS_NAV: readonly DocsNavSection[] = [
  {
    label: "Get Started",
    items: [{ label: "Getting Started", href: "/docs/getting-started" }],
  },
  {
    label: "Concepts",
    items: [
      { label: "Routes", href: "/docs/routes" },
      { label: "Agents", href: "/docs/agents" },
      { label: "Tools", href: "/docs/tools" },
      { label: "State", href: "/docs/state" },
      { label: "Middleware", href: "/docs/middleware" },
      { label: "Retry", href: "/docs/retry" },
    ],
  },
  {
    label: "Tooling",
    items: [
      { label: "Dev Server", href: "/docs/dev-server" },
      { label: "Testing", href: "/docs/testing" },
      { label: "Deployment", href: "/docs/deployment" },
    ],
  },
  {
    label: "Reference",
    items: [{ label: "CLI", href: "/docs/cli" }],
  },
]
```

- [ ] **Step 2: Verify type-check (will fail until agents page exists, that's fine)**

Run from worktree root:
```
pnpm --filter @dawn-ai/web typecheck
```

Expected: PASS. The `/docs/agents` href is just a string until step 3's page is added — typecheck does not verify route existence.

Build will fail in `search-index.ts` because it tries to read `apps/web/content/docs/agents.mdx`. **Skip the build verification until Task 2 lands the file.**

- [ ] **Step 3: Commit**

```
git add apps/web/app/components/docs/nav.ts
git commit -m "feat(web): restructure docs sidebar — relabel sections, add Agents entry"
```

---

## Task 2: Create `apps/web/content/docs/agents.mdx`

**Files:**
- Create: `apps/web/content/docs/agents.mdx`

- [ ] **Step 1: Write the file**

Create `apps/web/content/docs/agents.mdx` with the following content:

````mdx
# Agents

An agent is the default scaffolded route in Dawn — an LLM-driven workflow that picks tools at runtime. It's the path we recommend when you want the model to decide what to do; for deterministic flows, prefer a `workflow`, `graph`, or `chain`.

## A minimal agent

A route's `index.ts` exports an agent created by `agent({ model, systemPrompt })`. Tools in the sibling `tools/` directory are auto-registered; the LLM picks when to call them.

```typescript
// src/app/(public)/hello/[tenant]/index.ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a helpful assistant for the {tenant} organization. Answer questions about the tenant.",
})
```

Tools live next to the agent:

```
src/app/(public)/hello/[tenant]/
├── index.ts          ← the agent
└── tools/
    └── greet.ts      ← auto-bound to the agent
```

Each tool is a TypeScript file with a default export. Param types are inferred from the function signature at `dawn build` time and made available to the agent.

## When to pick an agent

Dawn supports four route entry shapes. Pick the one that fits the problem:

- **Agent** — LLM-driven, model picks tools at runtime. Default for conversational and discovery-style routes.
- **Workflow** — deterministic async function with a typed state. Pick when you control the order of operations.
- **Graph** — full LangGraph DSL with branching, looping, and conditional edges. Pick when the flow has structure the model shouldn't decide.
- **Chain** — LangChain LCEL `Runnable`. Pick for simple linear pipelines.

A route's `index.ts` exports exactly one of these. You can mix shapes across routes inside the same project.

## Tool auto-binding

Any TypeScript file in a route's `tools/` directory is auto-registered with the agent. No manual `tools: [...]` config — Dawn discovers them at build time.

```typescript
// src/app/(public)/hello/[tenant]/tools/greet.ts
export default async (input: { readonly tenant: string }) => {
  return { greeting: `Hello, ${input.tenant}!` }
}
```

The exported parameter type is read by Dawn's compiler integration and turned into a JSON schema for the LLM. The agent calls `tools.greet({ tenant })` at runtime; the model decides when.

See [Tools](/docs/tools) for the full input/output rules and the generated declarations.

## Retry

Agent calls accept a `retry` config that wraps every tool invocation:

```typescript
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "...",
  retry: { maxAttempts: 3, baseDelay: 250 },
})
```

This applies to tool calls and the model call itself. See [Retry](/docs/retry) for backoff strategy, what's retried, and per-tool overrides.

## Streaming

By default, tool results stream back through the dev server. The deployment protocol exposes streaming via `/runs/stream` and the LangGraph Platform contract. See [Dev Server](/docs/dev-server) for the protocol details.

## Related

- [Routes](/docs/routes) — pathname rules and route entry shapes
- [Tools](/docs/tools) — tool input/output rules, type inference
- [State](/docs/state) — when an agent reads or returns structured state
- [Retry](/docs/retry) — retry config and backoff
````

- [ ] **Step 2: Verify build (will still fail until Task 3 adds the route page)**

Skip — Task 3 wires the route. The build failure between Tasks 2 and 3 is expected and brief.

- [ ] **Step 3: Commit**

```
git add apps/web/content/docs/agents.mdx
git commit -m "docs: add Agents page (extracted from routes.mdx, expanded)"
```

---

## Task 3: Create the Agents route page

**Files:**
- Create: `apps/web/app/docs/agents/page.tsx`

- [ ] **Step 1: Create the file**

Create `apps/web/app/docs/agents/page.tsx`:

```tsx
import type { Metadata } from "next"
import Content from "../../../content/docs/agents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"

export const metadata: Metadata = { title: "Agents" }

export default function Page() {
  return <DocsPage href="/docs/agents" Content={Content} />
}
```

- [ ] **Step 2: Verify build, typecheck, lint**

```
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

All three should PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/app/docs/agents/page.tsx
git commit -m "feat(web): mount /docs/agents route"
```

---

## Task 4: Trim `routes.mdx`

**Files:**
- Modify: `apps/web/content/docs/routes.mdx`

- [ ] **Step 1: Replace with the trimmed version**

Read the current file first to capture any unique content not covered by the dedicated pages, then overwrite `apps/web/content/docs/routes.mdx` with:

````mdx
# Routes

A route is a folder under `src/app/`. Its path becomes the agent endpoint. A route's `index.ts` exports exactly one entry shape: `agent`, `workflow`, `graph`, or `chain`.

## Route entry

Every route has an `index.ts` that exports one of:

- **`agent`** — an LLM-driven flow with auto-bound tools. The default scaffold export. See [Agents](/docs/agents).
- **`workflow`** — a deterministic async function with typed state. See [Routes / workflow](#workflow) below.
- **`graph`** — a LangGraph graph. Branching, looping, conditional edges.
- **`chain`** — a LangChain LCEL `Runnable`. Simple linear pipelines.

## Pathname rules

Routes follow the same conventions as the Next.js App Router:

- `(group)/` — route group, excluded from the path
- `[segment]/` — dynamic segment, becomes a typed field on the route's state
- `[...rest]/` — catch-all
- `[[...optional]]/` — optional catch-all

Example tree:

```
src/app/
  (public)/
    hello/
      [tenant]/
        index.ts        ← exports agent | workflow | graph | chain
        state.ts        ← optional, route state schema
        tools/
          greet.ts      ← auto-bound to agents
        middleware.ts   ← optional, runs before the route
```

The `(public)/` segment is excluded from the path, so this route is `/hello/[tenant]`.

## workflow

A `workflow` is a deterministic async function. The first argument is the typed route state; the second is a `RuntimeContext` that exposes auto-bound tools.

```typescript
// src/app/(public)/hello/[tenant]/index.ts
import type { RuntimeContext } from "@dawn-ai/sdk"
import type { RouteTools } from "dawn:routes"
import type { HelloState } from "./state.js"

export async function workflow(
  state: HelloState,
  ctx: RuntimeContext<RouteTools<"/hello/[tenant]">>,
) {
  const r = await ctx.tools.greet({ tenant: state.tenant })
  return { ...state, greeting: r.greeting }
}
```

The `RouteTools<"/hello/[tenant]">` generic resolves to the union of tools auto-discovered in this route's `tools/` directory.

## graph

Export a compiled LangGraph graph as `default`:

```typescript
import { StateGraph, START, END } from "@langchain/langgraph"
import type { HelloState } from "./state.js"

export default new StateGraph<HelloState>({ channels: { /* ... */ } })
  .addNode("greet", async (state) => state)
  .addEdge(START, "greet")
  .addEdge("greet", END)
  .compile()
```

The graph receives the same typed state and runs through Dawn's runtime. State channels still need to be declared (LangGraph requirement).

## chain

Export a LangChain LCEL `Runnable`:

```typescript
import { RunnableSequence } from "@langchain/core/runnables"

export default RunnableSequence.from([
  // chain steps
])
```

## Running a route

Routes dispatch by path:

```bash
$ dawn run '/hello/acme'
$ dawn dev    # HMR + dev server
```

Programmatic dispatch is also available — see [Dev Server](/docs/dev-server) for the runtime API and the `/runs/wait` / `/runs/stream` endpoints.

## Related

- [Agents](/docs/agents) — the default scaffold export
- [Tools](/docs/tools) — co-located tool files, type inference
- [State](/docs/state) — typed route state, dynamic segment binding
- [Middleware](/docs/middleware) — auth, logging, request gates
- [Retry](/docs/retry) — retry strategy at agent / tool level
````

- [ ] **Step 2: Verify build**

```
pnpm --filter @dawn-ai/web build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/content/docs/routes.mdx
git commit -m "docs: trim routes.mdx — drop duplicated Agents/Tools/State/Middleware sections"
```

---

## Task 5: Polish all docs pages for structural consistency

**Files:**
- Modify: every MDX in `apps/web/content/docs/` except `agents.mdx` and `routes.mdx` (already shaped)

This task touches 9 pages. The subagent should treat each page as one mini-step.

- [ ] **Step 1: Audit each page against the structure checklist**

Per page, confirm:

1. **Lede** — first 1–2 paragraphs explain *what this is and why it exists*. No headings before the lede.
2. **Canonical examples** — H2 sections, code-first wherever possible.
3. **Reference / API** — H2 or H3 sections for type signatures, where applicable.
4. **Related** — final H2 with bulleted links to neighboring concept pages. Use `/docs/<slug>` links.
5. **No forward references** — no "we'll cover this later" text. Each page stands alone.
6. **Active voice** — declarative sentences. Drop "you can", "you should" where redundant.

Files to audit:
- `apps/web/content/docs/getting-started.mdx`
- `apps/web/content/docs/tools.mdx`
- `apps/web/content/docs/state.mdx`
- `apps/web/content/docs/middleware.mdx`
- `apps/web/content/docs/retry.mdx`
- `apps/web/content/docs/testing.mdx`
- `apps/web/content/docs/dev-server.mdx`
- `apps/web/content/docs/deployment.mdx`
- `apps/web/content/docs/cli.mdx`

For each page:
- If a Related section is missing, add one with 2–4 cross-links.
- If forward references exist, rewrite them as references to a page that stands alone or remove them.
- If passive voice or "you can/should" hedges appear, tighten to active.
- Keep page length within 80–160 lines.

- [ ] **Step 2: Verify build**

```
pnpm --filter @dawn-ai/web build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/content/docs
git commit -m "docs: structural consistency pass — uniform Lede → Examples → Reference → Related"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run all checks**

```
pnpm --filter @dawn-ai/web build
pnpm --filter @dawn-ai/web typecheck
pnpm --filter @dawn-ai/web lint
```

Expected: all PASS.

- [ ] **Step 2: Manual smoke**

If the dev server is running, visit `http://localhost:3000/docs/getting-started`. Verify:

- Sidebar shows: `GET STARTED`, `CONCEPTS`, `TOOLING`, `REFERENCE`
- `CONCEPTS` lists: Routes, Agents, Tools, State, Middleware, Retry
- `TOOLING` lists Dev Server first, then Testing, then Deployment
- Click `Agents` — page loads at `/docs/agents` with the expected content
- Click `Routes` — trimmed page renders without duplicated explainers; Related links visible at the bottom
- Spot-check 2–3 other pages — each ends with a `Related` section

- [ ] **Step 3: Tweak commit if needed**

If smoke testing surfaced something to fix:

```
git add apps/web
git commit -m "chore(web): tune docs after content pass smoke test"
```

If nothing needed fixing, skip.

---

## Verification checklist

- [ ] Sidebar relabeled: `Get Started`, `Concepts`, `Tooling`, `Reference`
- [ ] Concepts includes the new `Agents` entry
- [ ] Tooling reordered: Dev Server, Testing, Deployment
- [ ] `/docs/agents` route exists and renders
- [ ] `routes.mdx` no longer contains duplicated Agents/Tools/State/Middleware mini-explainers
- [ ] Every docs page ends with a `## Related` section
- [ ] No `"we'll cover this later"` style forward references in any page
- [ ] `pnpm --filter @dawn-ai/web build && typecheck && lint` all PASS
- [ ] Manual smoke at `/docs/getting-started` confirms the new sidebar
