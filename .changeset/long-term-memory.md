---
"@dawn-ai/memory": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/sdk": patch
"@dawn-ai/testing": patch
"@dawn-ai/evals": patch
"@dawn-ai/devkit": patch
"create-dawn-ai-app": patch
---

Add long-term memory. Routes gain a typed, cross-session memory collection via
`defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
`remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
(node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
The research scaffold template now ships a `memory.ts`/`memory.md` example.
