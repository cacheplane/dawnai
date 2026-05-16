# Workspace memory

Dawn auto-injects this file's contents into the agent's system prompt on every
turn. The agent updates it via `writeFile({ path: "AGENTS.md", content: ... })`
when it learns something worth remembering across sessions.

This file is intentionally pre-seeded with a few illustrative facts so you can
see the autoload in action on a fresh run. Replace this block with whatever
matters for your project once the agent starts recording real notes.

## Project facts (example seeds)

- Workspace tools use camelCase names: `listDir`, `readFile`, `writeFile`, `runBash`.
- The workspace root is `examples/chat/server/workspace`. Anything outside it is
  off-limits — the tool layer path-jails reads and writes.
- Plans live in the `todos` state channel (managed by `write_todos`), not in
  this file. Use this file for things that should survive across sessions; use
  planning for the current task's checklist.
