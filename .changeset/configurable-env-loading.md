---
"@dawn-ai/cli": minor
"@dawn-ai/core": minor
---

Configurable env loading for `dawn dev` and `dawn verify`. The env file is now resolved by precedence: `--env-file <path>` flag > `dawn.config.ts` `env` field > default `./.env`. Shell-exported variables still win over file contents.

- New optional `DawnConfig.env` field (a path relative to the app root). Local-only — it does not affect the deploy artifact; `langgraph.json` env detection (`.env.example` → `.env`) is unchanged.
- New `--env-file <path>` flag on `dawn dev` and `dawn verify`.
- A shared `resolveEnvPath` resolver now backs both `dev` and `verify`, so they agree on which file they read.
- `loadEnvFile(dir)` is refactored to `loadEnvFiles(absPaths)` with a back-compat wrapper retained; the LangSmith auto-trace and shell-wins behaviors are preserved.

This unblocks monorepo apps: a nested app can set `env: "../../.env"` to load the workspace-root env file.
