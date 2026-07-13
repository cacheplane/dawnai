---
"@dawn-ai/cli": patch
---

`dawn verify` now runs an environment preflight. A new `runtime` check asserts the running Node version meets Dawn's `22.13.0` floor (a stale Node fails verify) and, when `dawn.config.ts` configures a sandbox provider, runs the provider's Docker daemon preflight. The `deps` env-var check is now provider-aware: it derives the required API-key env var from the providers your routes actually use (e.g. `ANTHROPIC_API_KEY` for an Anthropic-only app) instead of always nagging about `OPENAI_API_KEY`.
