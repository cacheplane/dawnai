---
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Leave CopilotKit telemetry off in a scaffolded app.

CopilotKit's runtime reports usage by default, so `npm run build` on a freshly
generated app POSTed to `https://telemetry.copilotkit.ai/ingest` while Next
collected page data — before the author had written a line of code. The
generated `web/next.config.mjs` now sets `COPILOTKIT_TELEMETRY_DISABLED` unless
the environment already says otherwise, so opting back in is still one variable
away.

The placement is the fix, not a detail. CopilotKit builds its telemetry client
at module scope and reads the environment inside that constructor, and ESM
evaluates imports before the importing module's body — so setting this in the
route handler that imports the runtime would look correct and change nothing.
`next.config.mjs` is the first module Next evaluates, for `next build`,
`next dev` and `next start` alike.
