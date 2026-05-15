# Canonical Chat Example — Design

**Date:** 2026-05-15
**Status:** Draft — pending user approval
**Owner:** Brian Love

## Summary

Ship `examples/chat/` as Dawn's canonical end-to-end demo: a Dawn-route server with the four foundational agent-harness tools (filesystem read/write/list + bash), plus a deliberately disposable Next.js smoke-test client that proves streaming end-to-end. The example uses only Dawn primitives that exist today; the gaps it surfaces become the explicit forcing function for the phase-3 opinionated harness work.

## Motivation

Dawn has shipped the SDK, route discovery, typegen, dev server, and the landing site. There is no canonical example a new user can clone, run, and understand the framework from. Existing scaffolding (`packages/devkit/templates/app-basic`) is a single hello-world route — useful for `create-dawn-app` but not for showing what Dawn *does for a real agent*.

A canonical chat example serves three audiences:

1. **New users** — copy-pasteable starting point that runs in <2 minutes.
2. **Evaluators** — concrete artifact to compare against `createDeepAgent` or a raw LangGraph project.
3. **Dawn itself** — the deferred items in v1 map 1:1 to the primitives Dawn needs to grow for phase-3 (opinionated harness). Building v1 forces those gaps into the open.

This spec is for v1 only. v2 (full harness) is a separate, later effort.

## Non-goals

- Production-grade sandboxing. `run-bash` is path-jailed + timed, not isolated.
- Multi-user, auth, persistence beyond `workspace/`.
- A polished UI. The web client is a smoke test and will be replaced.
- Subagents, planning state, auto-summarization, skills, AGENTS.md auto-injection — explicitly deferred, see "Deferred (phase-3 preview)".
- Web search, MCP integration, code interpreter, sandbox backends — out of scope.

## Architecture

Two-package workspace under `examples/chat/`:

```
examples/chat/
├── README.md                       # Quickstart + caveats + deferred list
├── package.json                    # @dawn-example/chat — orchestrator scripts only
├── server/                         # @dawn-example/chat-server
│   ├── dawn.config.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example                # OPENAI_API_KEY
│   └── src/
│       └── app/
│           └── chat/
│               ├── index.ts        # export default agent({ model, systemPrompt })
│               ├── state.ts        # export default z.object({})
│               ├── system-prompt.ts
│               ├── workspace-path.ts   # shared path-jail helper
│               └── tools/
│                   ├── read-file.ts
│                   ├── write-file.ts
│                   ├── list-dir.ts
│                   └── run-bash.ts
└── web/                            # @dawn-example/chat-web
    ├── package.json
    ├── tsconfig.json
    ├── next.config.mjs
    ├── .env.example                # DAWN_SERVER_URL=http://127.0.0.1:3001
    └── app/
        ├── layout.tsx
        ├── page.tsx                # textarea + Send + raw SSE event log
        └── api/chat/route.ts       # SSE proxy to Dawn /runs/stream
```

`workspace/` is gitignored at the example root (except for a seed `AGENTS.md`); it is created lazily by the first filesystem-tool invocation if missing.

### Workspace integration

- `pnpm-workspace.yaml` adds the glob `examples/*/*` so both packages are picked up automatically.
- Both packages are `"private": true`. Both consume Dawn via `workspace:*`: `@dawn-ai/sdk`, `@dawn-ai/cli`, `@dawn-ai/core`, `@dawn-ai/langchain`, `@dawn-ai/config-typescript`, `@dawn-ai/config-biome`.
- Naming convention: `@dawn-example/<example>` and `@dawn-example/<example>-<role>`. Sets the pattern for future `examples/rag/`, `examples/tools/`, etc.
- Turbo `build` and `typecheck` pipelines include them as workspace members.
- Excluded from the `test` pipeline. v1 ships no unit tests on the example — it is documentation, not infrastructure.
- A new CI step `examples-typecheck` runs `pnpm --filter "./examples/**" typecheck` to catch breakage when SDK/core APIs change.

## Server design

### Route

A single route at `src/app/chat/index.ts`:

```ts
import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: HARNESS_SYSTEM_PROMPT,  // imported from ./system-prompt.ts
})
```

The system prompt instructs the agent that it operates in a `workspace/` directory, has four tools, and should read `AGENTS.md` at the start of each task and update it when finishing meaningful work.

### State

```ts
// src/app/chat/state.ts
import { z } from "zod"
export default z.object({})
```

No custom state in v1. Dawn merges this with `MessagesAnnotation` automatically. The persistent "state" of the agent is the `workspace/` directory itself — which is the whole point of the harness anatomy article's "filesystem as core primitive" claim.

