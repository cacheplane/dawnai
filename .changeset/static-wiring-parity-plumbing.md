---
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/testing": patch
---

Load the app once per process. `dawn.config.ts` is memoized per app root; the
runtime passes its boot-resolved checkpointer, threads store, and permissions
store into route execution instead of reconstructing them per request (three
SQLite opens per turn eliminated); the memory store opens lazily on first use
and is shared between the memory HTTP routes and the memory capability; route
modules, tools, state, and route memory load once per route and are cached for
the process lifetime, and the per-request route rediscovery is gone. In
`dawn dev`, tool/state/reducer edits now restart the child runtime — fixing a
stale-module bug where such edits silently did not apply (the previous
re-import mechanism was a no-op under tsx) — and the restart log names the
reason. Groundwork for build-time static wiring and the edge deploy targets.
