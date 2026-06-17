# Unit-test harnesses for tools, middleware, and the workspace (Design)

**Status:** Approved for planning
**Date:** 2026-06-16
**Roadmap:** Dogfooding-friction backlog item #6 (tool/middleware unit-testing ergonomics). Audited 2026-06-16: `@dawn-ai/testing` today is entirely full-agent/scenario oriented (`createAgentHarness`, aimock, fixtures, Agent-Protocol HTTP injection, scenario matchers) with **no** way to unit-test a single route tool or a `FilesystemMiddleware` in isolation, and zero `WorkspaceFs`/`ctx.fs` awareness. The `ctx.fs` work (PR #213) made this worse: a tool that calls `ctx.fs.*` can't be unit-tested without hand-assembling a `DawnToolContext` with a real `WorkspaceFs`.

## Problem

To unit-test a `ctx.fs`-using tool today, an author must hand-build the context — ~15 lines reaching into two packages, knowing `createWorkspaceFs`'s exact option shape, and realpath'ing the temp root (or the symlink-hardened gate misclassifies it on macOS `/var`):

```ts
const workspaceRoot = realpathSync(mkdirSync(join(mkdtempSync(...), "workspace"), ...))
const fs = createWorkspaceFs({ workspaceRoot, backend: localFilesystem(), permissions: undefined, signal, interruptCapable: false })
const result = await myTool({ ... }, { signal, fs })
// ...assert via node:fs against workspaceRoot, then rmSync
```

This is the exact friction #6 names — the original consumer "factored logic into plain exported functions" to dodge it, losing coverage of the real tool contract and its fs integration. `FilesystemMiddleware` has the same setup cost plus a sharper edge: a middleware must re-forward *all* backend methods (the PR #207 footgun — dropping optional methods silently disabled offload GC; `realPath` is now required too), and nothing helps verify that.

## Decisions (from brainstorming)

- **Ship all three helpers**, sharing one workspace fixture underneath: `createWorkspaceHarness`, `createToolHarness`, `createMiddlewareHarness`.
- **Naming + lifecycle match the existing `createAgentHarness` convention**: async `create*Harness(opts): Promise<Handle>` factories, teardown via `.close()`. Additionally implement `[Symbol.asyncDispose]` (delegating to `close()`) so `await using` works — without breaking the documented `afterEach(() => h.close())` norm.
- **`createToolHarness` exposes a reusable `invoke()`** (not a one-shot) so a test can call the tool repeatedly against one shared workspace and assert cumulative state — matching the stateful-harness model.
- **Permissions default permissive** (`permissions: undefined` → `createWorkspaceFs` allows all), with an opt-in to inject a real store/mode for tests that exercise allow/deny/fail-closed gating.
- **Test against the real `WorkspaceFs`/backend, not a fake** — real gating, realpath, parent-dir creation, and byte caps, exactly as in production. The value is fidelity.
- **No back-compat constraint** (pre-1.0, fixed versioning) — drive for the cleanest surface.
- **Deferred to a subsequent DX-audit phase** (recorded as a follow-up, NOT this PR): unify teardown/`[Symbol.asyncDispose]` across `createAgentHarness`/`startAimock`/`startSubprocessApp`, and review naming coherence (`start*` vs `create*`, `.stop()` vs `.close()`, `injectAgentProtocol`).

## Verified facts (against main @ `8a2ab0b`)

