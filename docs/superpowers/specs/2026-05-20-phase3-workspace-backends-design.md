# Phase 3 — Workspace Capability + Pluggable Backends Design

**Sub-project:** 4 of 7 in the Dawn opinionated agent harness.
**Status:** Spec
**Date:** 2026-05-20

## Goal

Refactor the workspace tools (`readFile`, `writeFile`, `listDir`, `runBash`) from per-route hand-rolled files into a single built-in capability, and introduce a pluggable backend interface so the underlying filesystem and exec implementations can be swapped at the app level. Default behavior is unchanged: existing apps using local-fs + local-exec keep working without touching configuration. Pluggability unlocks in-memory storage for tests, remote sandboxes for production, and middleware composition for cross-cutting concerns like logging.

## Architecture

A new built-in capability marker `createWorkspaceMarker()` joins the existing five (planning, agents-md, skills, subagents, this). It auto-discovers the `workspace/` directory under a route (same convention as AGENTS.md uses) and contributes four tools wired to a configurable filesystem + exec backend pair.

A new pnpm workspace package `@dawn-ai/workspace` ships the backend type interfaces (`FilesystemBackend`, `ExecBackend`, `BackendContext`), the two default implementations (`localFilesystem`, `localExec`), and a small set of functional composition primitives (`compose`, one demonstration middleware `withLogging`). Apps configure backends via `dawn.config.ts`, which switches from the existing hand-rolled string-only parser to a `tsx`-evaluated import so callable values can be expressed naturally.

