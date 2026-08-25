# {{appName}} — web

The Dawn Workbench: the browser client for the `server/` package's `/research`
agent. It is a [CopilotKit](https://docs.copilotkit.ai) v2 app
(`@copilotkit/react-core/v2` + `@copilotkit/runtime`) on Next.js and React that
talks to Dawn over [AG-UI](https://github.com/ag-ui-protocol/ag-ui).

It is a workbench rather than a chat widget: it renders its own transcript and
composer instead of mounting `CopilotSidebar`, so plan and researcher activity
cards, tool cards, and permission prompts appear inline in the conversation.

No model credentials live in this package. The Dawn server holds them, and this
app reaches it through a same-origin proxy.

Requires Node.js 24 or later and npm 11.

## Run it

Everything runs from the app root — the directory above this one, where
`npm install` links both workspace packages.

```bash
npm install
cp server/.env.example server/.env    # add a real OPENAI_API_KEY here
npm run dev:server                    # Dawn server on http://127.0.0.1:3002
npm run dev:web                       # this app on http://localhost:3010
```

Start the server first. Until it answers, this app shows a connect screen with
the commands that start it; the screen re-probes every five seconds and clears
itself the moment the server comes up, with no reload.

`web/.env.example` holds one variable, `DAWN_SERVER_URL` (default
`http://127.0.0.1:3002`). Copy it to `web/.env` if your server listens
elsewhere.

Offline checks, also from the app root:

```bash
npm run typecheck --workspace web
npm test --workspace web
npm run build --workspace web
```

## Where things live

| Part | File | What it does |
|---|---|---|
| Connect screen | `app/components/ConnectScreen.tsx` | replaces the shell while the server is unreachable |
| Thread rail | `app/components/ThreadRail.tsx` | new conversation, plus the thread list |
| Memory review | `app/components/MemoryPanel.tsx` | approve or delete the candidates `remember()` proposed |
| Transcript | `app/components/Transcript.tsx` | messages, activity cards, tool cards, approvals, errors |
| Composer | `app/components/Composer.tsx` | send, and stop while a run is in flight |
| Plan card | `app/components/PlanCard.tsx` | the packaged plan card, restyled |
| Subagent card | `app/components/SubagentCard.tsx` | the packaged subagent card, restyled |
| Renderer registry | `app/components/activity-renderers.tsx` | hands both cards to CopilotKit |
| CopilotKit runtime | `app/api/copilotkit/route.ts` | registers an `HttpAgent` on Dawn's AG-UI endpoint |
| Server proxy | `app/api/dawn/[...path]/route.ts` | forwards allowlisted reads to Dawn |
| Proxy allowlist | `app/lib/proxy-allowlist.ts` | the pure policy the proxy enforces |
| Thread history | `app/lib/thread-source.ts`, `app/lib/hydrate.ts` | the rail's list, and restoring a saved thread |
| Theme | `app/theme.css` | the whole palette, as CSS variables |

## Restyling it

`app/theme.css` is the one file to edit. The palette is defined there as CSS
variables and re-exported as Tailwind tokens through `@theme inline`, which is
why the app's utilities read `bg-wb-surface`, `border-wb-border`,
`text-wb-muted`, `rounded-wb`. Change a `--wb-*` value and the light palette,
the dark palette, the activity-card tokens, and every utility move together.
The same file holds the focus ring (`wb-focus`), the two roles the gradient is
allowed to play (`.wb-brand-mark`, `.wb-primary-action`), and the `.wb-prose`
rules for rendered markdown.

The palette follows the OS light/dark setting. To pin one, set
`data-wb-theme="light"` or `data-wb-theme="dark"` on `<html>`; `theme.css`
defines both branches.

The plan and researcher cards are **not forks**. They are the packaged
`@dawn-ai/ag-ui/react` components (`PlanActivityCard`, `SubagentActivityCard`),
customized through that package's `classNames` ladder. To change how they look,
edit `app/components/PlanCard.tsx` and `app/components/SubagentCard.tsx` —
validation, bounds, and layout stay in the package, where they are tested. One
constraint is worth knowing before you add a class: a `classNames` entry can
only set a property the package stylesheet leaves unset on that element,
because the package's CSS is unlayered and Tailwind's utilities are not.
`app/components/activity-renderers.tsx` states the rule and what it puts out of
reach.

The [AG-UI and Web Clients](https://dawnai.org/docs/ag-ui) guide covers the
protocol side, and the
[Research Assistant Web UI](https://dawnai.org/docs/recipes/research-web-ui)
recipe walks through building a client like this one.

## The proxy is not open

Dawn's dev server sets no CORS headers, so the browser reaches it through the
same-origin catch-all at `app/api/dawn/[...path]/route.ts`. That route forwards
five requests and nothing else:

| Method | Path |
| --- | --- |
| GET | `/memory/candidates` |
| POST | `/memory/candidates/:id/approve` |
| POST | `/memory/candidates/:id/reject` |
| GET | `/threads/:id/state` |
| GET | `/threads/:id/pending_interrupts` |

Anything else — an unlisted path, or a listed path with the wrong method — is
rejected with **403** and never forwarded. Running, resuming, and cancelling a
thread are deliberately absent: those go through CopilotKit's own runtime route.

The allowlist bounds **which** routes are reachable, not **who** may reach them.
The proxy forwards with no authentication, and this scaffold installs no
`threadAccess` policy on the server, so anything that can reach this app can
read a thread's saved transcript by guessing its id and can permanently delete
memory candidates. Before you expose this beyond your own machine, add a
[`threadAccess` policy](https://dawnai.org/docs/thread-access) so a request for
someone else's thread is refused where the data lives. The server package
scaffolds one inert, at `server/src/thread-access.ts.example`: drop the
`.example` suffix on it and on the `server/src/auth.ts.example` it imports, then
fill in how you authenticate a caller.

## Known limits

- **Threads are local to the browser.** Dawn's server cannot enumerate threads,
  so the rail keeps its own list in `localStorage` (`app/lib/thread-source.ts`).
  The list is not shared across browsers, devices, or profiles, and clearing
  site data clears it — the server still holds the conversations, but this
  client no longer knows their ids. Two tabs open at once can also clobber each
  other's list, because the store does read-modify-write with no merge.
- **Restores are lossy.** Switching back to a thread replays only what the
  checkpoint stores: messages, tool calls and results, and the plan. Subagent
  activity cards from earlier runs are not saved and do not come back, and the
  app says so above the restored messages. A brand-new thread has no checkpoint
  yet; that 404 is treated as "nothing to restore", not an error.
- **Memory review is candidates only.** The panel lists what the agent proposed
  with `remember()` and offers Approve and Delete on each — Delete is a hard
  delete on the server with no undo. It shows at most three candidates at a time
  and counts the rest, so it cannot push the thread list off the rail. It cannot
  browse, search, or edit stored memories; that is `npm run memory:list` and the
  rest of the `dawn memory` CLI, or `npx dawn inspect --cwd server` for a browser UI.
- **A connection loss costs your draft.** When a probe finds the server down,
  the connect screen replaces the whole shell, which unmounts the composer.

## Tests

`npm test --workspace web` runs 15 test files with Vitest: the proxy route and
its allowlist, the thread source, the checkpoint hydrator, the transcript
mapping, the renderer registry, the thread rail, the composer, the connect
screen, the memory panel, the tool-call card, all three permission surfaces, and
the shell's thread-switch and server-probe behaviour. `typecheck` and `build`
prove the CopilotKit and AG-UI wiring compiles. The activity cards themselves
are tested in `@dawn-ai/ag-ui`.

There are no browser or live-model tests here. A full research run — streaming,
activity cards, a permission gate live and across a reload, memory candidates
appearing — needs a real `OPENAI_API_KEY` and is covered by unit tests only.