- `@dawn-ai/testing` exports only full-agent helpers (`index.ts`): `createAgentHarness` (→ handle with `close(): Promise<void>`), `startAimock`/`startSubprocessApp` (→ `.stop()`), `injectAgentProtocol`, `script`/`record`/`loadFixtures`/`writeFixtures`, `expect*` matchers. Teardown is manual (`afterAll(() => h.close())`). No `using`/`Symbol.asyncDispose` anywhere.
- `@dawn-ai/testing` `package.json`: deps `@copilotkit/aimock`, `light-my-request`; **peerDependencies `@dawn-ai/cli`, `@dawn-ai/core`** (so it can already import `createWorkspaceFs`). `@dawn-ai/workspace` is NOT yet a dep — must be added (for `localFilesystem`).
- `@dawn-ai/core` exports `createWorkspaceFs` (`index.ts:26`). Its options: `{ workspaceRoot: string; backend: FilesystemBackend; permissions: PermissionsStore | undefined; signal: AbortSignal; interruptCapable: boolean }` (`workspace-fs.ts`).
- `@dawn-ai/sdk` exports `WorkspaceFs` and `DawnToolContext` (`{ signal; middleware?; fs }`).
- `@dawn-ai/workspace` exports `localFilesystem`, `compose`, and the `FilesystemBackend` / `FilesystemMiddleware` / `BackendContext` types; `FilesystemBackend` requires `readFile`/`readBinaryFile?`... and (post-PR #225) a required `realPath`.
- testing.mdx documents only scenario testing; "Mocking tools" is explicitly a tracked follow-up (a *different* concern — mocking tools the LLM calls, vs unit-testing your own tool).

## Design

All three live in `@dawn-ai/testing`, each in its own `src/*.ts`, exported from `index.ts`.

### 1. `createWorkspaceHarness(opts?)` — shared fixture (`src/workspace-harness.ts`)

```ts
export interface WorkspaceHarness {
  /** Real WorkspaceFs (via @dawn-ai/core createWorkspaceFs) over a temp dir. */
  readonly fs: WorkspaceFs
  /** The realpath'd temp workspace root. */
  readonly dir: string
  /** Read a workspace-relative file (assert side effects). */
  read(path: string): Promise<string>
  /** Seed a workspace-relative file (inputs). Creates parent dirs. */
  write(path: string, content: string): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface WorkspaceHarnessOptions {
  /** Inject a permissions store to exercise gating. Default: undefined (permissive). */
  readonly permissions?: PermissionsStore
}

export function createWorkspaceHarness(opts?: WorkspaceHarnessOptions): Promise<WorkspaceHarness>
```

Implementation: `mkdtemp` a temp dir, create `<temp>/workspace`, `realpathSync` it (symlink-hardening: the gate canonicalizes the root, so the harness root must be canonical or inside-paths misclassify), build `fs` via `createWorkspaceFs({ workspaceRoot, backend: localFilesystem(), permissions: opts?.permissions, signal: <harness AbortController>.signal, interruptCapable: false })`. `read`/`write` resolve against `dir` via `node:fs/promises` (write creates parents). `close()` aborts the signal and `rm`'s the temp dir (idempotent); `[Symbol.asyncDispose]` calls `close()`.

### 2. `createToolHarness(tool, opts?)` (`src/tool-harness.ts`)

```ts
export interface ToolHarness<I, O> {
  /** Invoke the tool with a fresh DawnToolContext; reusable across calls (shared workspace). */
  invoke(input: I): Promise<O>
  readonly workspace: WorkspaceHarness
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface ToolHarnessOptions {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly workspace?: WorkspaceHarness   // share an existing one; else a fresh harness is created+owned
  readonly permissions?: PermissionsStore // ignored if `workspace` is provided
}

export function createToolHarness<I, O>(
  tool: (input: I, ctx: DawnToolContext) => Promise<O> | O,
  opts?: ToolHarnessOptions,
): Promise<ToolHarness<I, O>>
```

`invoke(input)` calls `tool(input, { signal, ...(middleware ? { middleware } : {}), fs: workspace.fs })`. If `opts.workspace` is passed, the harness uses it and does NOT close it (caller owns it); otherwise it creates one and `close()` tears it down. A fresh `signal` per `invoke` (or one harness-level signal — implementer's call; harness-level is simpler and matches a single test's lifetime).

### 3. `createMiddlewareHarness(middleware, opts?)` (`src/middleware-harness.ts`)

```ts
export interface MiddlewareHarness {
  /** The middleware composed over a temp-backed localFilesystem. */
  readonly backend: FilesystemBackend
  /** BackendContext for backend calls: { signal, workspaceRoot: dir }. */
  readonly ctx: BackendContext
  readonly dir: string
  /** Throws if the composed backend dropped any method the base backend provides
      (the #207 footgun: middlewares must forward required + optional methods,
      incl. the now-required realPath). */
  assertForwardsAll(): void
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export function createMiddlewareHarness(
  middleware: FilesystemMiddleware,
  opts?: { readonly permissions?: PermissionsStore },
): Promise<MiddlewareHarness>
```

Implementation: temp dir, `base = localFilesystem()`, `backend = middleware(base)`, `ctx = { signal, workspaceRoot: dir }`. `assertForwardsAll()` checks every method present on `base` is present (a function) on `backend` — catching a middleware that returns a partial object. (`permissions` is reserved for parity/future; the middleware operates on the raw backend, not the gate.)

### Cross-cutting

- `@dawn-ai/testing/package.json`: add `@dawn-ai/workspace` to `peerDependencies` (and devDependencies for the package's own build/tests). `@dawn-ai/sdk` may be needed for the `WorkspaceFs`/`DawnToolContext` types — add as a (type) peer/dev dep if not already resolvable transitively.
- Export all three (+ their option/handle types) from `src/index.ts`.

## Testing (the package's own suite, `packages/testing/test/`)

- `workspace-harness.test.ts`: `write` then `fs.readFile` round-trips; `fs.writeFile` then `read` sees it; `dir` is realpath'd; `close()` removes the temp dir and is idempotent; `await using` auto-disposes (a scoped block leaves no temp dir); permissive default allows an outside-workspace read, and an injected non-interactive store makes it fail closed.
- `tool-harness.test.ts`: a fixture tool that does `ctx.fs.writeFile` + `listDir` returns the expected result AND the file exists via `workspace.read`; `invoke()` twice accumulates state; a passed-in `workspace` is shared and NOT closed by the tool harness's `close()`; the `middleware` bag reaches `ctx.middleware`.
- `middleware-harness.test.ts`: a logging middleware records calls and still serves reads/writes through the temp backend; `assertForwardsAll()` passes for `withFilesystemLogging` and **throws** for a deliberately-incomplete middleware that omits `realPath`.

## Docs

Add a **"Unit-testing tools and middleware"** section to `apps/web/content/docs/testing.mdx`: the three harnesses, the `await using` vs `afterEach(close)` patterns, and a `ctx.fs` tool example. Note it complements (doesn't replace) the scenario harness.

## Changeset

`@dawn-ai/testing` minor (new harnesses + the `@dawn-ai/workspace` peer dep). Fixed versioning bumps all `@dawn-ai/*` together.

## Out of scope / follow-ups

- **DX-audit phase**: unify teardown + `[Symbol.asyncDispose]` across `createAgentHarness`/`startAimock`/`startSubprocessApp`; review `start*` vs `create*` and `.stop()` vs `.close()` naming coherence.
- A one-shot `invokeTool(fn, input)` convenience wrapper over `createToolHarness` — only if demand appears.
- Per-scenario tool *mocking* (the existing testing.mdx follow-up) — unrelated to this item.
