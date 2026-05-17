# Chat — canonical Dawn harness example

> **Status:** foundational harness primitives (filesystem + bash) + the **planning** and
> **skills** capabilities. Subagents, sandbox isolation, and auto-summarization are still
> deferred — see "Deferred" below.

## What this shows

- Dawn route discovery and the `tools/` convention
- Filesystem tools (read/write/list) + bash, path-jailed to `./workspace`
- `AGENTS.md` memory autoload — Dawn auto-injects `workspace/AGENTS.md` into the system prompt on every turn; the agent updates it via `writeFile`
- **Planning** — `plan.md` in the route directory opts the agent into the built-in
  `write_todos` tool, a `todos` state channel, and a `plan_update` SSE event. Open the
  smoke client's event log; you'll see `event: plan_update` lines whenever the agent
  updates its plan.
- **Skills** — `src/app/chat/skills/<name>/SKILL.md` files are auto-listed in
  the agent's system prompt (name + description). The agent calls
  `readSkill({ name })` to load a skill's full body on demand. Two example
  skills ship with the demo: `workspace-conventions` and `recover-from-failure`.
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
├── server/                 # @dawn-example/chat-server (Dawn route + tools)
│   └── src/app/chat/
│       ├── index.ts        # agent({ model, systemPrompt })
│       ├── state.ts
│       ├── system-prompt.ts
│       ├── workspace-path.ts
│       ├── plan.md         # presence enables planning; seeds initial todos
│       └── tools/          # listDir, readFile, writeFile, runBash
└── web/                    # @dawn-example/chat-web (Next.js smoke client)
    └── app/
        ├── page.tsx        # textarea + Send + raw event log
        └── api/chat/route.ts   # SSE proxy
```

## Security caveats

**`runBash` executes shell commands on your machine with `cwd: workspace/` and a timeout.
This is NOT a sandbox.** Network calls, package installs, file ops outside `workspace/` via
shell expansion — all possible. Do not point untrusted users at this example.

## Deferred (Dawn phase-3 preview)

These v1 deferrals are the explicit forcing function for Dawn's opinionated harness work:

- Subagent delegation (`task`-style tool) — needs first-class subagent declarations
- Real sandbox isolation for `runBash` — needs pluggable execution backends
- Tool-output offloading and context summarization — needs lifecycle hooks
- Nested-object tool inputs (e.g., `edit_file({ edits: [{ old, new }] })`) — typegen extension
- Polished web UI — wait for harness primitives to stabilize
