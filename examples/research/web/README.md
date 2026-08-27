# Dawn Workbench — the research example's web client

A [CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime/v2`) that talks to Dawn's `/research` agent over AG-UI. Its
required catch-all route (`app/api/copilotkit/[...path]/route.ts`) registers an
`HttpAgent` pointed at Dawn's encoded `/research#agent` endpoint. It is a
workbench rather than a chat widget: the app renders its own transcript and composer
instead of mounting `CopilotSidebar`, so the plan and researcher activity cards appear
inline in the conversation.

The live app uses a real model; there is no aimock/demo mode. Its browser test is
model-free and proves the page discovers `GET /api/copilotkit/info` instead of sending
a legacy base-URL POST.

## Layout

- **Connect screen** (`app/components/ConnectScreen.tsx`) — replaces the whole shell when
  the Dawn server is not answering, with the two commands that start it. It re-probes
  every 5 seconds through `GET /api/dawn/memory/candidates` (an allowlisted read, so it
  measures Dawn's own liveness rather than this Next process's), and clears itself the
  moment the server comes up — no reload. "Try again" probes immediately.
- **Thread rail** (left, `app/components/ThreadRail.tsx`) — "New conversation" plus the
  list of threads, each titled from its first user message.
- **Memory panel** (in the rail, `app/components/MemoryPanel.tsx`) — the candidates the
  agent proposed with `remember()`, with Approve and Delete on each.
- **Transcript** (`app/components/Transcript.tsx`) — user and assistant messages,
  with plan / researcher activity cards, tool cards, permission approvals, and run
  errors inline in message order. Before the first message it shows an empty state with
  clickable suggestions.
- **Composer** (`app/components/Composer.tsx`) — send, and stop while a run is in
  flight. It is blocked while the agent is running or waiting on an approval; the header
  says which.

```
browser
  → /api/copilotkit/* (app/api/copilotkit/[...path]/route.ts, this app, no API key)
    → HttpAgent → POST /agui/%2Fresearch%23agent  (Dawn dev server, holds OPENAI_API_KEY)
      → live /research agent
        → AG-UI event stream back to the browser
```

- `app/api/copilotkit/[...path]/route.ts` — `CopilotRuntime` with
  `agents: { default: new HttpAgent(...) }`, served through
  `createCopilotRuntimeHandler` from `@copilotkit/runtime/v2` with
  `basePath: "/api/copilotkit"` and shared `GET`/`POST` exports. No LLM credentials
  live here; the Dawn server holds `OPENAI_API_KEY`.
- `app/page.tsx` — `CopilotKit` (`runtimeUrl="/api/copilotkit"`,
  `useSingleEndpoint={false}`) plus a `CopilotChatConfigurationProvider` carrying the
  active thread id. The workbench renders its own transcript and composer, with
  `renderActivityMessages={workbenchActivityRenderers}` and a 100 ms render throttle.

Components/hooks that omit `agentId` resolve CopilotKit's default agent id
(`"default"`), which the runtime route registers as the Dawn `/research` agent — same
pattern as `examples/chat/web`, no per-component wiring needed.

## Thread history

Switching threads restores that conversation. `app/lib/thread-source.ts` reads
`GET /threads/:id/state` through the proxy and `app/lib/hydrate.ts` turns the
checkpoint's LangChain envelopes into the same message shapes the live stream produces,
so a restored thread and a live one render through one path. The checkpointed plan is
put back in front of the messages as a plan card.

What a restore does **not** bring back is stated in the app itself, above the restored
messages:

> Restored from this conversation's saved history. Subagent cards from earlier runs
> aren't saved — new ones appear as they run.

A thread with no checkpoint yet (a brand-new one) 404s, and that is treated as "nothing
to restore", not an error — no error row appears.

## Permission gates

A run parked on a permission gate survives a reload.
`app/components/HydratedInterrupts.tsx` asks the server for
`GET /threads/:id/pending_interrupts` and re-renders the prompt, because CopilotKit's own
`useInterrupt` state is fed only by live run events and is empty after a reload. It
reports the count upward so the composer stays blocked — sending into a parked thread
without resuming is the failure this prevents. It deliberately does not write those
interrupts onto `agent.pendingInterrupts`; the server's ids for an interrupt can be
aliases CopilotKit's resume path never minted.

## The proxy

The Dawn dev server sets no CORS headers, so the browser reaches it through the
same-origin catch-all at `app/api/dawn/[...path]/route.ts`. That proxy is **not** open.
`app/lib/proxy-allowlist.ts` is a pure function listing every route the browser may
reach — five of them:

| Method | Path |
| --- | --- |
| GET | `/memory/candidates` |
| POST | `/memory/candidates/:id/approve` |
| POST | `/memory/candidates/:id/reject` |
| GET | `/threads/:id/state` |
| GET | `/threads/:id/pending_interrupts` |

Anything else — a path that is not listed, or a listed path with the wrong method — is
rejected with **403** and never forwarded. Running, resuming, and cancelling a thread are
deliberately absent: those go through CopilotKit's own runtime route. Verified live:
a not-allowlisted POST and a right-path/wrong-method request both returned 403, while
the allowlisted reads returned 200.

## Memory review

The panel is **candidates only**. It lists what the agent proposed with `remember()` and
offers two decisions per candidate: **Approve** (`/approve`, which reports back when the
new record supersedes an older belief) and **Delete** (`/reject`, a hard delete on the
server with no undo — hence the label, not "Dismiss"). It shows at most three at a time
and counts the rest, so it cannot push the thread list off the rail. With no candidates it
renders nothing at all — except the one line reporting the outcome of the decision you
just made, or a load failure. It cannot browse, search, or edit stored
memories — that is still `dawn memory list` and the rest of the `dawn memory` CLI.

## Running

This demo needs a real model API key. There is no keyless or mock demo mode.

```bash
pnpm install
pnpm build                           # build the Dawn packages this app uses through dist
cd examples/research
cp server/.env.example server/.env   # set OPENAI_API_KEY here — the server needs it, not this app
pnpm dev                             # server on :3002, web on :3010
# open http://localhost:3010
```

`web/.env.example` holds only `DAWN_SERVER_URL` (default `http://127.0.0.1:3002`); copy
it to `web/.env` if your server listens elsewhere.

`pnpm --filter @dawn-ai/ag-ui test` renders the cards on the server and checks their
schemas and bounds. Here, `typecheck` / `build` verify the CopilotKit/AG-UI wiring
compiles and the Next.js app builds. The repository's packaged research activation
proves the deterministic wire path. `pnpm --filter @dawn-example/research-web
test:e2e` drives the real page in a browser to verify V2 transport selection. None of
these checks exercises a live model; this client intentionally has no demo/mock mode.

## Restyling it

`app/theme.css` is the one file to edit. The whole palette is defined there as CSS
variables and re-exported as Tailwind tokens via `@theme inline`, which is why the app's
utilities read `bg-wb-surface`, `border-wb-border`, `text-wb-muted`, `rounded-wb`. Change
a `--wb-*` value and the light and dark palettes, the activity-card tokens, and every
utility move together. The same file holds the single focus ring (`wb-focus`), the two
roles the dawn gradient is allowed to play (`.wb-brand-mark`, `.wb-primary-action`), and
the `.wb-prose` rules for rendered markdown.

The palette follows the OS light/dark setting. To pin one regardless, set
`data-wb-theme="light"` or `data-wb-theme="dark"` on `<html>` — `theme.css` defines both
branches.

The plan and researcher cards are **not forks**. They are the packaged
`@dawn-ai/ag-ui/react` components (`PlanActivityCard`, `SubagentActivityCard`),
customized through that package's `classNames` ladder. To change how they look, edit
`app/components/PlanCard.tsx` (and `app/components/SubagentCard.tsx`) — validation,
bounds, and layout stay in the package where they are tested. One constraint is worth
knowing before you add a class: a `classNames` entry can only set a property the package
stylesheet leaves unset on that element, because the package's CSS is unlayered and
Tailwind's utilities are not. `app/components/activity-renderers.tsx` states the rule and
what it puts out of reach.

## Test coverage

`pnpm --filter @dawn-example/research-web test` runs 15 test files: the proxy route and
its allowlist, the thread source, the checkpoint hydrator, the transcript mapping, the
renderer registry, the thread rail, the composer, the connect screen, the memory panel,
the tool-call card, all three permission surfaces (`PermissionPrompt`,
`PermissionInterrupt`, `HydratedInterrupts`), and the shell's thread-switch and
server-probe behaviour. `typecheck` and `build` prove the CopilotKit/AG-UI wiring
compiles. The activity cards themselves are tested in `@dawn-ai/ag-ui`.

The model-free `test:e2e` browser test proves the V2 transport begins with
`GET /api/copilotkit/info` rather than the legacy single-endpoint `POST`. The connect
screen, its auto-recovery, the empty state, thread hydration including the new-thread
404, and every proxy allow/reject case were also verified by hand in a real browser
against a real server. A full research run — streaming, activity cards, the permission
gate live and across a reload, memory candidates appearing and superseding — needs a
real `OPENAI_API_KEY` and has not been exercised in this repo; those paths are covered
by unit tests only.

## What it does not do yet

- **Threads are local to the browser.** The rail keeps its own list in `localStorage`
  (`app/lib/thread-source.ts`) because the Dawn server cannot enumerate threads. The
  list is not shared across browsers, devices, or profiles, and clearing site data
  clears it — the server still holds the conversations, but this client would no longer
  know their ids.
- **Restores are lossy.** Only what the checkpoint stores comes back: messages, tool
  calls and results, and the plan. Subagent activity cards from earlier runs are not
  saved and do not return.
- **Memory review is candidates only** — see above. No browsing, searching, or editing.
- **A connection loss costs you your draft.** When a probe finds the Dawn server down,
  the connect screen replaces the whole shell — which unmounts the composer, so anything
  typed but not sent is gone when the server comes back.

## Security caveat

Same as the server: tools run against the workspace with real network and filesystem
access as configured. Do not point untrusted users at this example.

The proxy adds a second exposure, and the allowlist does not close it. `/api/dawn/[...path]`
is same-origin and forwards to Dawn with **no authentication of any kind**, and this
example installs no `threadAccess` policy — so anything that can reach this Next app can
read any thread's full checkpoint transcript by guessing its id, and can permanently
delete memory candidates through `/reject`. The allowlist bounds WHICH routes are
reachable, not WHO may reach them: it is a blast-radius limit, not an access control.
The fix belongs on the Dawn side — a `threadAccess` policy on the server, so a request
for someone else's thread is refused where the data lives rather than in front of it.
Until that is in place, run this only on a trusted machine you are the sole user of.
