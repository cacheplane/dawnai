# Research — CopilotKit web client (AG-UI)

A [CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime`) whose runtime route (`app/api/copilotkit/route.ts`) registers an
`HttpAgent` pointed at Dawn's encoded `/research#agent` AG-UI endpoint (see
`@dawn-ai/ag-ui`). It mirrors `examples/chat/web` (the canonical AG-UI wiring
reference) and adds research suggestions, generic tool cards, standard permission
handling, and memory-candidate approval.

This app runs **live** against a real model — there is no aimock/demo mode here. The
deterministic, no-key proof that the research route and its AG-UI wire protocol work is
the server's own offline test/eval suite (`examples/research/server`).

## Architecture

```
browser
  → CopilotKit runtime (app/api/copilotkit/route.ts, this app, no API key)
    → HttpAgent → POST /agui/%2Fresearch%23agent  (Dawn dev server, holds OPENAI_API_KEY)
      → live /research agent
        → AG-UI event stream back to the browser
```

- `app/api/copilotkit/route.ts` — `CopilotRuntime` with `agents: { default: new HttpAgent(...) }`,
  served via `copilotRuntimeNextJSAppRouterEndpoint`. No LLM credentials live here; the
  Dawn server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`) wrapping a
  `CopilotSidebar` (streaming chat transcript + cited report), plus suggestion
  prompts, generic tool cards, standard permission handling, and the memory-review
  panel.
- `app/components/MemoryCandidates.tsx` — after a research run proposes durable memory
  via `remember()`, the candidate (`status:"candidate"`) shows up in this panel with
  **Approve**/**Reject** buttons, backed by the dev server's
  `GET /memory/candidates` and `POST /memory/candidates/:id/approve|reject` endpoints
  (proxied same-origin through `app/api/memory/[...path]/route.ts`). This replaces the
  CLI `dawn memory approve` flow for the demo.

Components/hooks that omit `agentId` resolve CopilotKit's default agent id
(`"default"`), which the runtime route registers as the Dawn `/research` agent — same
pattern as `examples/chat/web`, no per-component wiring needed.

The AG-UI v1 adapter intentionally ignores planning and subagent capability
events. Interrupts use the standard AG-UI run outcome and top-level resume
array; this example does not add a client-specific compatibility component for
them.

## Running

Prepare the workspace from the repository root, then start both apps from
`examples/research`:

```bash
pnpm install
pnpm build                           # build Dawn packages used through dist
cd examples/research
cp server/.env.example server/.env   # add OPENAI_API_KEY — the server needs it, not this app
pnpm dev                             # server on :3002, web on :3010
# open http://localhost:3010
```

`pnpm --filter @dawn-example/research-web typecheck` / `build` cover this package in CI —
that verifies the CopilotKit/AG-UI wiring compiles and the Next.js app builds. It does
**not** exercise a live model; there's no automated substitute for the smoke below
because this client intentionally has no demo/mock mode.

## Live smoke checklist (run manually, with a real `OPENAI_API_KEY`)

1. From the repository root, run `pnpm install` and `pnpm build`.
2. In `examples/research`, copy `server/.env.example` to `server/.env` and set
   `OPENAI_API_KEY`.
3. Run `pnpm dev` there (server :3002, web :3010).
4. Open http://localhost:3010. Send a research question — expect a streamed, cited
   report in the sidebar.
5. If the run calls `remember()`, expect the **Memory candidates** panel to populate
   once the run finishes. Click **Approve** on one — expect it to disappear from the
   panel (now `status:"active"` in `.dawn/memory.sqlite`); **Reject** deletes it.

## Security caveat

Same as the server: tools run against the workspace with real network/filesystem
access as configured. Do not point untrusted users at this example.
