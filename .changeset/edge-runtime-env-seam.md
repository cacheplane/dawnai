---
"@dawn-ai/core": patch
"@dawn-ai/langchain": patch
"@dawn-ai/cli": patch
---

**Edge runtime: `process.env` reads no longer crash a worker.**

`@dawn-ai/cli/fetch` links for Cloudflare workerd with no `node:` specifiers,
which is why the emitted `wrangler.toml` omits `nodejs_compat` — and without
that flag `process` is not defined, so a bare `process.env.X` is a
`ReferenceError` rather than a quiet `undefined`. Six such reads were on the
fetch graph. The worst sat in the openai model constructor, so it fired on the
first turn of the app this target scaffolds.

- New in `@dawn-ai/core`: `readRuntimeEnv(name)` and `seedRuntimeEnv(env)`.
  `readRuntimeEnv` consults `process.env` first and falls back to whatever an
  edge entry point seeded, so behavior under Node is unchanged. `seedRuntimeEnv`
  is re-exported from `@dawn-ai/cli/fetch` alongside `seedModelImporter`.
- `OPENAI_BASE_URL` (in `createChatModel` and `openaiEmbedder`) reads through the
  seam rather than being guarded away. It is configuration, not debug output: a
  guard would have replaced a crash with a deployment whose base URL could not
  be set at all.
- The `DAWN_DEBUG_MEMORY`, `DAWN_DEBUG_SUMMARIZATION`, `DAWN_DEBUG_INTERRUPTS`
  and `DAWN_DEBUG_CONSTRAINTS` reads use the same seam, so they stay off by
  default where there is no `process` and can still be switched on by seeding.
- `test/fetch-entry-purity.test.ts` now gates Node-only globals, not just
  `node:` import edges — a bare global leaves no edge, which is why this class
  shipped past a green suite. The bundle is linked with each of `process`,
  `Buffer`, `global`, `__dirname`, `__filename` and `require` rewritten to a
  sentinel by esbuild's scope-aware `define`, so string literals, comments,
  property names and shadowed locals cannot produce a false hit. Dawn-owned code
  must reference none of them at all; the wider graph must contain no reference
  that lacks a `typeof` guard in the same statement.
