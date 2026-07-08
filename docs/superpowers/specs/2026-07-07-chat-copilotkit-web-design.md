# Chat UI on CopilotKit (AG-UI) — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan
**Author:** Brian Love (with Claude)
**Parent design:** `docs/superpowers/specs/2026-07-07-ag-ui-copilotkit-ui-design.md` (this is sub-project 2)
**Base branch:** `blove/ag-ui-capability` (PR #322 — the `@dawn-ai/ag-ui` package + `POST /agui/{routeId}` endpoint). This slice stacks on it.

## Summary

Rebuild `examples/chat/web` as a **CopilotKit v2** application that connects to the
Dawn chat server through its AG-UI endpoint (`POST /agui/{routeId}`). This replaces
the throwaway hand-rolled SSE UI with the **canonical reference** for "connect a web
client to Dawn." It runs **live** against a real model — there is no aimock/demo
mode in the web client (the deterministic, no-key proof of the connection already
lives in PR #322's `/agui` endpoint e2e). Scope is the `/chat` route only;
`/coordinator` (subagents) is a fast-follow.

## Motivation & Context

- The current `examples/chat/web` is a hand-rolled Next.js page that manually parses
  Dawn's bespoke SSE envelope and implements its own permission-resume plumbing
  (`app/page.tsx`, `app/api/chat/route.ts`, `app/api/permission-resume/route.ts`).
  It exists for smoke testing and is explicitly throwaway.
- PR #322 makes Dawn speak the **AG-UI protocol**, so a standard AG-UI frontend —
  CopilotKit — can drive Dawn agents. The chat example is the forcing function to
  prove that path is real and pleasant.
- CopilotKit's own repo predominantly uses the **v2** API (`@copilotkit/react-core/v2`),
  and its `examples/v2/interrupts-langgraph` is nearly our exact case: a CopilotKit
  UI driving an AG-UI agent via `HttpAgent`, with `useInterrupt` for approvals and
  `useCoAgent` for shared state. We mirror it.

## Decisions

1. **CopilotKit v2** (`@copilotkit/react-core/v2` + `@copilotkit/react-ui` +
   `@copilotkit/runtime`, pinned to the current `1.62.x` line). The GraphQL-bearing
   `CopilotRuntime` lives only in the example's Next.js route, never in Dawn core.
2. **No demo mode / no aimock in the web client.** It is the canonical live-connection
   demo. `pnpm dev` runs the Dawn server (holds `OPENAI_API_KEY`) + the web app
   (no key). The deterministic connection proof is PR #322's `/agui` e2e.
3. **`/chat` route only** for this slice. `/coordinator` (subagents) is a fast-follow.
4. **Thin Dawn wrapper components** isolate CopilotKit's v1/v2 churn behind our own
   `PermissionInterrupt` and `TodosPanel`, so a future CopilotKit migration touches
   few files.

## Goals

- A polished, canonical example of driving a Dawn agent from a CopilotKit web client
  over AG-UI: streaming chat, live plan/todos, and HITL approve/deny.
- Runs with `pnpm dev` (server + web); the web app needs no API key of its own.
- `turbo build` + `typecheck` clean (the web package is already in the workspace).
- Documented live smoke as the manual verification.

## Non-Goals

- No aimock/demo mode in the web client.
- No `/coordinator`/subagents UI in this slice (fast-follow).
- No changes to `@dawn-ai/ag-ui` or the `/agui` endpoint (that's PR #322). If a real
  plumbing gap is found (see Risks), fix it minimally and note it.
- No custom chat transcript rendering beyond what `CopilotSidebar` provides in this
  slice (generative-UI tool cards can come later).

## Architecture

```
examples/chat/
  server/   (unchanged — `dawn dev` serves POST /agui/{routeId} via #322)
  web/      (REBUILT on CopilotKit v2)
    app/
      layout.tsx                 # imports @copilotkit/react-ui styles
      page.tsx                   # CopilotKitProvider + CopilotSidebar + WorkspacePanel
      api/copilotkit/route.ts    # CopilotRuntime + HttpAgent → DAWN/agui/<chat>
      components/
        PermissionInterrupt.tsx  # useInterrupt → Allow once / Allow always / Deny
        TodosPanel.tsx           # useCoAgent({name:"chat"}) → live todos checklist
    package.json                 # next, react, @copilotkit/{react-core,react-ui,runtime}, @ag-ui/client
    .env.example                 # DAWN_SERVER_URL (server holds OPENAI_API_KEY)
    README.md
```

Deleted: `app/page.tsx` (hand-rolled SSE), `app/api/chat/route.ts`,
`app/api/permission-resume/route.ts`.

### Runtime route — `app/api/copilotkit/route.ts`

Mirrors CopilotKit's AG-UI example verbatim in shape:

```ts
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime"
import { HttpAgent } from "@ag-ui/client"

const dawnUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
const runtime = new CopilotRuntime({
  agents: {
    chat: new HttpAgent({ url: `${dawnUrl}/agui/${encodeURIComponent("/chat#agent")}` }),
  },
})

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  })
  return handleRequest(req)
}
```

The `HttpAgent` URL targets the Dawn AG-UI endpoint; the route key is the
mode-qualified assistant id `/chat#agent`, URL-encoded (the dev server's dispatcher
`decodeURIComponent`s the `{routeId}` param, so it round-trips).

### Provider + UI — `app/page.tsx`

```tsx
"use client"
import { CopilotKitProvider, CopilotSidebar } from "@copilotkit/react-core/v2"
import "@copilotkit/react-ui/styles.css"
// + our PermissionInterrupt, TodosPanel

export default function Home() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" agent="chat">
      <PermissionInterrupt />
      <main>
        <TodosPanel />
        <CopilotSidebar defaultOpen labels={{ title: "Dawn chat" }} />
      </main>
    </CopilotKitProvider>
  )
}
```

### Thin Dawn wrappers

- **`PermissionInterrupt.tsx`** — `useInterrupt({ render: ({ event, resolve }) => … })`.
  Dawn emits `CUSTOM{ name: "on_interrupt", value: { interruptId, kind, detail } }`
  (kind ∈ command/path/tool/memory). Render a labelled approve/deny card and call
  `resolve({ interruptId, decision })` where decision ∈ `"once" | "always" | "deny"`
  — the exact shape `@dawn-ai/ag-ui`'s `mapRunInput` decodes from
  `forwardedProps.command.resume`.
- **`TodosPanel.tsx`** — `useCoAgent<{ todos?: Todo[] }>({ name: "chat" })`. Dawn's
  `plan_update` chunks become `STATE_SNAPSHOT{ todos }` via the translator; CopilotKit
  syncs that into the coagent state. Render `state.todos` as a live checklist.

## Data Flow

browser → CopilotKit runtime (`/api/copilotkit`) → `HttpAgent` POSTs `RunAgentInput`
to Dawn `/agui/chat` → live `/chat` agent (workspace tools, planning, HITL) → AG-UI
events stream back → CopilotKit renders the chat transcript, streams todos into
`TodosPanel`, and raises approve/deny in `PermissionInterrupt`. Approving posts a new
run whose `forwardedProps.command.resume` carries the decision → Dawn resumes.

## Error Handling

- **Dawn server down / DAWN_SERVER_URL wrong:** the CopilotKit runtime surfaces the
  upstream connection error in the chat UI; README documents starting the server first.
- **No API key on the server:** the run streams a `RUN_ERROR` ("Missing credentials")
  which CopilotKit renders — README makes the key requirement explicit (key on the
  *server*, not the web app).
- **Denied permission:** `resolve({ decision: "deny" })` returns control to the agent
  (Dawn's existing deny path).

## Running & Testing

- `pnpm dev` (root of `examples/chat`) runs server (:3001, needs `OPENAI_API_KEY`) +
  web (:3000, no key). `pnpm --filter @dawn-example/chat-web build` / `typecheck`.
- **Automated:** `turbo build` + `typecheck` cover the rebuilt web package (it's a
  workspace member). No new heavy harness test — the deterministic connection proof
  is PR #322's `/agui` endpoint e2e.
- **Manual live smoke (documented in README + verified before PR):** start both
  servers with a key, open :3000, send "list the files in the workspace" → observe a
  streamed reply; trigger a non-allowlisted `runBash` → observe the approve/deny card,
  approve → observe the command runs and the run resumes; observe the todos panel
  populate from a planning turn.

## Risks & Mitigations

- **The one real integration risk:** whether CopilotKit v2's `useInterrupt`
  `resolve(payload)` actually reaches Dawn's `/agui` as
  `forwardedProps.command.resume` through the runtime → `HttpAgent` → our
  `RunAgentInput`. Verified in the live smoke. If the path or payload shape differs,
  fix minimally on the web side (shape the `resolve` payload) or, if it's a genuine
  `mapRunInput` gap, patch `@dawn-ai/ag-ui` and note it (that lands on the #322 base).
- **CopilotKit v2 published-API drift:** pin `@copilotkit/*` to a known-good `1.62.x`
  and import v2 hooks from the `/v2` subpath; wrap CopilotKit usage in our own
  components so a future migration is contained.
- **Todos state key mismatch:** the coagent `name` ("chat") must match the runtime's
  registered agent name, and `state.todos` must match the translator's snapshot shape;
  verified in the live smoke.

## Follow-ups (not this slice)

- `/coordinator` + subagent activity UI (from `CUSTOM{ subagent.* }` events).
- Generative-UI tool cards (`useRenderToolCall`) for richer tool rendering.
- The middleware-parity decision for `/agui` (already filed against #322).
