# {{appName}}

A deep-research assistant built with [Dawn](https://github.com/cacheplane/dawnai),
shipped as an npm workspace with two packages:

- **`server/`** — the Dawn app: the research route, tools, a researcher
  subagent, memory, planning, offloading, HITL permissions, tests, and evals.
  [`server/README.md`](./server/README.md) is the full tour.
- **`web/`** — the Dawn Workbench: an [AG-UI](https://github.com/ag-ui-protocol/ag-ui)
  client built on CopilotKit, with a thread rail, streaming chat, plan and
  subagent activity cards, tool cards, permission prompts, and memory review.
  [`web/README.md`](./web/README.md) covers restyling it and its known limits.

Requires Node.js 24 or later and npm 11.

## Run it

Install once, from the app root — that wires up both packages:

```bash
npm install
cp server/.env.example server/.env
```

Live research needs a real `OPENAI_API_KEY` in `server/.env`. There is no
keyless demo mode; the bundled tests and evals run offline on fixtures instead.

Then start the two processes, one per terminal:

| Process | Command | URL |
|---|---|---|
| Agent server | `npm run dev:server` | <http://127.0.0.1:3002> |
| Web client | `npm run dev:web` | <http://localhost:3010> |

Start the server first. The web client proxies to it and shows a "can't reach
the Dawn server" screen until it answers.

The rest of the toolchain lives at the root too — `npm run verify`,
`npm run check`, `npm run typecheck`, `npm test`, `npm run eval`,
`npm run build`, and `npm start`. Each one delegates to `server/`, except
`typecheck`, `test`, and `build`, which run in every package that defines them.
