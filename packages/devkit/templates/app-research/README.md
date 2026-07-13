# {{appName}}

A deep-research assistant built with [Dawn](https://github.com/cacheplane/dawn).
Ask a question; it plans sub-questions, researches a bundled local corpus,
and writes a cited report. It runs offline and deterministically out of the
box, and against a real model when you opt in.

## Run it

```bash
npm install
npm run check     # generate route + tool types
npm test          # harness tests, offline (replay fixtures)
npm run eval      # quality evals, offline (replay fixtures)
npm run memory:list
```

## Run it live

Set a key and start the dev server:

```bash
export OPENAI_API_KEY=sk-...
npm run dev            # Dawn dev server on http://127.0.0.1:3000
```

Ask the research agent a question — it plans, dispatches a researcher subagent,
and streams back a cited report:

```bash
curl -N "http://127.0.0.1:3000/agui/%2Fresearch%23agent" \
  -H 'content-type: application/json' \
  -d '{"threadId":"t1","runId":"r1","state":{},"tools":[],"context":[],"forwardedProps":{},
       "messages":[{"id":"1","role":"user","content":"What are common agent architectures?"}]}'
```

That's the [AG-UI](https://github.com/cacheplane/dawn) endpoint (`/agui/<route>`).
For a full **web UI** — streaming chat, a live plan, subagent activity,
human-in-the-loop approvals, and memory-candidate review — follow the
*Research assistant web UI* recipe in the Dawn docs; it wires a CopilotKit client
to this app's `/agui` endpoint.

For evals against a real model, add `--live` (e.g. `npm run eval -- --live`). The
offline path uses recorded fixtures for the agent run and the generated
`llmJudge` scorer, so tests and evals are deterministic and need no API key.

To dogfood the Docker sandbox, start Docker and run:

```bash
npm run test:sandbox:docker
```

The normal test path uses the local `workspace/` so the bundled corpus works
immediately. The Docker sandbox path creates an isolated per-thread workspace;
the sandbox test seeds a corpus document there before running the same tools.

## The tour — where each capability lives

| Capability | File | What it shows |
|---|---|---|
| Agent route | `src/app/research/index.ts` | the research coordinator |
| Tools + typegen | `src/tools/` | shared `searchCorpus`, `readDoc`; `dawn check` types them |
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
  `src/app/research/tools/` for coordinator-only tools, then run `npm run check`.
- **Wire a real fetch:** edit `workspace/scripts/fetch-source.mjs` and add the
  command to `permissions.allow.bash` in `dawn.config.ts`.
- **Dogfood sandboxing:** keep `DAWN_DEMO_DOCKER_SANDBOX=1` for isolated
  workspace execution, and seed any files the sandbox needs during the run.
- **Enable summarization:** uncomment the `summarization` block in
  `dawn.config.ts` once your threads get long.
- **Throw it away:** delete `src/app/research/` and start from a single
  `index.ts` — the toolchain (`check`/`build`/`test`/`eval`) still works.
