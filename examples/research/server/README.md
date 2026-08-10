# Research demo — server

The flagship [Dawn](https://github.com/cacheplane/dawnai) example: a deep-research
assistant that plans sub-questions, researches a bundled local corpus with a
specialist subagent, and writes a cited report. Live research uses a real model
and API key; the included tests and evals use deterministic fixtures and run
offline.

## Run it

```bash
pnpm install                 # from the repo root
pnpm build                   # build Dawn packages before commands that use dist
pnpm --filter @dawn-example/research-server exec dawn typegen  # write generated types
pnpm --filter @dawn-example/research-server check   # validate routes, tools, and config
pnpm --filter @dawn-example/research-server test    # harness tests, offline (replay fixtures)
pnpm --filter @dawn-example/research-server eval     # quality evals, offline (replay fixtures)
pnpm --filter @dawn-example/research-server memory:list
```

To run against a real model, set `OPENAI_API_KEY` and add `--live`
(e.g. `pnpm --filter @dawn-example/research-server eval -- --live`). The offline
path uses recorded fixtures, so tests and evals are deterministic and need no
API key.

## Run the live web client

The current Next.js/CopilotKit client streams cited research, renders generic
tool calls, handles standard permission interrupts, offers suggestion prompts,
and reviews memory candidates. After the root install and build above, run from
`examples/research`:

```bash
cp server/.env.example server/.env   # add a real OPENAI_API_KEY
pnpm dev                             # Dawn server on :3002, web client on :3010
```

Open `http://localhost:3010`. The key stays on the Dawn server; see
[`../web/README.md`](../web/README.md) for the architecture and smoke checklist.

To dogfood the Docker sandbox, start Docker and run:

```bash
pnpm --filter @dawn-example/research-server test:sandbox:docker
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

This app uses candidate memory writes. When the agent calls `remember`, the
memory is saved for review instead of becoming active immediately.

```bash
pnpm --filter @dawn-example/research-server memory:list
pnpm --filter @dawn-example/research-server memory:approve -- <memory-id>
```

The tests show both paths: seeding an active memory with `seedMemory`, and
writing a reviewable candidate through the real `remember` tool.
