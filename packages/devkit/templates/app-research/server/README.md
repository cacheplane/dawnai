# {{appName}} — server

A deep-research assistant built with [Dawn](https://github.com/cacheplane/dawnai).
Ask a question; it plans sub-questions, researches a bundled local corpus,
and writes a cited report. Live research uses a real OpenAI model and API key;
the included tests and evals use deterministic fixtures and run offline.

Requires Node.js 24 or later and npm 11.

## Run it live

Everything below runs from the app root — the directory above this one, where
`npm install` links both workspace packages. The root scripts delegate here.

```bash
npm install
cp server/.env.example server/.env
# Add a real OPENAI_API_KEY to server/.env
npm run verify
npm run dev:server     # Dawn dev server on http://127.0.0.1:3002
```

Ask the research agent a question — it plans, dispatches a researcher subagent,
and streams back a cited report:

```bash
curl -N "http://127.0.0.1:3002/agui/%2Fresearch%23agent" \
  -H 'content-type: application/json' \
  -d '{"threadId":"t1","runId":"r1","state":{},"tools":[],"context":[],"forwardedProps":{},
       "messages":[{"id":"1","role":"user","content":"What are common agent architectures?"}]}'
```

That's the [AG-UI](https://github.com/ag-ui-protocol/ag-ui) endpoint (`/agui/<route>`).
Alongside text, root tools, and interrupts, it emits standard replacement
`dawn.plan` and `dawn.subagent` activity messages for valid planning and matched
delegated-work progress. Those activities are the whole presentation of the
`writeTodos` and `task` calls behind them: a call whose activity was emitted
produces no root tool events, while every other tool is unchanged.

The **web UI** over this endpoint is the sibling [`web/`](../web) package — the
Dawn Workbench: cited reports, generic tool cards, suggestion prompts, standard
permission handling, and memory-candidate review. Start it with
`npm run dev:web` from the app root. If you write your own client instead, do
not hand-build the plan and researcher cards — `@dawn-ai/ag-ui/react` ships
them, so a React client passes `dawnActivityRenderers` to CopilotKit's
`renderActivityMessages` and is done. That is what `web/` does, and the
[Research assistant web UI](https://dawnai.org/docs/recipes/research-web-ui)
recipe walks through building one.

Separately, `npx dawn inspect` opens the
[Dawn Inspector](https://dawnai.org/docs/inspector) — a browser UI over this
app's live memory store, already installed here as a devDependency.

## Check it offline

```bash
npm run typegen    # write server/.dawn/dawn.generated.d.ts
npm run check      # validate routes, tools, and configuration without writing files
npm run typecheck  # validate TypeScript
npm test           # harness tests (deterministic fixtures)
npm run eval       # quality evals (deterministic fixtures)
npm run memory:list
```

These commands provide offline confidence in the starter; the fixtures are
test assets, not a keyless product demo. To run evals against a real model, add
`--live` (for example, `npm run eval -- --live`).

## Build and start the artifact

```bash
npm run build
npm start
```

Run these in order: `build` writes the configured deployment artifacts, then
`start` loads `server/.env` when present and serves
`server/.dawn/build/server.mjs`. `start` does not build the app for you.

To dogfood the Docker sandbox, start Docker and run:

```bash
npm run test:sandbox:docker --workspace server
```

The normal test path uses the local `workspace/` so the bundled corpus works
immediately. The Docker sandbox path creates an isolated per-thread workspace;
the sandbox test seeds a corpus document there before running the same tools.

## The tour — where each capability lives

| Capability | File | What it shows |
|---|---|---|
| Agent route | `src/app/research/index.ts` | the research coordinator |
| Tools + typegen | `src/tools/` | shared `searchCorpus`, `readDoc`; `dawn typegen` writes their generated types |
| Subagents | `src/app/research/subagents/researcher/` | dispatched via `task({ subagent, input })` |
| Planning | `src/app/research/plan.md` | seeded checklist becomes the thread's todos |
| Offloading | `dawn.config.ts` + a large `readDoc` | big results spill to the workspace, stubbed in-context |
| Memory | `workspace/AGENTS.md`, `memory.md`, `memory.ts` | prompt memory plus typed `recall`/`remember` |
| Skills | `src/app/research/skills/` | `cite-sources`, `synthesize-findings` |
| HITL permissions | `dawn.config.ts` + `workspace/scripts/fetch-source.mjs` | the external fetch pauses for approval |
| Workspace | `workspace/` | corpus + report output behind a path-jail |
| Docker sandbox | `dawn.config.ts`, `test/sandbox-docker.test.ts` | opt-in isolated workspace via `@dawn-ai/sandbox` |
| Persistence | (default) | threads survive a restart (SQLite) |
| Tests | `test/research.test.ts` | `createAgentHarness` + `script()` |
| Evals | `src/app/research/evals/` | `defineEval` + scorers + a gate |

## Memory review

This scaffold uses candidate memory writes. When the agent calls `remember`,
the memory is saved for review instead of becoming active immediately.

```bash
npm run memory:list
npm run memory:approve -- <memory-id>
```

`npm run memory:approve` wraps `dawn memory approve`; use either form when
you want to promote a candidate into active recall.

The tests show both paths: seeding an active memory with `seedMemory`, and
writing a reviewable candidate through the real `remember` tool.

## Make it yours

This is a starter — extend the parts you want and delete the rest:

- **Swap the corpus:** replace `workspace/corpus/*.md` with your own documents.
- **Add tools:** drop a file in `src/tools/` for shared tools or
  `<route>/tools/` for route-local tools, then run `npm run typegen` followed by
  `npm run check`.
- **Wire a real fetch:** edit `workspace/scripts/fetch-source.mjs` and add the
  command to `permissions.allow.bash` in `dawn.config.ts`.
- **Dogfood sandboxing:** keep `DAWN_DEMO_DOCKER_SANDBOX=1` for isolated
  workspace execution, and seed any files the sandbox needs during the run.
- **Enable summarization:** uncomment the `summarization` block in
  `dawn.config.ts` once your threads get long.
- **Throw it away:** delete `src/app/research/` and start from a single
  `index.ts` — the toolchain (`typegen`/`check`/`build`/`test`/`eval`) still works.
