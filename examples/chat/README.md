# Chat — canonical Dawn harness example

> **Status:** foundational harness primitives (filesystem + bash) plus the **planning**,
> **skills**, **subagents**, and **workspace** capabilities. Pluggable backend
> implementations (in-memory, remote sandbox) are available — see `dawn.config.ts`. HITL
> permission gating and auto-summarization are still deferred — see "Deferred" below.

## What this shows

- Dawn route discovery and the `tools/` convention
- **Workspace capability** — when a route's working directory contains `workspace/`, Dawn
  auto-contributes `readFile`/`writeFile`/`listDir`/`runBash` tools wired through pluggable
  backends. The filesystem and exec backends default to local node:fs / child_process; swap
  them in `dawn.config.ts` for in-memory storage, remote sandboxes, etc.
- `AGENTS.md` memory autoload — Dawn auto-injects `workspace/AGENTS.md` into the system prompt on every turn; the agent updates it via `writeFile`
- **Planning** — `plan.md` in the route directory opts the agent into the built-in
  `writeTodos` tool, a `todos` state channel, and a `plan_update` SSE event. Open the
  smoke client's event log; you'll see `event: plan_update` lines whenever the agent
  updates its plan.
- **Skills** — `src/app/chat/skills/<name>/SKILL.md` files are auto-listed in
  the agent's system prompt (name + description). The agent calls
  `readSkill({ name })` to load a skill's full body on demand. Two example
  skills ship with the demo: `workspace-conventions` and `recover-from-failure`.
- **Subagents** — `/coordinator` dispatches to specialist subagents (`research`,
  `summarizer`) via an auto-generated `task({ subagent, input })` tool. Subagent runs
  bubble `subagent.*` SSE events with `call_id` correlation. Pick the `/coordinator` route
  in the smoke client to drive it.
- End-to-end streaming from a Next.js client over SSE

## Model choice

This example uses `gpt-5` with `reasoning: { effort: "high" }`. In live testing, smaller models (`gpt-5-mini`, `gpt-5-nano`) tend to ignore explicit tool-use directives and produce generic "what can I help you with?" responses on the first turn — they don't reliably exercise the planning + memory capabilities. `gpt-5` engages with tools and actually drives an agent loop. The tradeoff: each turn costs more.

If you swap to a smaller model, expect to do more prompt-engineering work to get tool calls to fire.

## Quickstart

```bash
cp server/.env.example server/.env   # add OPENAI_API_KEY
cp web/.env.example web/.env.local
pnpm install
pnpm dev
# open http://localhost:3000
```

## Layout

```
examples/chat/
├── server/                 # @dawn-example/chat-server (Dawn routes)
│   ├── dawn.config.ts      # appDir + optional backends config
│   ├── workspace/          # shared workspace (AGENTS.md lives here)
│   └── src/app/
│       ├── chat/                              # /chat route
│       │   ├── index.ts                       # agent({ model, systemPrompt })
│       │   ├── state.ts
│       │   ├── system-prompt.ts
│       │   ├── plan.md                        # presence enables planning
│       │   └── skills/                        # SKILL.md files per skill
│       └── coordinator/                       # /coordinator route + subagents
│           ├── index.ts
│           └── subagents/
│               ├── research/index.ts
│               └── summarizer/index.ts
└── web/                    # @dawn-example/chat-web (Next.js smoke client)
    └── app/
        ├── page.tsx        # route picker + textarea + Send + raw event log
        └── api/chat/route.ts   # SSE proxy
```

## Security caveats

**`runBash` executes shell commands on your machine with `cwd: workspace/` and a timeout.
This is NOT a sandbox.** Network calls, package installs, file ops outside `workspace/` via
shell expansion — all possible. Do not point untrusted users at this example.

## Deferred (Dawn phase-3 preview)

These v1 deferrals are the explicit forcing function for Dawn's opinionated harness work:

- HITL permission gating — interrupt the run when a path is outside the workspace or a
  command is high-risk, ask the user, persist the decision
- Tool-output offloading and context summarization — needs lifecycle hooks
- Nested-object tool inputs (e.g., `edit_file({ edits: [{ old, new }] })`) — typegen extension
- Polished web UI — wait for harness primitives to stabilize
