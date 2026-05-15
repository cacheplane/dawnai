# Chat — canonical Dawn harness example

> **v1 status:** foundational harness primitives only (filesystem + bash).
> Subagents, planning state, sandbox isolation, auto-summarization, and skills
> are deferred — see "Deferred" below.

## What this shows

- Dawn route discovery and the `tools/` convention
- Filesystem tools (read/write/list) + bash, path-jailed to `./workspace`
- `AGENTS.md` memory convention (manual in v1)
- End-to-end streaming from a Next.js client over SSE

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
│       └── tools/          # list-dir, read-file, write-file, run-bash
└── web/                    # @dawn-example/chat-web (Next.js smoke client)
    └── app/
        ├── page.tsx        # textarea + Send + raw event log
        └── api/chat/route.ts   # SSE proxy
```

## Security caveats

**`run-bash` executes shell commands on your machine with `cwd: workspace/` and a timeout.
This is NOT a sandbox.** Network calls, package installs, file ops outside `workspace/` via
shell expansion — all possible. Do not point untrusted users at this example.

## Known issues

- **`zod-to-json-schema` peer-dep mismatch** — running the agent currently surfaces
  `Package subpath './v3' is not defined by "exports" in zod@3.24.4`. This is a Dawn-side
  resolution issue: `zod-to-json-schema@3.25.2` requires `zod@^3.25.28 || ^4`, but Dawn's
  `packages/langchain` pins `zod@3.24.4`. The example's `dawn check`, `dawn build`, and
  dev-server boot all pass; the error appears only when the LangChain bridge generates
  tool schemas. Tracked separately from this example.

## Deferred (Dawn phase-3 preview)

These v1 deferrals are the explicit forcing function for Dawn's opinionated harness work:

- Subagent delegation (`task`-style tool) — needs first-class subagent declarations
- Planning state (`write_todos`) — needs build-time agent middleware + state channel composition
- `AGENTS.md` auto-injection — same
- Skills (`skills/` dir + `SKILL.md` loader) — mirror of the `tools/` convention
- Real sandbox isolation for `run-bash` — needs pluggable execution backends
- Tool-output offloading and context summarization — needs lifecycle hooks
- Nested-object tool inputs (e.g., `edit_file({ edits: [{ old, new }] })`) — typegen extension
- Polished web UI — wait for harness primitives to stabilize
