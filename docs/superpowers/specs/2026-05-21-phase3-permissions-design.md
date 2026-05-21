# Phase 3 — HITL Permissions Design (sub-project 4.5)

**Status:** Spec
**Date:** 2026-05-21
**Builds on:** sub-project 4 (workspace capability + pluggable backends, PR #170)

## Goal

Replace the workspace capability's hard-refuse-on-path-jail-escape behavior with a human-in-the-loop permission flow, and add the same prompt-for-approval gating to `runBash`. The user sees a permission prompt on first occurrence of any non-pre-approved bash command or out-of-workspace path operation; they can grant once, always-for-pattern, or deny. Persisted "always" decisions live in a project-local `.dawn/permissions.json` that's gitignored by default. Production deployments run in non-interactive or bypass mode with a curated allow/deny list.

## Architecture

A new `@dawn-ai/permissions` package ships the pattern-matching engine, the persistence store, and the public types. The existing workspace capability gains a permission check between the path-jail / bash invocation and the actual backend call. When a check returns "unknown", the capability emits LangGraph's `interrupt()` with a `PermissionRequest` payload; the parent run pauses; the SSE stream surfaces `event: interrupt` to the client; the client resolves the prompt and POSTs to `/threads/{thread_id}/resume`; the runtime resumes the graph with `Command({resume})` and the capability acts on the decision.

The three operating modes — `"interactive"`, `"non-interactive"`, `"bypass"` — encode the realistic deployment shapes (interactive dev, production with config-only enforcement, intentional bypass for trusted environments). Mode comes from `dawn.config.ts`'s new `permissions` field or the `DAWN_PERMISSIONS_MODE` env var.

The persistence file format mirrors the runtime API: a tool-keyed `{allow, deny}` object. Same shape in `.dawn/permissions.json` (runtime additions, per-developer, gitignored) and in `dawn.config.ts`'s `permissions.allow` / `permissions.deny` (design-time baseline, checked in). Effective permissions = config + runtime, with deny always winning.

## Design Decisions

### Scope: path-jail escapes + every bash command

Matches the industry-standard tool-call-level gating used by Claude Code, OpenAI Codex CLI, and Cursor. Bash gets prompted on every first occurrence (Claude Code parity); path escapes that would previously hard-refuse now prompt. Other tools (`readFile`, `writeFile`, `listDir`) only prompt when the resolved path is outside the workspace — staying inside is silent, matching today's behavior.

Rejected: "risky-pattern only" gating for bash. The set of risky commands is impossible to enumerate completely; missing patterns become silent failures of judgment. Prompting every first-occurrence command and relying on prefix-matched "always" persistence is the industry-validated approach.

Rejected: generalized capability-driven gating (any tool can declare itself gateable). Premature surface design without empirical signal on what authors need. Build on 4.5's interrupt/resume/persistence infrastructure later if real demand surfaces (sub-project 4.6 territory).

### Three approval scopes: Once / Always-for-pattern / Deny

The user sees three buttons on every prompt:

- **Once** — allows this single call. Next equivalent call prompts again.
- **Always** — persists an allow entry using the suggested pattern (prefix-matched). Future matching calls are silent.
- **Deny** — refuses this call. The tool returns an error to the agent. The agent can recover (apologize, try a different approach). No persistent deny entry — that's deferred to 4.6.

Rejected "for-session" as a fourth scope. Adds cognitive load with marginal value. If users need transient approvals, they can grant Once repeatedly.

### Pattern matching: smart defaults, no DSL

- **Bash:** suggested pattern is the first 1–2 whitespace-separated tokens. `npm install react` → `npm install`. `ls` → `ls`. `git status` → `git status`. (Two tokens is the sweet spot — covers `npm install <X>` and `npm test` separately, vs lumping them as `npm`.)
- **Path:** suggested pattern is the parent directory of the requested path, ending with `/`. `/Users/blove/.zshrc` → `/Users/blove/`. `/var/log/app.log` → `/var/log/`.
- **Matching:** candidate is a prefix-match against the stored pattern. A bash candidate matches if its first tokens equal the pattern; a path candidate matches if it starts with the pattern.

Rejected: a glob / regex DSL. Industry standard is prefix-matching with smart defaults; complex pattern editors add surface without proportional value at this stage.

Rejected: an interactive pattern-editor in the prompt UI (Claude Code does this). For Dawn's smoke client (throwaway), the suggested pattern is fixed. Power users can edit `.dawn/permissions.json` directly if they need a narrower or broader pattern.

### Persistence: `.dawn/permissions.json`, project-local, gitignored

```json
{
  "version": 1,
  "allow": {
    "bash": ["npm install", "ls", "git status"],
    "readFile": ["/Users/blove/"],
    "writeFile": ["/tmp/dawn-scratch/"],
    "listDir": ["/Users/blove/Documents/"]
  },
  "deny": {}
}
```

Tool-keyed top-level structure. Arrays of prefix patterns per tool. Forward-compatible (new tool category = new key, zero migration). More concise than Claude Code's `Tool(pattern)` notation; trivially parseable; easy to hand-edit.

The store appends `.dawn/` to the project's `.gitignore` on first write (idempotent). Manual edits to `.dawn/permissions.json` while the dev server is running require a server restart — the store does not live-watch the file.

### Three modes: `interactive` / `non-interactive` / `bypass`

```ts
permissions: {
  mode: "interactive" | "non-interactive" | "bypass"  // default: "interactive"
  allow: { bash: ["npm install"], readFile: ["/Users/blove/"] }
  deny: { bash: ["rm -rf", "sudo"] }
}
```

| Mode | Prompts? | `config.allow` | `config.deny` | `.dawn/permissions.json` | Unknown commands | Path-jail |
|---|---|---|---|---|---|---|
| `interactive` (default) | Yes | Auto-allow | Hard-refuse | Auto-allow | Prompt | Triggers prompt on escape |
| `non-interactive` | No | Auto-allow | Hard-refuse | Ignored | Hard-refuse (fail-closed) | Intact, hard-refuse on escape |
| `bypass` | No | Ignored | Ignored | Ignored | Run unchecked | Disabled |

Production should use `non-interactive` with a curated `config.allow` and `config.deny`. CI should use `non-interactive` as well. Local development uses the default `interactive`. `bypass` is for explicit "operator knows what they're doing" scenarios (screencast, internal admin tools) — using it disables Dawn's safety boundary entirely; the mode name + docs make that obvious.

### Config-seeded baseline + runtime additions

`config.allow` and `config.deny` form the design-time baseline (committed to git, shared across developers). `.dawn/permissions.json` is the per-developer runtime additive (gitignored, accumulated by clicking "Always"). Effective permissions:

```
effective.allow[tool] = (config.allow[tool] ?? []) ∪ (runtime.allow[tool] ?? [])
effective.deny[tool]  = (config.deny[tool]  ?? []) ∪ (runtime.deny[tool]  ?? [])
```

Both files use the same shape — runtime entries can be promoted to config by hand-copying.

### Env-var escape hatch: `DAWN_PERMISSIONS_MODE`

Setting `DAWN_PERMISSIONS_MODE=non-interactive` (or `=bypass`, `=interactive`) overrides `dawn.config.ts`'s `permissions.mode` for the session. Useful for ad-hoc switching without editing config (e.g., `DAWN_PERMISSIONS_MODE=bypass pnpm dev` during a demo).

### SSE envelope shape (forward-compatible with Agent Protocol)

```
event: interrupt
data: {
  "interrupt_id": "perm-1779200000-x7y2z",
  "type": "permission-request",
  "kind": "command" | "path",
  "detail": {
    // for kind=="command":
    "command": "npm install react",
    "suggestedPattern": "npm install"
    // for kind=="path":
    "operation": "readFile" | "writeFile" | "listDir",
    "path": "/Users/blove/.zshrc",
    "suggestedPattern": "/Users/blove/"
  },
  "thread_id": "smoke-coord-1",
  "call_id": "task-abc"  // present when the interrupt fires inside a subagent
}
```

`interrupt_id` correlates prompt-to-resume. `suggestedPattern` is what the capability will persist if the user clicks "Always" — surfaced in the envelope so the client can render transparent button labels (e.g., "Allow always for `npm install`").

### Resume endpoint

```
POST /threads/{thread_id}/resume
content-type: application/json

{
  "interrupt_id": "perm-1779200000-x7y2z",
  "decision": "once" | "always" | "deny"
}
```

Runtime invokes `graph.invoke(Command({resume: decision}), {configurable: {thread_id}})`. The parked graph resumes, the capability acts on the decision, downstream SSE events continue normally.

**Failure modes:**

- Client closes SSE stream before resuming → run stays parked in the LangGraph checkpoint. Next invocation of the thread re-surfaces the interrupt.
- Stale `interrupt_id` → 409 with `{ error: "no pending interrupt with that id" }`.
- Mismatched `thread_id` → 400.

This shape is **Agent-Protocol-compatible** — sub-project 7 will implement the spec on top of this without refactoring 4.5.

### Web client UX (chat demo only)

The chat-web smoke client is throwaway, so the UX bar is just "make the prompt usable." When `event: interrupt` with `type: "permission-request"` arrives:

1. Pause auto-scroll.
2. Render an inline panel above the event log showing the operation + three buttons (Once / Always for `<pattern>` / Deny).
3. On click, POST to `/api/permission-resume` (a new Next.js route proxy) which forwards to Dawn's resume endpoint.
4. Hide the panel; event log resumes streaming.

Multiple pending interrupts (e.g., subagent emits an interrupt while parent is parked): queue one at a time, oldest first. Subagent interrupts include the subagent name in the panel header ("research subagent wants to...").

### Path-jail in bypass mode

`mode: "bypass"` disables the workspace capability's path-jail entirely. `readFile("/etc/passwd")` proceeds, `writeFile("/etc/hosts", ...)` writes. This is intentional — bypass mode means "I trust the agent fully" — but it's also dangerous, so:

- The mode name + docs make the implication explicit
- A console.warn fires on capability load: `[dawn:permissions] mode=bypass — path-jail disabled, all bash unrestricted. Do not use in production.`

## Component Contracts

### `@dawn-ai/permissions` types

```ts
export interface PermissionsFile {
  readonly version: 1
  readonly allow: Readonly<Record<string, readonly string[]>>
  readonly deny: Readonly<Record<string, readonly string[]>>
}

export type PermissionMode = "interactive" | "non-interactive" | "bypass"

export interface PermissionRequest {
  readonly interruptId: string
  readonly kind: "command" | "path"
  readonly detail: CommandDetail | PathDetail
  readonly threadId: string
  readonly callId?: string  // when emitted from inside a subagent
}

export interface CommandDetail {
  readonly command: string
  readonly suggestedPattern: string  // first 1-2 tokens
}

export interface PathDetail {
  readonly path: string
  readonly operation: "readFile" | "writeFile" | "listDir"
  readonly suggestedPattern: string  // parent dir, trailing slash
}

export type PermissionDecision = "once" | "always" | "deny"

export interface PermissionsStore {
  load(): Promise<void>
  match(tool: string, candidate: string): "allow" | "deny" | "unknown"
  addAllow(tool: string, pattern: string): Promise<void>
  mode: PermissionMode
}

export function createPermissionsStore(opts: {
  readonly appRoot: string
  readonly config: PermissionsFile | undefined
  readonly mode: PermissionMode
}): PermissionsStore
```

### `CapabilityMarkerContext` extension

```ts
export interface CapabilityMarkerContext {
  // ... existing fields
  readonly permissions?: PermissionsStore  // present when workspace capability is active
}
```

### `DawnConfig` extension

```ts
export interface DawnConfig {
  readonly appDir?: string
  readonly backends?: { /* unchanged */ }
  readonly permissions?: {
    readonly mode?: PermissionMode
    readonly allow?: Readonly<Record<string, readonly string[]>>
    readonly deny?: Readonly<Record<string, readonly string[]>>
  }
}
```

### Workspace capability changes

For each of the four tools, the `run()` function becomes:

```ts
async (input, ctx) => {
  const { path } = SCHEMA.parse(input)

  // 1. Resolve + jail
  let safe: string
  try {
    safe = pathJail(path, workspaceRoot)
  } catch {
    // Jail escape. In bypass mode, proceed anyway. Otherwise, gate.
    if (permissions.mode === "bypass") {
      safe = resolve(workspaceRoot, path)  // absolute, but outside workspace
    } else {
      const decision = await requestPermission(permissions, "readFile", path, ctx)
      if (decision === "deny") {
        throw new Error(`Permission denied by user: ${path}`)
      }
      safe = resolve(workspaceRoot, path)
    }
  }

  // 2. Backend call
  return fs.readFile(safe, backendContext(workspaceRoot, ctx.signal))
}
```

For `runBash`, the gate fires unconditionally before invoking the backend (every bash command is gated when mode is interactive).

The `requestPermission` helper handles: matching against the store first (allow/deny short-circuits); emitting `interrupt()` on unknown; receiving the resume; calling `addAllow` on "always"; returning the final decision.

### Resume endpoint registration

Dawn's CLI dev server registers `POST /threads/:thread_id/resume` alongside the existing `/runs/stream`. Handler:

```ts
async function handleResume(req): Promise<Response> {
  const { thread_id } = req.params
  const { interrupt_id, decision } = await req.json()
  const result = await runtime.resume({ threadId: thread_id, interruptId: interrupt_id, decision })
  if (result.kind === "stale") return new Response(JSON.stringify({ error: "no pending interrupt" }), { status: 409 })
  if (result.kind === "no-thread") return new Response(null, { status: 400 })
  return new Response(null, { status: 200 })
}
```

The runtime maintains an in-memory `Map<thread_id, { pendingInterruptId, graph }>` for active interrupts so it can validate `interrupt_id` and forward the `Command({resume})` to the right graph.

## File structure

### New package

```
packages/permissions/
├── package.json                       # @dawn-ai/permissions
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── permissions-store.ts
│   ├── pattern-matching.ts
│   └── suggested-pattern.ts
└── test/
    ├── permissions-store.test.ts
    ├── pattern-matching.test.ts
    └── suggested-pattern.test.ts
```

### New + modified in existing packages

```
packages/core/src/capabilities/built-in/workspace.ts       # modified — adds permission check; supports bypass mode
packages/core/src/capabilities/types.ts                    # adds `permissions` field to CapabilityMarkerContext
packages/core/src/types.ts                                 # extends DawnConfig with permissions field
packages/core/test/capabilities/workspace.test.ts          # adds interrupt-flow tests
packages/cli/src/lib/runtime/execute-route.ts              # constructs PermissionsStore + threads into context
packages/cli/src/lib/runtime/resume-endpoint.ts            # new — HTTP handler
packages/cli/src/lib/server/                               # registers the resume route
packages/cli/test/resume-endpoint.test.ts                  # new
packages/langchain/src/agent-adapter.ts                    # propagates interrupt() → `event: interrupt`; handles Command({resume})
examples/chat/server/dawn.config.ts                        # demo: seeded allow + deny
examples/chat/web/app/api/permission-resume/route.ts       # new — proxy
examples/chat/web/app/page.tsx                             # adds inline permission panel
memory/project_phase_status.md                             # mark sub-project 4.5 in progress
```

## Testing strategy

Per Section 7 of the brainstorm — unit tests for pattern matching, suggested-pattern, store; integration test for resume endpoint; extended workspace capability tests for interrupt flow; manual Chrome MCP smoke covering interactive prompts (once / always / deny), config-only mode, bypass mode, subagent-emitted interrupts.

No new LLM-driven CI tests — same policy as existing capabilities.

## Out of scope (deferred)

- **Persistent "deny always" entries** (sub-project 4.6) — schema accommodates a `deny` array but no UI yet for setting one. Today's deny path is per-call.
- **Generalized capability-driven gating** (sub-project 4.6) — any capability or user tool can declare "this operation needs confirmation." Builds on 4.5's interrupt/resume/persistence infrastructure.
- **Interactive pattern editor in the prompt UI** — power users edit `.dawn/permissions.json` directly. Pattern-editing in the web client is throwaway-demo territory.
- **Two-tier config** (project + user-global `~/.dawn/permissions.json`) — single project-local file is sufficient until someone asks for it.
- **Per-route permission overrides** — global per-app for v1.
- **Polished web client** — current chat-web is throwaway. The eventual polished client (separate sub-project) will have a true modal, optimistic UI, etc.

## Known risks

- **`bypass` mode disables the path-jail.** This is the explicit semantic but it's also load-bearing safety. Mitigation: warn loudly on capability load when bypass is active; document the implication in every reference to the mode.
- **Concurrent `addAllow` calls** could race on disk write. Mitigation: single-flight write queue in `PermissionsStore`.
- **The resume endpoint requires a stable `thread_id`.** If the chat-web client generates a new `thread_id` per page load (current behavior), then closing the tab loses the parked run. Mitigation: document the limitation; sub-project 7's Agent Protocol implementation introduces thread persistence properly.
- **Pattern matching false-positives.** Approving `npm install` once allows `npm install --global some-malicious-package`. Mitigation: docs explicitly call this out; users who want strict matching add exact patterns to `dawn.config.ts`'s `allow` (no `:*` semantics yet — every entry is prefix). Future schema extension could add exact-match syntax.
- **Production deployments forgetting to switch from `interactive` to `non-interactive`** would block forever waiting for prompts no one sees. Mitigation: docs strongly recommend `non-interactive` for production; `DAWN_PERMISSIONS_MODE` env var lets infra set it without touching code.
