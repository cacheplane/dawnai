# Research — CopilotKit web client (AG-UI)

A [CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime`) whose runtime route (`app/api/copilotkit/route.ts`) registers an
`HttpAgent` pointed at Dawn's `POST /agui/research` endpoint (see `@dawn-ai/ag-ui`). It
mirrors `examples/chat/web` (the canonical AG-UI wiring reference) and adds
research-specific panels: live subagent activity and memory-candidate approval.

This app runs **live** against a real model — there is no aimock/demo mode here. The
deterministic, no-key proof that the research route and its AG-UI wire protocol work is
the server's own offline test/eval suite (`examples/research/server`).

## Architecture

```
browser
  → CopilotKit runtime (app/api/copilotkit/route.ts, this app, no API key)
    → HttpAgent → POST /agui/research          (Dawn dev server, holds OPENAI_API_KEY)
      → live /research agent (planning, subagent dispatch, HITL permissions)
        → AG-UI event stream back to the browser
```

- `app/api/copilotkit/route.ts` — `CopilotRuntime` with `agents: { default: new HttpAgent(...) }`,
  served via `copilotRuntimeNextJSAppRouterEndpoint`. No LLM credentials live here; the
  Dawn server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`) wrapping a
  `CopilotSidebar` (chat transcript + cited report), plus a left column of
  Dawn-specific panels.
- `app/components/PermissionInterrupt.tsx` — `useInterrupt` renders an approve/deny card
  when Dawn's HITL permission gate pauses a run (`CUSTOM{name:"on_interrupt"}`) — e.g. the
  research agent's external fetch tool.
- `app/components/PlanPanel.tsx` — `useAgent` (v2's coagent-state hook) renders Dawn's
  live plan/todos list as they stream in.
- `app/components/SubagentActivity.tsx` — subscribes to the agent's raw event stream via
  `agent.subscribe({ onCustomEvent })` and lists `dawn.subagent.*` custom events (start,
  tool_call, tool_result, message, end) as the researcher subagent runs. This is the one
  panel with no chat/web analog.
- `app/components/MemoryCandidates.tsx` — after a research run proposes durable memory
  via `remember()`, the candidate (`status:"candidate"`) shows up in this panel with
  **Approve**/**Reject** buttons, backed by the dev server's
  `GET /memory/candidates` and `POST /memory/candidates/:id/approve|reject` endpoints
  (proxied same-origin through `app/api/memory/[...path]/route.ts`). This replaces the
  CLI `dawn memory approve` flow for the demo.

Components/hooks that omit `agentId` resolve CopilotKit's default agent id
(`"default"`), which the runtime route registers as the Dawn `/research` agent — same
pattern as `examples/chat/web`, no per-component wiring needed.

## Running

```bash
cp server/.env.example server/.env   # add OPENAI_API_KEY — the server needs it, not this app
pnpm install
pnpm dev                             # server on :3001, web on :3010
# open http://localhost:3010
```

`pnpm --filter @dawn-example/research-web typecheck` / `build` cover this package in CI —
that verifies the CopilotKit/AG-UI wiring compiles and the Next.js app builds. It does
**not** exercise a live model; there's no automated substitute for the smoke below
because this client intentionally has no demo/mock mode.

## Live smoke checklist (run manually, with a real `OPENAI_API_KEY`)

1. `cp server/.env.example server/.env` and set `OPENAI_API_KEY`.
2. `pnpm dev` (server :3001, web :3010).
3. Open http://localhost:3010. Send a research question — expect a streamed, cited
   report in the sidebar.
4. Expect the **PlanPanel** to populate and check items off as the agent plans and
   works through the research task.
5. Expect the **SubagentActivity** panel to populate as the researcher subagent is
   dispatched — start/tool_call/tool_result/message/end entries should appear in order.
6. When the agent's external-fetch tool is invoked on a non-allowlisted target, expect
   the **PermissionInterrupt** card to appear. Click **Allow once** — expect the run to
   resume and the fetch to execute. This confirms `useInterrupt` carries our
   `{decision, interruptId}` payload through `forwardedProps.command.resume` into
   `@dawn-ai/ag-ui`'s `mapRunInput`, same as the chat client.
7. If the run calls `remember()`, expect the **Memory candidates** panel to populate
   once the run finishes. Click **Approve** on one — expect it to disappear from the
   panel (now `status:"active"` in `.dawn/memory.sqlite`); **Reject** deletes it.

## Security caveat

Same as the server: tools run against the workspace with real network/filesystem
access as configured. Do not point untrusted users at this example.
