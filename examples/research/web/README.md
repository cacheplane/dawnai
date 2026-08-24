# Dawn Workbench — the research example's web client

A [CopilotKit](https://docs.copilotkit.ai) v2 app (`@copilotkit/react-core/v2` +
`@copilotkit/runtime`) that talks to Dawn's `/research` agent over AG-UI. It is a
workbench rather than a chat widget: the app renders its own transcript and composer
instead of mounting `CopilotSidebar`, so the plan and researcher activity cards appear
inline in the conversation.

## Layout

- **Thread rail** (left, `app/components/ThreadRail.tsx`) — "New conversation" plus the
  list of threads, each titled from its first user message.
- **Transcript** (`app/components/Transcript.tsx`) — user and assistant messages,
  with plan / researcher activity cards, tool cards, permission approvals, and run
  errors inline in message order. Before the first message it shows an empty state with
  clickable suggestions.
- **Composer** (`app/components/Composer.tsx`) — send, and stop while a run is in
  flight. It is blocked while the agent is running or waiting on an approval; the header
  says which.

The wiring: `app/api/copilotkit/route.ts` registers an `HttpAgent` pointed at the Dawn
server's encoded `/agui/%2Fresearch%23agent` endpoint under CopilotKit's default agent
id, and `app/page.tsx` mounts `CopilotKit` plus a `CopilotChatConfigurationProvider`
carrying the active thread id. No model credentials live in this app — the Dawn server
holds them.

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

## What it does not do yet

- **Threads are local to the browser.** The rail keeps its own list in `localStorage`
  (`app/lib/thread-source.ts`) because the Dawn server cannot enumerate threads. The
  list is not shared across browsers, devices, or profiles, and clearing site data
  clears it.
- **Switching a thread does not restore its history.** The transcript is cleared on
  switch rather than showing the wrong conversation's messages, and nothing refills it:
  CopilotKit's replay path (`connectAgent`, which asks the runtime to replay a thread's
  events) is only ever called from inside `<CopilotChat>`, which this app does not
  mount. Verified live — switching away from a thread and back fires no request and
  leaves the transcript empty. The Dawn server may still hold that history; this client
  never asks for it. Hydration lands in the next slice.
- **Memory review is candidates only.** The rail's memory panel
  (`app/components/MemoryPanel.tsx`) lists what the agent proposed with `remember()`
  and lets you approve or delete each candidate, through the allowlisted proxy
  (`app/lib/proxy-allowlist.ts`). Its **Delete** button maps to the server's
  `/reject` route, which is a hard delete with no undo — hence the label. It shows at
  most three at a time and cannot browse, search, or edit stored memories — that is
  still the `dawn memory` CLI.
- **No browser or live-model test coverage here.** The example's own tests
  (`pnpm --filter @dawn-example/research-web test`) cover the thread source, the
  transcript mapping, the renderer registry, the thread rail, the composer, and the
  shell's thread-switch reset; `typecheck` and `build`
  prove the CopilotKit/AG-UI wiring compiles. The cards themselves are tested in
  `@dawn-ai/ag-ui`.

## Security caveat

Same as the server: tools run against the workspace with real network and filesystem
access as configured. Do not point untrusted users at this example.
