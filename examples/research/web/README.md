# Research — CopilotKit web client (AG-UI)

A [CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime`) whose runtime route (`app/api/copilotkit/route.ts`) registers an
`HttpAgent` pointed at Dawn's encoded `/research#agent` AG-UI endpoint (see
`@dawn-ai/ag-ui`). It mirrors `examples/chat/web` (the canonical AG-UI wiring
reference) and adds research suggestions, plan and researcher activity cards,
generic tool cards, standard permission handling, and memory-candidate approval.

This app runs **live** against a real model — there is no aimock/demo mode here. The
focused web tests render the activity components to static markup, proving their
presentation without a browser or model. The packaged generated-research activation
drives the deterministic server and AG-UI client path, proving activity snapshots reach
the client before the final report. Neither test is a browser test or a live-model run.

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
  `CopilotSidebar` (streaming chat transcript + cited report), with the stable
  module-level activity renderer registry, 100 ms render throttle, suggestion prompts,
  generic root-tool cards, standard permission handling, and the memory-review panel.
- `app/components/ActivitySchemas.ts` — strict runtime schemas for Dawn's public plan
  and subagent activity content. Incompatible payloads fail closed.
- `app/components/ActivityChecklist.tsx` and `PlanActivityCard.tsx` — the checklist
  shared by root and child cards, plus the root plan card. Each checklist view displays
  at most eight items plus `+N more`, while its snapshot retains the complete valid
  todo list. The root card derives its completed count from that full snapshot.
- `app/components/SubagentActivityCard.tsx` — researcher name, depth, lifecycle status,
  optional child checklist, at most five recent child-tool name/status summaries, total
  tool count, and an optional error capped at 400 characters.
- `app/components/ActivityRenderers.tsx` — the module-level
  `activityMessageRenderers` registry, keyed by the public
  `DAWN_PLAN_ACTIVITY_TYPE` and `DAWN_SUBAGENT_ACTIVITY_TYPE` constants.
- `app/components/MemoryCandidates.tsx` — after a research run proposes durable memory
  via `remember()`, the candidate (`status:"candidate"`) shows up in this panel with
  **Approve**/**Reject** buttons, backed by the dev server's
  `GET /memory/candidates` and `POST /memory/candidates/:id/approve|reject` endpoints
  (proxied same-origin through `app/api/memory/[...path]/route.ts`). This replaces the
  CLI `dawn memory approve` flow for the demo.

Components/hooks that omit `agentId` resolve CopilotKit's default agent id
(`"default"`), which the runtime route registers as the Dawn `/research` agent — same
pattern as `examples/chat/web`, no per-component wiring needed.

Root plan snapshots replace the stable `dawn:plan:${runId}` message and carry
the complete todo list. Each researcher snapshot replaces
`dawn:subagent:${call_id}` and carries only its name, depth,
`running`/`completed`/`failed` status, optional todos, bounded tool summaries,
total tool count, and optional bounded error. Todo status is
`pending`/`in_progress`/`completed`; tool-summary status is
`running`/`completed`/`incomplete`. `subagent.message` is consumed without an
activity emission. The `dawn.plan` and `dawn.subagent` activity content supplied
to the cards excludes child reasoning or prose, prompts, tool inputs, tool
outputs, final child answers, route ids, and raw runtime ids.

These activities are the whole presentation of `writeTodos` and `task`. Dawn's
AG-UI adapter emits no tool call/result events for a call whose activity was
emitted, so the wildcard tool card here receives the ordinary tools (`recall`,
`searchCorpus`, `readDoc`, `writeFile`, and `runBash` once approved) but never
`writeTodos` or `task`. The suppression is
the adapter's, not CopilotKit's or these renderers'. It fails open: if an
activity cannot be produced, the ordinary tool events survive and the generic
card renders them, which is why its `task` argument summary is kept.

Choose the safe **Research a topic** suggestion to see plan and researcher
progress before the cited answer. Activity cards are informational: generic
root-tool rendering remains registered for the other tools, while standard
interrupt UI exclusively owns permission actions. Suggestions, memory review,
and the server-held `OPENAI_API_KEY` flow are unchanged.

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

`pnpm --filter @dawn-example/research-web test` renders the cards on the server and
checks their schemas and bounds. `typecheck` / `build` verify the CopilotKit/AG-UI
wiring compiles and the Next.js app builds. The repository's packaged research
activation proves the deterministic wire path. These checks do **not** drive a browser
or exercise a live model; this client intentionally has no demo/mock mode.

## Live smoke checklist (run manually, with a real `OPENAI_API_KEY`)

1. From the repository root, run `pnpm install` and `pnpm build`.
2. In `examples/research`, copy `server/.env.example` to `server/.env` and set
   `OPENAI_API_KEY`.
3. Run `pnpm dev` there (server :3002, web :3010).
4. Open http://localhost:3010. Send a research question — expect a streamed, cited
   report in the sidebar, with plan and researcher cards updating before the answer.
5. If the run calls `remember()`, expect the **Memory candidates** panel to populate
   once the run finishes. Click **Approve** on one — expect it to disappear from the
   panel (now `status:"active"` in `.dawn/memory.sqlite`); **Reject** deletes it.

## Security caveat

Same as the server: tools run against the workspace with real network/filesystem
access as configured. Do not point untrusted users at this example.