### Tools

All four tools are default-exported async functions in `src/app/chat/tools/`. Schemas are derived from TypeScript input types by Dawn's typegen. JSDoc on the default export becomes the tool description.

Every tool resolves user-supplied paths through a shared helper at `src/app/chat/workspace-path.ts` that:

- Rejects absolute paths.
- Rejects paths containing `..` segments after normalization.
- Rejects paths that, after resolution, escape `<example>/workspace/`.
- Rejects symlinks whose target is outside `workspace/`.
- Creates `workspace/` if it does not exist.

**`read-file.ts`** — `(input: { readonly path: string }) => Promise<string>`. Returns file contents as UTF-8. Errors if path is outside workspace, missing, or larger than 256 KiB (configurable via env, prevents accidentally piping a binary into context).

**`write-file.ts`** — `(input: { readonly path: string; readonly content: string }) => Promise<string>`. Writes (overwrites) the file. Creates parent directories as needed. Returns a one-line summary: `"wrote 312 bytes to plan.md"`.

**`list-dir.ts`** — `(input: { readonly path: string }) => Promise<string[]>`. Returns entries (files and subdirs). Directories suffixed with `/`. Sorted alphabetically. Dotfiles included.

**`run-bash.ts`** — `(input: { readonly command: string; readonly timeoutSeconds: number }) => Promise<string>`. Spawns `bash -c <command>` with `cwd: workspace/`, hard timeout (default 30s, cap 120s), stdout+stderr captured and returned as a single string with an `[exit N]` footer. No interactive TTY, no streaming output to client.

Tool input shapes all satisfy the current Dawn typegen constraint: readonly objects with primitive fields only.

### Middleware

No middleware in v1. App-level middleware (`src/middleware.ts`) is not required and would muddy the demo.

### AGENTS.md memory convention

v1 surfaces this purely via the system prompt:

> Your workspace is the `workspace/` directory. Always begin a new task by running `list-dir({ path: "." })` and, if `AGENTS.md` exists, `read-file({ path: "AGENTS.md" })`. When you complete meaningful work, update `AGENTS.md` with notes future-you should remember.

A seed `workspace/AGENTS.md` is committed with a short paragraph showing the convention. The directory is otherwise gitignored.

Auto-injection of `AGENTS.md` into the system prompt at agent-start (the deepagents-style `createMemoryMiddleware` pattern) is **deferred** — pending the phase-3 "build-time agent middleware" primitive.

### Model