The capability owns path-jail enforcement. Backends receive already-resolved absolute paths and trust them. Authors can override the entire workspace tool set at the filesystem-convention layer (a user-authored `tools/readFile.ts` replaces the capability's contribution) or replace specific backend methods via plain spread-and-closure JS / middleware composition.

Human-in-the-loop permission gating (interrupt the run to ask the user about paths outside the jail) is deliberately deferred to a future sub-project. The capability hard-refuses jail escapes for now; the future permission system will replace that with an interrupt-and-resume flow without changing the backend contract.

## Design Decisions

### Sub-project boundary

This sub-project ships pluggable backends and the workspace capability only. Concretely:

- Refactor: workspace tools move from per-route user-authored files into a capability that calls into a backend.
- New package: `@dawn-ai/workspace` exports backend types + defaults + composition helpers.
- Config-loader switch: `dawn.config.ts` parsed via `tsx` import instead of the existing restricted parser.

Deferred to sub-project 4.5 (separate brainstorm + spec + plan cycle):

- LangGraph `interrupt()` plumbed through Dawn's SSE stream as `event: interrupt` envelopes.
- HTTP resume endpoint + client-side resume UI.
- Permission persistence model (`.dawn/permissions.json` vs. AGENTS.md vs. thread state — to be decided in 4.5).
- "Always allow this path" / "always deny this command" decision flow.

OS-level isolation (running Dawn under a restricted user, containerization, macOS sandbox profiles) is documented as deployment guidance and never claimed as a security boundary the framework provides.

### Package name: `@dawn-ai/workspace`

Chosen over `backends`, `harness`, `system`, `host`, `io`. The capability is named `workspace`; the trigger is the `workspace/` directory; the tools are workspace tools. The package's purpose is self-evident from its name. Future pluggable-defaults packages get domain-specific names (e.g., `@dawn-ai/tracing` if a tracing capability ever lands), matching the Next.js `next/cache` / `next/server` split rather than the LangChain integration-name convention.

### Path-jail in the capability, not the backend

The workspace capability resolves the user-supplied relative path against the route's `workspace/` directory and validates that the resolution stays inside before calling the backend. Backends receive an already-resolved absolute path they can trust. Backends do not re-validate.

Rejected alternative: defense in depth (backend re-checks the jail). Real defense against hostile agents is OS-level isolation (restricted user, container). The capability check is sufficient for correctness against well-behaved agents and avoids duplicating the resolver in every backend.

When a future HITL permission system lands (sub-project 4.5), the capability's hard-refuse on jail escape becomes a hard-refuse-unless-allowed branch. The backend contract is unchanged by that addition.

### Workspace capability opt-in: convention only

A route opts in by having a `workspace/` subdirectory. No descriptor flag. Same trigger AGENTS.md already uses; the AGENTS.md capability and the workspace capability share the same filesystem signal.

When no `workspace/` exists, the capability contributes nothing — no tools, no prompt fragment, no overhead.

### Default backends when `dawn.config.ts` omits `backends`

When the route has a `workspace/` directory but `dawn.config.ts` declares no `backends` field (or `dawn.config.ts` doesn't exist), the capability defaults to `localFilesystem()` + `localExec()`. This preserves existing chat-example behavior: apps that don't touch their config keep working unchanged.

Explicit config in `dawn.config.ts` always wins:

```ts
// dawn.config.ts
import { localFilesystem, localExec } from "@dawn-ai/workspace"
export default {
  appDir: "src/app",
  backends: {
    filesystem: localFilesystem({ maxFileBytes: 256 * 1024 }),
    exec: localExec({ timeout: 30_000 }),
  },
}
```

### Tool set: fixed four, extensible by convention

The capability contributes exactly four tools: `readFile`, `writeFile`, `listDir`, `runBash`. This matches the deepagents/Claude Code workspace tool set authors already expect.

Authors who want additional tools (e.g., `runPython`, `httpGet`) author them in `tools/` as today — orthogonal to the workspace capability. Authors who want to override one of the standard four write a `tools/readFile.ts` file (etc.) that replaces the capability's contribution. This requires inverting the existing capability-vs-user-tool collision check introduced in PR #155: user tools win.

### Config loader: switch from hand-rolled parser to `tsx` import

The existing `packages/core/src/config.ts` defines a hand-rolled tokenizer + parser that supports only `{ appDir }` and `const FOO = "string"` bindings. It explicitly refuses imports, function values, and nested objects. This was originally a security-conscious choice (don't execute user TS at config-load time).

The choice now blocks `dawn.config.ts` from expressing callable backends. Switch to a `tsx`-evaluated dynamic import using the same loader Dawn already uses for route discovery. Dawn already executes user TS during route discovery, tool execution, and capability application — there is no new attack surface introduced by also executing the config file.

Existing `dawn.config.ts` files in the wild (just `{ appDir }`) remain valid TS modules and continue to work without modification. The new loader is ~30 lines net (the parser deletes; the loader is small).

### Backends are plain objects; composition is functional

Backends are plain objects implementing the typed interfaces. No classes, no inheritance, no DI container.

Three layers of extensibility, each progressively more powerful:

1. **Spread + closure** — vanilla JS for overriding a single method:
   ```ts
   const base = localFilesystem()
   const fs: FilesystemBackend = {
     ...base,
     readFile: async (path, ctx) => {
       if (path.endsWith(".secret")) throw new Error("nope")
       return base.readFile(path, ctx)
     },
   }
   ```
   No new API. Authors who know JS know how to do this.

2. **Middleware composition** — `compose(...)` helper for stacking concerns:
   ```ts
   import { compose, localFilesystem, withLogging } from "@dawn-ai/workspace"
   const fs = compose(withLogging({ destination: "stderr" }))(localFilesystem())
   ```
   A middleware is a function `(next: FilesystemBackend) => FilesystemBackend`. Same pattern as Vercel AI SDK `wrapLanguageModel`, Express middleware, LangChain callback wrapping.

3. **Filesystem-convention tool override** — author a `tools/readFile.ts` to replace the capability's contribution entirely. Useful when the override is so different that wrapping the standard backend would be awkward.

### What ships in `@dawn-ai/workspace` v1

```ts
// type interfaces (workspace-specific — not in @dawn-ai/core to keep core free of node:child_process etc)
export interface FilesystemBackend {
  readFile(path: string, ctx: BackendContext): Promise<string>
  writeFile(path: string, content: string, ctx: BackendContext): Promise<{ bytesWritten: number }>
  listDir(path: string, ctx: BackendContext): Promise<string[]>
}

export interface ExecBackend {
  runCommand(
    args: { command: string; cwd?: string; env?: Record<string, string> },
    ctx: BackendContext,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export interface BackendContext {
  readonly signal: AbortSignal
  readonly workspaceRoot: string
}

// default impls
export function localFilesystem(opts?: { maxFileBytes?: number }): FilesystemBackend
export function localExec(opts?: {
  timeout?: number
  allowedCommands?: readonly RegExp[]
}): ExecBackend

// composition primitives
export type FilesystemMiddleware = (next: FilesystemBackend) => FilesystemBackend
export type ExecMiddleware = (next: ExecBackend) => ExecBackend
export function compose<T>(...middlewares: ReadonlyArray<(next: T) => T>): (base: T) => T

// one demonstration middleware that ships in v1
export function withLogging<T extends FilesystemBackend | ExecBackend>(opts?: {
  destination?: "stderr" | ((entry: { method: string; args: unknown[] }) => void)
}): T extends FilesystemBackend ? FilesystemMiddleware : ExecMiddleware
```

Resist shipping `withMaxFileSize` / `withPathRestriction` as standalone middlewares — those fit better as options on `localFilesystem()` itself. One demonstration middleware (logging) proves the pattern; community middlewares grow organically.

## Component Contracts

### `createWorkspaceMarker`

```ts
// packages/core/src/capabilities/built-in/workspace.ts
export function createWorkspaceMarker(): CapabilityMarker {
  return {
    name: "workspace",
    detect: async (routeDir) => existsSync(join(routeDir, "workspace")),
    load: async (routeDir, context) => {
      const workspaceRoot = join(routeDir, "workspace")
      const fs = context.backends?.filesystem ?? defaultLocalFilesystem()
      const exec = context.backends?.exec ?? defaultLocalExec()
      return { tools: buildWorkspaceTools(workspaceRoot, fs, exec) }
    },
  }
}
```

The four tools share a single path-jail helper:

```ts
function pathJail(userPath: string, workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot, userPath)
  if (!resolved.startsWith(workspaceRoot + sep) && resolved !== workspaceRoot) {
    throw new Error(`Path is outside workspace: ${userPath}`)
  }
  return resolved
}
```

Each tool's `run` resolves the path, calls the backend, returns the result:

```ts
const readFileTool: DawnToolDefinition = {
  name: "readFile",
  description: "Read a UTF-8 file from the workspace.",
  schema: z.object({ path: z.string() }),
  run: async (input, ctx) => {
    const { path } = z.object({ path: z.string() }).parse(input)
    const safe = pathJail(path, workspaceRoot)
    return await fs.readFile(safe, { signal: ctx.signal, workspaceRoot })
  },
}
// writeFile, listDir, runBash same shape
```

### `CapabilityMarkerContext` extension

```ts
// packages/core/src/capabilities/types.ts (modify)
export interface CapabilityMarkerContext {
  readonly routeManifest: RouteManifest
  readonly descriptor: DawnAgent | undefined
  readonly descriptorRouteMap?: ReadonlyMap<DawnAgent, string>
  readonly backends?: {                                       // NEW
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
}
```

The CLI's `execute-route.ts` loads `dawn.config.ts`, extracts `config.backends`, and threads it into the marker context.

### `DawnConfig` extension

```ts
// packages/core/src/types.ts (modify)
export interface DawnConfig {
  readonly appDir?: string
  readonly backends?: {                                       // NEW
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
}
```

Importing `FilesystemBackend` / `ExecBackend` into `@dawn-ai/core` creates a new edge: `core` depends on `@dawn-ai/workspace`'s type exports. This is acceptable because the workspace package's type-only entry has no runtime weight (no `node:child_process` etc.) — only the concrete `localFilesystem` / `localExec` factories pull in those deps. The interfaces live in `@dawn-ai/workspace/src/types.ts` (the package that owns the domain); `@dawn-ai/core` imports them via `import type`.

### Tool-vs-capability collision check inversion

Current behavior (PR #155, `packages/cli/src/lib/runtime/check-tool-name-uniqueness.ts`): a user-authored tool in `tools/` whose name matches a capability-contributed tool is a build error.

New behavior: for **the workspace capability only**, a user-authored tool with a matching name **silently replaces** the capability's contribution. Other capabilities (planning's `writeTodos`, skills' `readSkill`, subagents' `task`) retain the collision error — those aren't meant to be replaceable.

Implementation: the capability declares which of its contributed tools are "overridable." The uniqueness check skips overridable tools when both are present and removes the capability's version, keeping the user's.

## Out of scope (deferred)

- **HITL permission system** — `interrupt()` for jail-escape attempts. Sub-project 4.5.
- **Per-route backend override** — currently global only. Add via descriptor field non-breakingly later if a real use case surfaces.
- **OS-level sandboxing** — operator responsibility; Dawn documents deployment guidance.
- **Backend method extensibility** — adding methods beyond the standard four (e.g., custom `runPython` on a backend) does NOT auto-contribute extra tools. Authors who want additional tools write them in `tools/` as today.
- **Non-workspace backends** (tracing, secret resolution, etc.) — separate packages, separate sub-projects.

## File Structure

### New package

```
packages/workspace/
├── package.json                          # @dawn-ai/workspace
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                          # re-exports
│   ├── types.ts                          # FilesystemBackend, ExecBackend, BackendContext, middleware types
│   ├── local-filesystem.ts               # localFilesystem() factory
│   ├── local-exec.ts                     # localExec() factory
│   ├── compose.ts                        # compose() helper
│   └── with-logging.ts                   # withLogging() middleware
└── test/
    ├── local-filesystem.test.ts
    ├── local-exec.test.ts
    ├── compose.test.ts
    └── with-logging.test.ts
```

### New files in existing packages

```
packages/core/src/capabilities/built-in/workspace.ts          # createWorkspaceMarker
packages/core/test/capabilities/workspace.test.ts             # marker unit tests
```

### Modified files

```
packages/core/src/config.ts                                   # rewrite loader to use tsx import
packages/core/test/config.test.ts                             # rewrite tests for new loader
packages/core/src/types.ts                                    # extend DawnConfig with backends?
packages/core/src/capabilities/types.ts                       # extend CapabilityMarkerContext with backends?
packages/core/src/index.ts                                    # export createWorkspaceMarker
packages/cli/src/lib/runtime/execute-route.ts                 # register createWorkspaceMarker, thread backends from config
packages/cli/src/lib/runtime/check-tool-name-uniqueness.ts    # support overridable tool names
packages/cli/src/lib/typegen/run-typegen.ts                   # extra-tool entries for readFile/writeFile/listDir/runBash gated on hasWorkspace
memory/project_phase_status.md                                # mark sub-project 4 in progress
```

### Deleted files (chat example)

```
examples/chat/server/src/app/chat/tools/readFile.ts
examples/chat/server/src/app/chat/tools/writeFile.ts
examples/chat/server/src/app/chat/tools/listDir.ts
examples/chat/server/src/app/chat/tools/runBash.ts
examples/chat/server/src/app/chat/workspace-path.ts             # if no longer referenced
examples/chat/server/src/app/coordinator/subagents/research/tools/readFile.ts
examples/chat/server/src/app/coordinator/subagents/research/tools/listDir.ts
examples/chat/server/src/app/coordinator/subagents/research/workspace-path.ts  # if no longer referenced
```

### Notable: pnpm workspace config

```
pnpm-workspace.yaml                                           # add "packages/workspace"
turbo.json                                                    # verify pipeline picks up the new package
```

## Testing strategy

### Unit (no LLM)

- `local-filesystem.test.ts` — backend impl reads/writes/lists against a `mkdtempSync` directory; respects `maxFileBytes`; rejects nothing (capability's job).
- `local-exec.test.ts` — `runCommand` executes `echo` and `ls`, captures stdout/stderr/exit; respects `timeout`; respects `allowedCommands` regex allowlist when configured.
- `compose.test.ts` — composes 0, 1, 2 middlewares correctly. Each middleware sees the next one in line.
- `with-logging.test.ts` — captures each method invocation with args; supports stderr and custom destination.
- `workspace.test.ts` (capability) — contributes 4 tools when `workspace/` exists; contributes nothing when absent; tool `run`s call the right backend method with the right args; path-jail rejects `../` escapes with the documented error; reads the default `localFilesystem` + `localExec` when no `backends` in context; uses configured backends when provided.
- `config.test.ts` rewrite — import-evaluated loader handles `{ appDir }`, `{ backends: { filesystem, exec } }`, omitted file (returns empty config), syntax errors surface as TS errors not custom messages.
- `check-tool-name-uniqueness.test.ts` extension — overridable workspace tool names are NOT collision errors when a user tool shadows them.

### Integration / chat example

- The chat example's hand-rolled `tools/` files delete. After the migration, `pnpm dev` and a Chrome MCP smoke against both `/chat` and `/coordinator` must produce identical behavior to current main:
  - `/chat`: planning + skills + AGENTS.md + workspace tools all work. Same SSE event shape.
  - `/coordinator`: research subagent's `listDir` + `readFile` work via the capability. Subagent envelopes still fire correctly.

No new LLM-driven CI tests; manual smoke is the same policy as existing capabilities.

### Override pathway

- A test fixture under `packages/cli/test/fixtures/workspace-tool-override/` defines a custom `tools/readFile.ts` alongside a `workspace/` directory. Verify the build picks the user tool and drops the capability's contribution.

## Known Risks

- **Config-loader switch is observable.** Apps with intentionally-restricted `dawn.config.ts` syntax assumptions will discover they can now write arbitrary TS. Mitigation: this is mostly upside; the restriction was already pierceable by any other route file in the app. Document the change in the PR description and CHANGELOG.
- **Tool-override inversion is a behavior change.** Currently a user `tools/readFile.ts` next to a workspace capability would be a build error. After this PR, the user tool silently wins. Mitigation: capability marks specific tools as overridable; the error stays for non-overridable capability tools (planning, skills, subagents).
- **The path-jail still surfaces as an error to the agent** when it tries paths outside the workspace. With no HITL permission system, the agent has to learn from the error message and adjust. Mitigation: the error message is informative ("Path is outside workspace: ../etc/passwd"). When 4.5 lands, this becomes an interactive flow.
- **`@dawn-ai/core` gaining a type-only edge to `@dawn-ai/workspace`** introduces a package-graph consideration. Mitigation: workspace's types are zero-runtime (no `node:` imports in `types.ts`); only the concrete factory functions pull in platform deps.
- **gpt-5 has learned the standard tool shapes by name.** Renaming `runBash` to `runCommand` would normalize but cost familiarity. Keep `runBash` to preserve trained behavior; revisit if a behavior delta shows up in smoke.

## What we're explicitly NOT changing

- `agent({ description, subagents, ... })` descriptor stays the same.
- Capability marker contract (`detect`, `load`) stays the same except for the new `backends?` field on `CapabilityMarkerContext`.
- SSE event shape stays the same; no new event types.
- Subagents work continues to work (the `coordinator/subagents/research` route's tools are deleted because they're now provided by the workspace capability — that's the only subagents-related change).
