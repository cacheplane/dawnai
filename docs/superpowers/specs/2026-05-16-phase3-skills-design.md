# Phase 3 — Skills Capability (Sub-project 2b) — Design

**Date:** 2026-05-16
**Status:** Draft — pending user approval
**Owner:** Brian Love

## Summary

Add a built-in skills capability to Dawn agents, opted in by the presence of a `skills/` directory in the route directory. Each skill is `src/app/<route>/skills/<name>/SKILL.md` with YAML frontmatter (required `description`; optional `name` defaulting to the directory name). Dawn auto-injects a `# Skills` section into the system prompt listing every available skill's name + description + how to load it. The agent loads a skill's full body on demand via a new `readSkill(name)` tool. Skill bodies live in conversation history; there is no state channel.

This is the second user-facing capability in the phase-3 program (after planning + AGENTS.md autoload). It exercises the autowiring engine and the tool-injection pathway but **not** the state-mutation API or the `loaded_skills` state channel that an earlier draft assumed — research into deepagents and Claude Code revealed both leaders independently rejected that design. The industry-converged pattern is "list in prompt, body on demand."

## Motivation

For everything beyond the basic agent persona, an author wants to teach the agent *how to do specific things* — "how to debug a Python stack trace," "how to query our DB," "how to format a release note." These are too verbose to bake into the systemPrompt (would dominate every turn) and too specialized to qualify as memory (the agent doesn't need them for every conversation).

Skills are the answer: a directory of named knowledge files the agent reaches for when relevant. The agent sees what's available at all times (a small constant cost in the system prompt — name + description per skill); the bulky body content is only loaded when actually needed.

This unlocks the canonical "harness" use case: dropping in a curated knowledge library and watching the agent select among them.

## Why this design (not the earlier draft)

Earlier in this brainstorming session we sketched: `list_skills()` + `load_skill(name)` tools with a `loaded_skills` state channel that re-injects skill bodies into the system prompt every turn.

Subsequent research found that **deepagents** ([github](https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/middleware/skills.ts)) and **Claude Code** ([docs](https://code.claude.com/docs/en/skills)) independently rejected that design:

- **No new tools** for listing/loading. deepagents reuses its existing `read_file`. Claude Code triggers via `/skill-name` or auto-invocation.
- **No re-injection of bodies into the system prompt.** Only names + descriptions are always-visible. Bodies live in conversation history as a single tool-result message.
- **No `unload_skill`.** The agent doesn't need it; the user controls via metadata gating (Claude Code's `paths`, `disable-model-invocation`) and configuration.

We're adopting the same pattern. The earlier draft has been abandoned.

## Non-goals

- **Workspace-mutable skills.** Skill files live in `src/app/<route>/skills/`, source-controlled. The agent cannot create or modify skills. (Future: a `<workspace>/skills/` overlay for agent-learned skills, à la deepagents' multi-source pattern. Deferred.)
- **Auto-summarization-aware skill retention.** Claude Code preserves the most recent invocation of each skill across compaction. Dawn defers this — when summarization ships as a separate capability, it will know about skills as a documented integration point. For v1, a long-running conversation can lose old skill bodies as messages scroll out.
- **Skill packs with bundled assets.** Each skill is one markdown file (subdirectory `SKILL.md`); we don't yet support `assets/`, `scripts/`, or auxiliary files alongside. Adding later is additive (the subdirectory structure leaves room).
- **`allowed-tools` / `model` / per-skill overrides.** Claude Code lets a skill scope which tools / model / context-fork policy it runs under. Powerful but expands the contract; v1 ships with vanilla skills only.
- **The `loaded_skills` state channel from the earlier draft.** Replaced by "body in conversation history."
- **`list_skills` / `load_skill` / `unload_skill` tools from the earlier draft.** Replaced by "system-prompt listing + `readSkill(name)`."
- **State-channel mutation.** Skills don't use the 2c `{result, state}` API. Bodies live in messages, not state.

## User-facing surface

### Author surface — opt in by directory presence

A route has skills if `src/app/<route>/skills/` exists with at least one `<name>/SKILL.md` file inside.

Example layout:

```
src/app/chat/
├── index.ts
├── state.ts
├── system-prompt.ts
├── plan.md
├── tools/
│   ├── listDir.ts
│   ├── readFile.ts
│   ├── writeFile.ts
│   └── runBash.ts
└── skills/
    ├── debug-python/
    │   └── SKILL.md
    ├── query-db/
    │   └── SKILL.md
    └── deploy-to-fly/
        └── SKILL.md
```

Each `SKILL.md` opens with YAML frontmatter:

```markdown
---
name: debug-python          # optional; defaults to the directory name ("debug-python")
description: Step-by-step guide to root-causing a Python stack trace and proposing a fix.
---

# Debug a Python stack trace

When you see a Python traceback:
1. Identify the deepest non-library frame …
…
```

**`description` is required.** Build fails fast (with the skill's path in the error) if a `SKILL.md` has no `description` field. The description is what the agent sees in the listing — sloppy descriptions yield bad load decisions.

**`name` defaults to the directory name.** If frontmatter provides `name`, it's used as-is. The directory name is the canonical reference even when overridden — `readSkill(name)` accepts whichever the marker registered.

Other frontmatter fields are silently ignored in v1 (so a SKILL.md authored for Claude Code or deepagents is forward-compatible).

### What the agent sees

Every model turn, the system prompt picks up a `# Skills` section between user prompt and other capability fragments:

```
<user systemPrompt>

# Planning
…

# Memory
…

# Skills

The following skills are available. To use one, call `readSkill({ name: "<name>" })` to load its full instructions before acting.

- **debug-python** — Step-by-step guide to root-causing a Python stack trace and proposing a fix.
- **query-db** — How to write idiomatic queries against our Postgres conventions (decimal money, JSONB params).
- **deploy-to-fly** — Manual deploy runbook for the staging Fly app.
```

The fragment text (`The following skills are available…`) is Dawn-locked. The list is dynamic per route.

When the agent decides to use a skill, it calls:

```ts
readSkill({ name: "debug-python" })
```

The tool returns the SKILL.md body (frontmatter stripped) as the ToolMessage content. The body is now in the conversation history. On subsequent turns the agent sees the body in its message thread for as long as the messages remain (i.e., until summarization eventually scrolls them out — a v1 limitation).

If the agent calls `readSkill` with an unknown name, the tool returns `"Unknown skill: <name>. Available: debug-python, query-db, deploy-to-fly"` so the model can self-correct.

### What the client sees

No new SSE event type. Skill load is a normal `tool_call` / `tool_result` pair (`name: "readSkill"`). UIs that want to highlight skill loads can filter on that tool name.

## Internal architecture

### Where the marker lives

| Concern | File |
|---|---|
| `createSkillsMarker()` factory + frontmatter parser + system-prompt renderer | `packages/core/src/capabilities/built-in/skills.ts` |
| `readSkill` tool implementation (returns body for a given name) | Same file (built-in capability tool) |
| YAML frontmatter parser | New helper `packages/core/src/capabilities/built-in/frontmatter.ts` (hand-rolled — no new npm dep; needs only `---` block extraction + minimal key:value parsing) |
| Unit tests for parser + marker | `packages/core/test/capabilities/skills.test.ts`, `packages/core/test/capabilities/frontmatter.test.ts` |
| Integration test (apply against a temp route with skills) | `packages/langchain/test/skills.test.ts` |

### `createSkillsMarker()` contract

```ts
export function createSkillsMarker(): CapabilityMarker
```

**Detect:** returns `true` iff `<routeDir>/skills/` exists and contains at least one `<name>/SKILL.md`. The presence of an empty `skills/` directory is treated as not-opted-in.

**Load:** scans the `skills/` directory, parses each `SKILL.md`'s frontmatter, validates `description` is present, and returns a contribution with:
- One `tool`: `readSkill({ name: string }) → string` (the body for the named skill).
- One `promptFragment` placement `after_user_prompt` whose `render(state)` produces the `# Skills` section, sourced from the parsed list (static — doesn't change at render time).
- No `stateFields`, no `streamTransformers`.

The skill list is read at marker-load time (once per `prepareRouteExecution` call) and cached on the contribution. Re-reading every turn isn't needed because the listing is static for the route's lifetime.

### Frontmatter parser

We hand-roll a small parser instead of pulling in a dep. Skills frontmatter is simple: it's a `---`-delimited YAML block at the top of the file with flat `key: value` pairs. We don't need full YAML — no nested objects, no arrays, no anchors. The parser:

1. If the file doesn't start with `---\n`, return `{ body: <whole file>, frontmatter: {} }`.
2. Read up to the second `---\n`. The content between is the frontmatter.
3. Split by lines; for each `key: value` line, trim and store.
4. Return `{ body: <everything after the second ---, with one leading newline stripped>, frontmatter: <parsed object> }`.

Edge cases handled in the parser tests below: trailing whitespace, quoted values (`name: "thing"` strips quotes), comments (lines starting with `#`), missing close `---` (treat as no frontmatter).

If down the road we need real YAML, swap to `yaml` (the npm package) without changing the marker's contract. Hand-rolled is fine for v1.

### `readSkill` tool implementation

```ts
{
  name: "readSkill",
  description: "Load the full instructions for a named skill.",
  schema: z.object({ name: z.string().min(1) }),
  run: async (input: { name: string }) => {
    const found = skills.find((s) => s.name === input.name)
    if (!found) {
      const available = skills.map((s) => s.name).join(", ")
      return `Unknown skill: ${input.name}. Available: ${available}`
    }
    return found.body
  },
}
```

Plain return (no `{result, state}` wrapper); the body becomes the ToolMessage content via the existing JSON.stringify-or-verbatim-string path from sub-project 2c.

Since `body` is a string and the converter passes strings through verbatim, the agent sees the raw markdown body in its ToolMessage (no surrounding quotes).

### System-prompt fragment rendering

The fragment's `render(_state)` is essentially:

```ts
const lines = skills.map((s) => `- **${s.name}** — ${s.description}`).join("\n")
return `${SKILLS_PROMPT_HEADER}\n\n${lines}`
```

Where `SKILLS_PROMPT_HEADER` is the Dawn-locked block:

```
# Skills

The following skills are available. To use one, call `readSkill({ name: "<name>" })` to load its full instructions before acting.
```

This fragment doesn't depend on state; `state` parameter is unused. (The interface still requires it for symmetry with other fragments like planning's `Current plan:`.)

### Composition with other capabilities

In `packages/cli/src/lib/runtime/execute-route.ts`, the registry becomes:

```ts
const registry = createCapabilityRegistry([
  createPlanningMarker(),
  createAgentsMdMarker(),
  createSkillsMarker(),
])
```

Order matters for prompt fragment composition (registration order = render order). Final system prompt structure:

```
<user systemPrompt>

# Planning            (if plan.md present)
…

# Memory              (if workspace/AGENTS.md present)
…

# Skills              (if skills/<name>/SKILL.md files present)
…
```

### Conflict detection

The existing engine fails fast on tool-name collisions. If a user has `tools/readSkill.ts`, the build errors with both file paths in the message. (We'd consider this a feature: tools and skills share the agent's tool namespace, so the name needs to be unique.)

State field collisions don't apply — skills contributes no state fields.

## Edge cases & rules

- **`skills/` directory exists but is empty** → `detect` returns `false`. No skills section, no tool injection. Equivalent to no `skills/` at all.
- **`skills/<name>/` exists but has no `SKILL.md`** (e.g., just an `assets/` folder) → the skill is skipped, not an error. v1 doesn't support asset-only skill subfolders, but doesn't complain about them.
- **A SKILL.md has no frontmatter** → build fails fast with `"<path>/SKILL.md is missing required frontmatter. Add a YAML block at the top with at least `description: …`."`
- **A SKILL.md has frontmatter without `description`** → build fails fast with `"<path>/SKILL.md frontmatter is missing required `description` field."`
- **A skill body is empty** (frontmatter only) → loadable but returns empty string. No special handling; the agent sees an empty ToolMessage. Author's choice.
- **Skill bodies exceeding the model's context window** → tool returns the full body; the model handles overflow per usual. v1 doesn't truncate; we'd consider a soft cap (e.g., 16 KiB) if real cases emerge.
- **Two skills resolve to the same `name` after frontmatter overrides** (one's directory is `foo`, another's frontmatter says `name: bar`, plus a separate `bar/`) → build fails fast on name collision with both paths.
- **Non-UTF-8 SKILL.md** → caught by `readFileSync` in try/catch in the marker's load; surfaced as a build error with the path.
- **Skill directory name is invalid** (e.g., starts with a dot, contains a space) → flag as not-a-skill silently. Only `<alphanumeric>(<alphanumeric>|-|_)*` is treated as a skill name.
- **Subdirectories ignored** (e.g., `skills/debug-python/scripts/foo.py`) → present but irrelevant in v1. The marker only looks for `SKILL.md` at exactly `skills/<name>/SKILL.md`.

## Tests

| Test | File |
|---|---|
| Frontmatter parser: no frontmatter; single-key; multi-key; quoted values; comments; trailing whitespace; missing close marker; CRLF line endings | `packages/core/test/capabilities/frontmatter.test.ts` |
| Marker: doesn't detect when no `skills/` directory | `packages/core/test/capabilities/skills.test.ts` |
| Marker: doesn't detect when `skills/` is empty | same |
| Marker: detects when at least one `skills/<name>/SKILL.md` exists | same |
| Marker: load builds a list with each skill's name (default from dir name) + description | same |
| Marker: load uses `name` from frontmatter when provided, overriding the directory name | same |
| Marker: load fails fast when a SKILL.md has no frontmatter | same |
| Marker: load fails fast when frontmatter lacks `description` | same |
| Marker: load fails fast on duplicate skill names | same |
| Marker: load ignores subdirectories with no SKILL.md | same |
| Marker: load skips invalid directory names silently | same |
| `readSkill` tool: returns body for known skill | same |
| `readSkill` tool: returns helpful error for unknown skill with list of available | same |
| Prompt fragment: rendered output contains `# Skills` header + each skill listed | same |
| Integration: `applyCapabilities` against a temp route directory with two skills produces the expected contribution (tool + fragment, no state fields) | `packages/langchain/test/skills.test.ts` |

No new LLM-touching tests.

## Documentation deliverables

- `examples/chat/README.md` — note that skills are now a shipped capability; remove from "Deferred" section.
- `examples/chat/server/src/app/chat/skills/` — seed two example skills (`workspace-conventions/SKILL.md` and `recover-from-failure/SKILL.md`) to demonstrate the feature when running the example. Same approach we used for plan.md and AGENTS.md.
- `examples/chat/server/src/app/chat/system-prompt.ts` — small addition mentioning skills are available (Dawn already lists them in its injected fragment; just one sentence acknowledging the capability).

## Success criteria

- A route with `skills/<name>/SKILL.md` files compiles, the agent's system prompt includes a `# Skills` section listing each skill's name + description, and the agent can call `readSkill({ name })` to get any skill's body as a ToolMessage.
- A route without `skills/` is byte-for-byte identical in behavior to before this change.
- Manual smoke: ask the chat-server agent a question that matches one of the seeded skills. Observe a `readSkill` tool call, then an answer that uses the skill's content.
- All five workspace checks pass: install, build, typecheck, test, lint, pack:check.
- Frontmatter parser tests cover at least 8 scenarios (per the test list above).

## Open questions

- **`readSkill` body size cap.** Should we soft-cap (e.g., 16 KiB) and return a truncation notice? Skipped for v1; the v1 limit is whatever the agent's context window allows, which is the same as any other large tool result.
- **Multi-source skill discovery** (project + user + plugin). deepagents supports `sources: [...]` for layered overrides. Dawn v1 supports only `src/app/<route>/skills/` (project). Add layering in v2 when there's a concrete user-skills use case.
- **Should we ship a small built-in skill library** (e.g., `dawn-builtin/` with skills like "explain your reasoning before acting") that comes free with any Dawn agent? Probably no for v1 — capability authors should own their skill content, not us. Revisit if there's demand.
