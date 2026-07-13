# Dawn examples

Canonical, runnable examples of Dawn applications. Each example is a folder containing one or more workspace packages.

| Example | What it shows |
|---|---|
| [chat](./chat) | Foundational agent-harness primitives (filesystem + bash) end-to-end, with a disposable smoke-test web client |
| [memory](./memory) | Long-term memory with a backend-switchable store — zero-setup SQLite by default, Postgres + pgvector via `DATABASE_URL`, hybrid keyword + vector recall via `OPENAI_API_KEY` |
| [research](./research) | The flagship deep-research assistant example — routes, tools, subagents, memory, planning, offloading, HITL permissions, and an optional Docker sandbox |

These examples are pnpm workspace members. They consume Dawn via `workspace:*` and are typechecked in CI.
