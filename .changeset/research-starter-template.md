---
"create-dawn-ai-app": minor
"@dawn-ai/devkit": minor
---

Add a "research" scaffold template — a deep-research assistant that showcases
Dawn's broad capability set (planning, subagents, custom tools + typegen,
tool-output offloading, AGENTS.md memory, skills, HITL permissions, workspace,
persistence, tests, and evals) — and make it the default `create-dawn-ai-app`
output. It runs offline and deterministically out of the box (replay fixtures)
and against a real model under `--live`. The minimal "basic" template remains
available via `--template basic`.