`gpt-5-mini` (bare string; Dawn's `KnownModelId` accepts any string fallback). README documents how to swap by editing the route file and `OPENAI_API_KEY` requirement.

## Web client design

Disposable smoke-test. Single page, no styling beyond browser defaults, no thread list, no tool-call cards, no workspace inspector. The README opens with: "This client exists to prove the server pipe end-to-end. Expect it to be replaced once the harness primitives stabilize."

### Layout

- `app/layout.tsx` — minimal HTML/body shell.
- `app/page.tsx` — client component. State: `threadId` (generated on first send, then reused), `input` (textarea), `events` (string[]). Renders a `<textarea>`, a "Send" button, and a `<pre>` log appending one line per streamed SSE event (`role: token`, `tool_call: name(args)`, `tool_result: …`, `done`).
- `app/api/chat/route.ts` — server-side handler. Reads `DAWN_SERVER_URL` from env, opens `POST /runs/stream` against the Dawn dev server with the conversation payload, pipes the SSE response straight through to the browser. ~30 lines.

The browser never talks to the Dawn server directly. The proxy exists so the example demonstrates the realistic deployment shape (browser → web → backend) and so the server URL stays server-side.

### Out of scope for v1

Workspace file viewer, tool-call inspector, thread persistence beyond a single in-memory `threadId`, tailwind, dark mode, mobile layout. Will be re-thought once the harness primitives land and the UI has something more interesting to render than raw events.

## Dev workflow

### Port pinning

Dawn's dev server auto-allocates a port. For v1 the server `dev` script runs `dawn dev --port 3001`. The web client hardcodes `DAWN_SERVER_URL=http://127.0.0.1:3001` in `.env.example`. Discovery via `.dawn/dev-port` is deferred — simple and predictable beats robust for a smoke test.

### Scripts

**Top-level `examples/chat/package.json`:**
- `dev` — runs server and web in parallel via `pnpm -r --parallel`.
- `dev:server`, `dev:web` — individual.
- `build`, `typecheck` — recursive across both packages.

**`server/package.json`:** `dev` → `dawn dev --port 3001`; `build` → `dawn build`; `typecheck` → `tsc -p . --noEmit`.

**`web/package.json`:** `dev` → `next dev -p 3000`; `build` → `next build`; `typecheck` → `tsc -p . --noEmit`.

### Environment

- `server/.env.example`: `OPENAI_API_KEY=`.
- `web/.env.example`: `DAWN_SERVER_URL=http://127.0.0.1:3001`.
- `.env` files in both subpackages are gitignored. `.env.example` is committed.

### Quickstart (target experience)

```
git clone …
cd dawn/examples/chat
cp server/.env.example server/.env   # add OPENAI_API_KEY
cp web/.env.example web/.env.local
pnpm install
pnpm dev
# open http://localhost:3000
```

## Security caveats (must be in README)

- `run-bash` executes shell commands on your machine with `cwd: workspace/` and a timeout. **This is not a sandbox.** Network calls, package installs, file ops outside `workspace/` via shell expansion — all possible.
- Do not point untrusted prompts at this example.
- v2 will swap path-jail + spawn for a real backend (sandbox runtime — Modal/Daytona/Deno/equivalent).

## Deferred (phase-3 preview)

These v1 deferrals are the explicit forcing function for Dawn's opinionated harness work. Each one maps to a Dawn primitive that needs to grow. See `memory/project_dawn_harness_strategy.md`.

| Deferred | Why deferred | Maps to Dawn gap |
|---|---|---|
| Subagent delegation (`task`-style tool) | No subagent primitive in Dawn yet | First-class subagent declarations on routes |
| Planning state (`write_todos`) | No build-time agent-middleware tier; would need a `todos` channel + prompt injection | Build-time agent middleware + state channel composition |
| AGENTS.md auto-injection at agent-start | Same — needs build-time middleware to read file and mutate system prompt | Build-time agent middleware |
| Skills (`skills/` dir + SKILL.md loader) | No convention | Mirror of `tools/` directory model |
| Real sandbox isolation for `run-bash` | Out of scope for a TS-only example | Pluggable execution backends declared in `dawn.config.ts` |
| Tool-output offloading | Would auto-write large outputs to workspace and replace with pointer | Lifecycle hook at message-rendering / state-reducer layer |
| Context summarization | Auto-summarize old messages | Same lifecycle hook tier |
| Nested-object tool inputs (e.g., `edit_file({ edits: [{old, new}] })`) | Typegen caps at primitive fields | Typegen extension |
| Polished web UI (workspace inspector, tool-call cards, thread list) | Premature — wait for harness primitives to stabilize | UI design follows the runtime, not the other way around |

## Implementation order (informational; full plan is a separate doc)

1. Workspace plumbing: `pnpm-workspace.yaml` glob, top-level `examples/chat/package.json`, CI step.
2. Server package skeleton: `dawn.config.ts`, `package.json`, `tsconfig.json`, empty route.
3. Path-jail helper + the four tools, in order of independence: `list-dir`, `read-file`, `write-file`, `run-bash`.
4. Route + system prompt + seed `workspace/AGENTS.md`. Verify `dawn dev` boots and `/runs/stream` returns SSE.
5. Web package skeleton: minimal Next.js app.
6. `api/chat/route.ts` SSE proxy; verify with `curl` against the API route.
7. `app/page.tsx`: textarea + Send + event log. Verify end-to-end in a browser.
8. README at both levels (example root + web disposability note).
9. CI: add `examples-typecheck` job.

## Open questions

- **Tool input format for `run-bash` timeout** — should `timeoutSeconds` be required or optional? Dawn's typegen supports optional via `?`, but the LLM is more reliable when fields are required. Lean toward required, default 30 in the prompt guidance. Confirm during implementation.
- **Seed `workspace/AGENTS.md` content** — TBD prose; should demonstrate the convention without being preachy. Likely 3–4 sentences.
- **Whether to add a top-level `examples/README.md`** introducing the directory as a pattern. Probably yes, but a one-paragraph stub for v1.

## Success criteria

- A fresh clone, after the documented quickstart, produces a working chat in <2 minutes (gated on `pnpm install` and the user pasting an `OPENAI_API_KEY`).
- The agent can: list its workspace, read and write a file, run a shell command, and update `AGENTS.md` — all visible in the smoke-test event log.
- `pnpm --filter "./examples/**" typecheck` passes in CI.
- The deferred list in the README accurately previews the phase-3 primitives Dawn will need to add. (Verified by cross-reading with `memory/project_dawn_harness_strategy.md`.)
