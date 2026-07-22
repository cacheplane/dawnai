# Chat — CopilotKit web client (AG-UI)

The canonical reference for **connecting a web client to Dawn over AG-UI**. This is a
[CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime`) whose runtime route (`app/api/copilotkit/route.ts`) registers an
`HttpAgent` pointed at Dawn's `POST /agui/{routeId}` endpoint (the URL-encoded
assistant id, e.g. `%2Fchat%23agent`; see `@dawn-ai/ag-ui`). It replaces the
previous hand-rolled SSE smoke client.

This app runs **live** against a real model — there is no aimock/demo mode here. The
deterministic, no-key proof that the AG-UI wire protocol works is the `/agui` endpoint's
test suite in `@dawn-ai/cli`.

Scope: basic chat with the `/chat` route. The AG-UI v1 adapter intentionally
ignores planning and subagent capability events.

## Architecture

```
browser
  -> CopilotKit runtime (app/api/copilotkit/route.ts, this app, no API key)
    -> HttpAgent -> POST /agui/%2Fchat%23agent  (Dawn dev server, holds OPENAI_API_KEY)
      -> live /chat agent
        -> AG-UI event stream back to the browser
```

- `app/api/copilotkit/route.ts` — `CopilotRuntime` with `agents: { default: new HttpAgent(...) }`,
  served via `copilotRuntimeNextJSAppRouterEndpoint`. No LLM credentials live here; the
  Dawn server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`) wrapping a
  `CopilotSidebar` chat transcript.

CopilotKit's sidebar falls back to the literal agent id `"default"`. This example
registers the Dawn `/chat#agent` route under that id.

## Running

Run these commands from the repository root. They intentionally enter the parent
`examples/chat` package before using its server/web scripts:

```bash
cd examples/chat
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

1. From `examples/chat`, run `cp server/.env.example server/.env` and set `OPENAI_API_KEY`.
2. `pnpm dev` (server :3001, web :3000).
3. Open http://localhost:3000. Send "list the files in the workspace" — expect a
   streamed assistant reply in the sidebar.
4. Confirm a second message in the same thread continues the conversation without
   replaying prior user messages to the Dawn route.

## Security caveat

Same as the server: `runBash` runs real shell commands on your machine with
`cwd: workspace/`. Do not point untrusted users at this example.
