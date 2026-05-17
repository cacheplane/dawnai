---
"@dawn-ai/core": minor
"@dawn-ai/cli": minor
---

Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

- An always-on `# Skills` section in the system prompt listing each skill's name + description
- A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. Typegen includes `readSkill` in `RouteTools` when a route has skills. The chat example ships two seeded skills (`workspace-conventions`, `recover-from-failure`).
