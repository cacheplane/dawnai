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
```

To run against a real model, set `OPENAI_API_KEY` and add `--live`
(e.g. `npm run eval -- --live`). The offline path uses recorded fixtures, so
tests and evals are deterministic and need no API key.

## The tour — where each capability lives

| Capability | File | What it shows |
|---|---|---|
| Agent route | `src/app/research/index.ts` | the research coordinator |
| Tools + typegen | `src/app/research/tools/` | `searchCorpus`, `readDoc`; `dawn check` types them |
| Subagents | `src/app/research/subagents/researcher/` | dispatched via `task({ subagent, input })` |
| Planning | `src/app/research/plan.md` | seeded checklist becomes the thread's todos |
| Offloading | `dawn.config.ts` + a large `readDoc` | big results spill to the workspace, stubbed in-context |
| Memory | `workspace/AGENTS.md` | house style injected into the prompt |
| Skills | `src/app/research/skills/` | `cite-sources`, `synthesize-findings` |
| HITL permissions | `dawn.config.ts` + `workspace/scripts/fetch-source.mjs` | the external fetch pauses for approval |
| Workspace | `workspace/` | corpus + report output behind a path-jail |
| Persistence | (default) | threads survive a restart (SQLite) |
| Tests | `test/research.test.ts` | `createAgentHarness` + `script()` |
| Evals | `src/app/research/evals/` | `defineEval` + scorers + a gate |

## Make it yours

This is a starter — extend the parts you want and delete the rest:

- **Swap the corpus:** replace `workspace/corpus/*.md` with your own documents.
- **Add tools:** drop a file in `src/app/research/tools/` and run `npm run check`.
- **Wire a real fetch:** edit `workspace/scripts/fetch-source.mjs` and add the
  command to `permissions.allow.bash` in `dawn.config.ts`.
- **Enable summarization:** uncomment the `summarization` block in
  `dawn.config.ts` once your threads get long.
- **Throw it away:** delete `src/app/research/` and start from a single
  `index.ts` — the toolchain (`check`/`build`/`test`/`eval`) still works.
