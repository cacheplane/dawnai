# Chat — CopilotKit web client (AG-UI)

The canonical reference for **connecting a web client to Dawn over AG-UI**. This is a
[CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime`) whose runtime route (`app/api/copilotkit/route.ts`) registers an
`HttpAgent` pointed at Dawn's `POST /agui/{routeId}` endpoint (the URL-encoded
assistant id, e.g. `%2Fchat%23agent`; see `@dawn-ai/ag-ui`). It replaces the
previous hand-rolled SSE smoke client.

This app runs **live** against a real model — there is no aimock/demo mode here. The
deterministic, no-key proof that the AG-UI wire protocol works is the `/agui` endpoint's
own e2e test suite in `@dawn-ai/ag-ui`.

Scope: the `/chat` route only. `/coordinator` (subagents) is a fast-follow, not covered
by this client yet.

## Architecture

```
browser
  -> CopilotKit runtime (app/api/copilotkit/route.ts, this app, no API key)
    -> HttpAgent -> POST /agui/%2Fchat%23agent  (Dawn dev server, holds OPENAI_API_KEY)
      -> live /chat agent (workspace tools, planning, HITL permissions)
        -> AG-UI event stream back to the browser
```

- `app/api/copilotkit/route.ts` — `CopilotRuntime` with `agents: { default: new HttpAgent(...) }`,
  served via `copilotRuntimeNextJSAppRouterEndpoint`. No LLM credentials live here; the
  Dawn server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`) wrapping a
  `CopilotSidebar` (chat transcript), plus two thin Dawn-specific wrapper components.
- `app/components/PermissionInterrupt.tsx` — `useInterrupt` renders an approve/deny card
  when Dawn's HITL permission gate pauses a run (`CUSTOM{name:"on_interrupt"}`).
- `app/components/TodosPanel.tsx` — `useAgent` (v2's coagent-state hook) renders Dawn's
  live plan/todos list as they stream in.

CopilotKit's sidebar and hooks fall back to the literal agent id `"default"` when
no `agentId` is provided. This example registers the Dawn `/chat#agent` route
under `default`, so `CopilotSidebar`, `useAgent`, and `useInterrupt` all bind to
the same agent without per-component wiring.

## Running

```bash
cp server/.env.example server/.env   # add OPENAI_API_KEY — the server needs it, not this app
pnpm install
pnpm dev                             # server on :3001, web on :3000
# open http://localhost:3000
```

`pnpm --filter @dawn-example/chat-web typecheck` / `build` cover this package in CI —
that verifies the CopilotKit/AG-UI wiring compiles and the Next.js app builds. It does
**not** exercise a live model; there's no automated substitute for the smoke below
because this client intentionally has no demo/mock mode.

## Live smoke checklist (run manually, with a real `OPENAI_API_KEY`)

1. `cp server/.env.example server/.env` and set `OPENAI_API_KEY`.
2. `pnpm dev` (server :3001, web :3000).
3. Open http://localhost:3000. Send "list the files in the workspace" — expect a
   streamed assistant reply in the sidebar.
4. Send a prompt that triggers a non-allowlisted `runBash` (e.g. "run `npm install
   left-pad`") — expect the **PermissionInterrupt** card to appear. Click **Allow once**
   — expect the run to resume and the command to execute. This is the one path that
   isn't proven by typecheck/build: it confirms `useInterrupt` really does carry our
   `{decision, interruptId}` payload through `forwardedProps.command.resume` into
   `@dawn-ai/ag-ui`'s `mapRunInput`. If the card never appears, the translator's
   `CUSTOM{on_interrupt}` event isn't reaching the hook — check that the runtime route's
   `agents` map registers `default` and the page components are not pointing at a
   different `agentId`.
5. Send a multi-step prompt that makes the agent plan — expect the **TodosPanel** to
   populate and check items off as the plan progresses.

## Security caveat

Same as the server: `runBash` runs real shell commands on your machine with
`cwd: workspace/`. Do not point untrusted users at this example.
