# Phase 3 — AGENTS.md Autoload (Sub-project 2a) — Design

**Date:** 2026-05-15
**Status:** Draft — approved verbally; spec authoritative
**Owner:** Brian Love

## Summary

Add a built-in capability that auto-injects the contents of `<workspace>/AGENTS.md` into a Dawn agent's system prompt on every model turn. Always-on (no opt-in marker file): the presence of the data file IS the opt-in. Preserves the agent-updates-its-own-memory feedback loop — the agent calls `writeFile({ path: "AGENTS.md", content: ... })` via the existing filesystem tool and the next turn sees the updated memory in its prompt automatically.

This is sub-project 2a of the phase-3 program. It exercises the autowiring engine shipped in #144 with the smallest possible additional capability — one promptFragment, no tool injection, no state-channel injection. Sub-project 2b (skills/ directory) is a separate later cycle.

## Motivation

The canonical chat example (`examples/chat`) currently teaches the agent the memory convention manually via the system prompt: "at the start of every task, run listDir; if AGENTS.md exists, readFile it." The agent burns two tool calls per task to load context that's the same every time. Auto-injection eliminates those calls and shifts memory access from a learned behavior to a framework guarantee.

It also closes a row from the chat example's README "Deferred (phase-3 preview)" list — making the example honest about what Dawn ships today vs. what it doesn't.

## Non-goals

