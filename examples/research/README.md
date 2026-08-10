# Research demo

The flagship Dawn example — a deep-research assistant. See
[`server/README.md`](./server/README.md) for the full tour and how to run it.

- `server/` — the Dawn app: routes, tools, subagents, memory,
  planning, offloading, HITL permissions, optional Docker sandbox, tests, evals.
- `web/` — the live CopilotKit/AG-UI client: streaming chat, suggestion prompts,
  tool cards, permission handling, and memory review. Live runs require a real
  `OPENAI_API_KEY` on the server; the client does not offer a keyless demo mode.
