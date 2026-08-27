# Chat — CopilotKit web client (AG-UI)

The canonical reference for **connecting a web client to Dawn over AG-UI**. This is a
[CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime/v2`) whose required catch-all runtime route
(`app/api/copilotkit/[...path]/route.ts`) registers an `HttpAgent` pointed at Dawn's
`POST /agui/{routeId}` endpoint (the URL-encoded assistant id, e.g.
`%2Fchat%23agent`; see `@dawn-ai/ag-ui`). It replaces the previous hand-rolled SSE
smoke client.

This app runs **live** against a real model — there is no aimock/demo mode here. The
deterministic, no-key checks cover both boundaries: a loopback integration drives the
real CopilotKit handler through `HttpAgent` and forwards a schema-valid AG-UI stream,
while the package-owned browser test loads this page and proves it discovers
`GET /api/copilotkit/info` without a legacy base-URL POST. Neither check calls a model.

Scope: basic chat with the `/chat` route. Dawn's AG-UI adapter emits standard
replacement `dawn.plan` and `dawn.subagent` activity snapshots when matching
runtime chunks occur, and this client registers `dawnActivityRenderers` from
`@dawn-ai/ag-ui/react` so planning is presented rather than silent — the
`/chat` route ships a `plan.md`, so the agent plans with `writeTodos`, and Dawn
presents that only as an activity. It still drives only `/chat`, so it remains a
transport-wiring example, not a coordinator UI.

## Architecture

```
browser
  -> /api/copilotkit/* (app/api/copilotkit/[...path]/route.ts, this app, no API key)
    -> HttpAgent -> POST /agui/%2Fchat%23agent  (Dawn dev server, holds OPENAI_API_KEY)
      -> live /chat agent
        -> AG-UI event stream back to the browser
```

- `app/api/copilotkit/[...path]/route.ts` — `CopilotRuntime` with
  `agents: { default: new HttpAgent(...) }`, served through
  `createCopilotRuntimeHandler` from `@copilotkit/runtime/v2` with
  `basePath: "/api/copilotkit"` and shared `GET`/`POST` exports. No LLM credentials
  live here; the Dawn server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`,
  `useSingleEndpoint={false}`) wrapping a `CopilotSidebar` chat transcript and the
  Dawn activity renderers.

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

`pnpm --filter @dawn-example/chat-web typecheck` / `build` verify that the
CopilotKit/AG-UI wiring compiles and the Next.js app builds. `pnpm --filter
@dawn-example/chat-web test:e2e` launches the real page and verifies its V2 discovery
transport in a dedicated CI lane. These deterministic checks do **not** exercise a live
model; there's no automated substitute for the smoke below because this client
intentionally has no demo/mock mode.

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