- **Sub-project 2b (skills/ + SKILL.md loader).** Distinct capability — agent-callable on-demand knowledge. Its own cycle.
- **Route-dir AGENTS.md as static author instructions.** Different feature (not memory, since the agent can't update source-controlled files at runtime). Could fold into 2b or get a micro-sub-project later. Not this PR.
- **Per-route workspace path configuration.** v1 hard-codes `<process.cwd()>/workspace` to match what the chat example does. Plumbing through `dawn.config.ts` is a follow-up when a concrete consumer needs it.
- **Smart memory truncation.** Files over 64 KiB get a single line saying so; no semantic summarization, no head/tail keep.
- **Per-thread memory files.** All threads in a workspace share `AGENTS.md`. Per-thread isolation would require state-channel coordination; deferred.
- **A `memory_update` SSE event** when the agent writes AGENTS.md. Symmetric with `plan_update` and worth adding once a UI consumer exists; deferred.
- **Backwards-compat shims.** Behavior is additive. Routes whose workspace has no AGENTS.md are byte-for-byte identical to today.

## User-facing surface

### Author surface

None. The capability is always-on and requires no configuration. If `<workspace>/AGENTS.md` exists at the moment the agent renders its system prompt, its content is injected; otherwise nothing happens.

The chat example demonstrates the convention with a seed `workspace/AGENTS.md` already present (committed via `examples/chat/.gitignore`'s `!workspace/AGENTS.md` exception).

### What the agent sees

On every model turn, the effective system prompt becomes:

```
<user systemPrompt>

# Planning      (if plan.md present in route dir)
...
Current plan: ...

# Memory        (if workspace/AGENTS.md present and non-empty)
<file content, verbatim>
```

The `# Memory` heading is Dawn-locked. The content is the raw file contents — Dawn doesn't reformat, summarize, or annotate.

### Feedback loop

The agent already has the `writeFile` workspace tool from the chat example. When it calls `writeFile({ path: "AGENTS.md", content: "<updated>" })`:

1. The file is rewritten (path-jailed to the workspace).
2. On the next model turn, the prompt fragment re-reads `workspace/AGENTS.md` and injects the new content.
3. The agent sees its own updated memory in context the very next turn — no need to issue another `readFile`.

This is the property that distinguishes "memory" from "static instructions" and the reason workspace AGENTS.md is the right location.

## Internal architecture

### Where it lives

| Concern | Location |
|---|---|
| `createAgentsMdMarker()` factory + promptFragment | `packages/core/src/capabilities/built-in/agents-md.ts` |
| Unit tests | `packages/core/test/capabilities/agents-md.test.ts` |
| End-to-end shape test | `packages/langchain/test/agents-md.test.ts` |
| Public re-export | `packages/core/src/index.ts` (append) |
| Registry registration | `packages/cli/src/lib/runtime/execute-route.ts` (add to the existing `createCapabilityRegistry([...])` array) |

### Marker shape

```ts
export function createAgentsMdMarker(): CapabilityMarker {
  return {
    name: "agents-md",
    detect: async () => true,       // always-on
    load: async () => ({
      promptFragment: {
        placement: "after_user_prompt",
        render: () => renderMemoryFragment(workspaceAgentsMdPath()),
      },
    }),
  }
}
```

The marker returns no tools, no state fields, no stream transformers — just one promptFragment.

### `renderMemoryFragment` semantics

```
1. Resolve path to <process.cwd()>/workspace/AGENTS.md.
2. existsSync(path) — if false, return "".
3. statSync(path).size > 64 KiB — return:
     "# Memory\n\n(workspace/AGENTS.md is {bytes} bytes; exceeds 64 KiB limit — not loaded)"
4. readFileSync(path, "utf8") — wrapped in try/catch.
   - Any error → return "" (don't crash the agent for a stat race or permission glitch).
5. Trim whitespace. Empty string → return "".
6. Otherwise return:
     `# Memory\n\n${trimmed}`
```

The function is sync, takes no `state` argument (memory is file-backed, not state-backed), but its signature must accept `state` to satisfy the `PromptFragment` interface. The argument is unused.

### Workspace root resolution

For v1, the workspace root is `<process.cwd()>/workspace`. This matches what the chat example's tools already use via `workspaceRoot()`. Encapsulate the resolution in a private helper:

```ts
function workspaceAgentsMdPath(): string {
  return resolve(process.cwd(), "workspace", "AGENTS.md")
}
```

Document that the helper assumes the Dawn dev server's `cwd` is the route's package root (true today via `dawn dev`). Per-route configuration is a deferred follow-up.

### Wiring into the engine

`packages/cli/src/lib/runtime/execute-route.ts` currently does:

```ts
const registry = createCapabilityRegistry([createPlanningMarker()])
```

Changes to:

```ts
const registry = createCapabilityRegistry([
  createPlanningMarker(),
  createAgentsMdMarker(),
])
```

That's the entire integration surface in the runtime. The existing prompt-fragment composition, contribution merging, and conflict detection logic from #144 already handle multiple markers and multiple fragments.

### Prompt fragment ordering

Multiple promptFragments on a single agent are rendered in **marker registration order**. With both markers registered, the order is `planning` then `agents-md`. This means the system prompt becomes:

```
<user systemPrompt>

# Planning
...

# Memory
...
```

Document this in the spec as the rule: registration order = render order. Later capabilities should not assume a particular order; if a capability needs a specific position relative to others, that needs explicit work (e.g., a `priority` field on the promptFragment).

### Conflict detection

Not applicable. The marker contributes no tools and no state fields, so the existing fail-fast collision checks have nothing to fire on. (The user is free to have a `tools/AGENTS.md` directory or whatever — no name clash.)

## Edge cases & rules

- **`workspace/` doesn't exist** (e.g., a fresh checkout that hasn't run anything yet) → no AGENTS.md → empty render. No directory creation. Don't preemptively `mkdir`.
- **`AGENTS.md` exists but is empty / whitespace-only** → empty render. No `# Memory` heading.
- **`AGENTS.md` exists but is 65 KiB** → render the size notice (single line, no content). Don't truncate to 64 KiB and inject the truncated body — silent truncation is worse than explicit refusal.
- **`AGENTS.md` exists but isn't UTF-8** → `readFileSync(path, "utf8")` may produce mojibake. Don't try to detect encoding; let UTF-8 happen. If the read throws (extremely rare), the catch swallows it and returns empty.
- **`AGENTS.md` is a symlink to outside `workspace/`** → not validated. The user owns their workspace. (The path-jail helper in the chat example covers writes; reads via this capability are read-only and the file is whatever the user committed.)
- **`AGENTS.md` is a directory** → `statSync` returns a stat, `readFileSync` throws → caught → empty render. No crash.
- **Race: file deleted between `existsSync` and `readFileSync`** → catch handles it → empty render.

## Documentation deliverables in this PR

- `examples/chat/server/src/app/chat/system-prompt.ts` — remove the "if AGENTS.md exists, run readFile" line; keep "update AGENTS.md when meaningful work happens." Cleaner: the system prompt no longer instructs the agent on something Dawn now does automatically.
- `examples/chat/README.md` — note AGENTS.md autoload is shipped; remove the "AGENTS.md auto-injection — needs the skills convention" line from the Deferred section.

Both tweaks land in this PR (small diffs, conceptually atomic with the capability).

## Tests

| Test | File |
|---|---|
| `createAgentsMdMarker` always detects (returns true) | `packages/core/test/capabilities/agents-md.test.ts` |
| `load` returns a promptFragment with `placement: "after_user_prompt"` | same |
| `load` returns no tools, no stateFields, no streamTransformers | same |
| Render returns empty string when `<cwd>/workspace/AGENTS.md` doesn't exist | same |
| Render returns content under `# Memory` heading when file exists with content | same |
| Render returns empty string when file exists but is whitespace-only | same |
| Render returns size-notice (with byte count) when file exceeds 64 KiB | same |
| Render returns empty string when read throws (file is a directory; or doesn't exist between exists+read) | same |
| Render re-reads on each call — modify file between two `render()` calls, observe new content | same |
| End-to-end shape: `applyCapabilities` returns the agents-md contribution with the expected promptFragment | `packages/langchain/test/agents-md.test.ts` |

Tests temporarily `chdir` into a temp directory so `process.cwd()` resolves to a controlled location. Restore cwd in `afterEach`. (Use `process.chdir(originalCwd)` in cleanup.)

No new LLM-touching tests.

## Success criteria

- A new `agents-md` `CapabilityMarker` exists in `@dawn-ai/core`, registered alongside `planning` in `prepareRouteExecution`.
- With a `workspace/AGENTS.md` file present, the agent's system prompt includes a `# Memory` block containing the file's content, re-rendered on every model turn.
- Without a `workspace/AGENTS.md` file, the system prompt is unchanged from today's behavior (the fragment renders empty and gets filtered at compose time).
- Manual smoke: edit `workspace/AGENTS.md` between two requests, the agent's behavior in the second request reflects the updated memory without an explicit `readFile` call.
- Manual smoke: agent calls `writeFile({ path: "AGENTS.md", content: ... })`, the next turn's system prompt shows the updated content.
- The chat example's system prompt no longer asks the agent to manually read AGENTS.md at task start.
- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm pack:check` all pass.

## Open questions

- **Should there be a "memory loaded" telemetry / log line?** Not in v1. Add only when there's a concrete debugging need.
- **What if the user wants to disable autoload for a specific route?** Today, AGENTS.md is opt-in by presence (no file = no autoload). If a route's workspace has AGENTS.md for human reference but the user doesn't want it in the agent's prompt, the workaround is "don't have AGENTS.md in `workspace/`." A future `agents-md.disabled` marker file could opt-out, but no concrete user is asking for it.
