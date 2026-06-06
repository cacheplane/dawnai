---
"@dawn-ai/testing": minor
"@dawn-ai/core": minor
---

`@dawn-ai/core`: the workspace and AGENTS.md capabilities now activate relative to the **app root** instead of `process.cwd()`, so they work when an app is run from any working directory (e.g. in-process tests, embedded use). No behavior change under `dawn dev` (where cwd is the app root). `CapabilityMarkerContext` gained a required `appRoot: string` field — if you construct that type in a custom capability marker or its tests, add `appRoot`.


Extend `@dawn-ai/testing` to cover the rest of Dawn's agent capabilities. `AgentRunResult` now captures interrupts, plan updates, subagent runs, and the composed system prompt (read from aimock's request journal via `AimockHandle.getRequests()`); `harness.resume({ decision })` drives HITL interrupt→resume flows. New matchers: `expectInterrupt`/`expectNoInterrupt`, `expectSubagent`, `expectPlan`, `expectSystemPrompt` (and `expectPlan().toHaveLength`, `expectSystemPrompt().toMatch`). Dawn's own chat/coordinator example apps are now dogfooded with in-process e2e for HITL permissions, subagents, planning, skills, and AGENTS.md memory. The dogfood surfaced and fixed a harness bug: gpt-5/reasoning routes send the system prompt under the `developer` role, which the system-prompt capture now recognizes. No framework changes — all capability events were already emitted by the runtime. CI now runs the `@dawn-ai/testing` package suite and the chat-example capability e2e (both were previously absent from the vitest workspace).
