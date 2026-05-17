---
description: Reminders about how Dawn's workspace tools behave and what the path-jail allows.
---

# Workspace conventions

The four workspace tools (`listDir`, `readFile`, `writeFile`, `runBash`) all
operate inside `<example>/workspace/`. Reads and writes outside that directory
are rejected by the path-jail with a clear error.

- All paths are relative to the workspace root.
- `listDir({ path: "." })` lists the workspace root.
- `readFile({ path: "AGENTS.md" })` reads the memory file you also see in your
  system prompt (so reading it again is redundant; prefer the version Dawn
  injected for you).
- `runBash` spawns inside the workspace with a hard timeout. Use it for one-shot
  shell tasks; don't try to start long-lived background processes.

If you get a "Path is outside workspace" error, the path needs to be relative
to the workspace root and must not contain `..` segments.
