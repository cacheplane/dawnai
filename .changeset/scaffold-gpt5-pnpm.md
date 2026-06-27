---
"@dawn-ai/evals": patch
---

Default example/scaffold model is now `gpt-5-mini` (the basic scaffold template, README/package-README examples, landing snippets, AGENTS.md template, prompts, and the `llmJudge` default) — finishing the move off `gpt-4o-mini`. Scaffold templates also pre-approve esbuild's build script (`pnpm.onlyBuiltDependencies`) so `pnpm install` works non-interactively in CI and Docker.
