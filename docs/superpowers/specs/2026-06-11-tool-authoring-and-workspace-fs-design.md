# Tool authoring diagnostics + sandboxed `ctx.fs` (Design)

**Status:** Approved for planning
**Date:** 2026-06-11
**Roadmap:** Dogfooding-friction backlog items #1 (tool authoring convention) and #3 (sandboxed filesystem handle for route tools), designed together because they share the same surface: what a Dawn route tool is and what its `context` argument carries. Builds on the binary-read primitive shipped in [PR #207](https://github.com/cacheplane/dawnai/pull/207) (spec: `2026-06-09-workspace-binary-read-design.md`, whose appendix sketched this design). One spec, **two implementation PRs** (Part A: cli + docs; Part B: core + sdk + cli).

## Problem

Two related frictions surfaced building Dawn's first external consumer:

1. **The tool authoring convention trips up every newcomer.** The natural ecosystem instinct — wrap in `@langchain/core`'s `tool()` and default-export the `StructuredTool` — fails with the generic `"Tool file <path> must default export a function"` (`packages/cli/src/lib/runtime/tool-discovery.ts`). The error names neither what the user exported nor the fix, and links no docs. Separately, the JSDoc-description convention (`/** description */` above the default export, extracted by typegen) is documented nowhere — `apps/web/content/docs/tools.mdx` covers the signature and type-inference rules but never mentions descriptions.

2. **Route tools have no sandboxed filesystem access.** A tool's `run(input, context)` receives only `{ middleware?, signal }` (`packages/cli/src/lib/runtime/dawn-context.ts`). Any file work — text or binary — drops to `node:fs`, bypassing the workspace path-jail and permission gate entirely. PR #207 gave the *backend* a binary read; nothing yet hands tool authors a safe way to call it.

## Decisions (from brainstorming)

- **Dawn stays opinionated: no native LangChain `tool()` acceptance, and no `fromLangChainTool()` escape hatch.** The plain-function convention powers static type inference (Dawn's headline feature: tool I/O types extracted from the function signature via the TS compiler API → `ctx.tools` IntelliSense + `tools.json`). A `StructuredTool` carries only a runtime Zod schema, which would force a second, degraded path through typegen and blur the framework's opinion. The ecosystem/migration benefit is adequately served by a 3-line wrapper, which the diagnostic and docs will teach. An adapter helper can ship later in a minor if real demand appears.
- **`ctx.fs` uses the exact same permission gate as the agent-facing workspace tools.** Inside `workspace/`: silent allow. Outside: consult the permissions store; interactive mode can emit the LangGraph permission interrupt (same prompt UX); non-interactive fails closed; `bypass` allows all. One permission model regardless of whether the LLM or tool code initiates the I/O.
- **Surface: `readFile`, `readBinaryFile`, `writeFile`, `listDir`** — the operations the gate already has vocabulary for, plus the binary primitive. No `statFile`/`removeFile`/`touchFile`/`mkdir` (removal from tool code wants its own permission story), no `writeBinaryFile` (YAGNI).
- **Reach: tool context AND workflow/graph `RuntimeContext`.** Anywhere Dawn hands authors a `ctx`, `ctx.fs` is present — one rule, no second context shape to learn.
- **Always present, honest errors.** `ctx.fs` is non-optional in the types. If `workspace/` doesn't exist, operations surface natural ENOENT (no auto-create magic, matching `localFilesystem` semantics — except `writeFile`, which creates missing parent directories per [PR #208](https://github.com/cacheplane/dawnai/pull/208)). `readBinaryFile` on a backend lacking the optional method throws an error naming the fix.
- **Name: `ctx.fs`** (not `ctx.workspace`).

## Verified facts (against main @ `fa8bdd4`)

- Tool discovery accepts a default-exported function or an object with a `.run` function; optional `export const description` / `export const schema`; generic failure at `tool-discovery.ts` line ~158. (`packages/cli/src/lib/runtime/tool-discovery.ts`)
- Tool context today is `{ middleware?, signal }`, built in `createDawnContext`. (`packages/cli/src/lib/runtime/dawn-context.ts`)
- `DawnToolDefinition.run`'s context type in core duplicates the same shape. (`packages/core/src/capabilities/types.ts`)
- The path-jail + permission gate (`gatePathOp`, `emitPermissionInterrupt`) live inside the built-in workspace capability alongside the agent-facing tools. (`packages/core/src/capabilities/built-in/workspace.ts`)
- `FilesystemBackend.readBinaryFile?` exists as of PR #207; `localFilesystem` implements it; `localFilesystem.writeFile` creates missing parent dirs as of PR #208. (`packages/workspace/src/`)
- The docs site is `https://dawnai.org`; tools doc at `/docs/tools`. tools.mdx documents the `(input, ctx)` signature and type-inference rules but not JSDoc descriptions and no LangChain-wrapper pattern. (`apps/web/content/docs/tools.mdx`)
- No docs-site page documents the pluggable `@dawn-ai/workspace` backend API (`FilesystemBackend` / `localFilesystem` / `compose` / middleware).

---

## Part A — authoring diagnostics + docs (PR 1: `@dawn-ai/cli` + docs)

### A1. Targeted StructuredTool diagnostic

In `loadToolDefinition`, after the existing function / `{ run }` checks fail, detect a LangChain-tool-shaped export **structurally** (no `@langchain/core` import):

```ts
function looksLikeLangChainTool(value: unknown): value is { readonly name: string } {
  return (
    isRecord(value) &&
    typeof value.invoke === "function" &&
    typeof value.name === "string" &&
    "schema" in value
  )
}
```

When it matches, throw a multi-line error naming the export (`StructuredTool "<name>"`), explaining *why* Dawn wants a plain function (type inference from the signature), showing the 3-line wrapper conversion, and linking `https://dawnai.org/docs/tools`.

### A2. Better generic error

The fallback error names what was found via a `describeExport(value)` helper (`"no default export"`, `"a string"`, `"an object with keys [a, b]"`, …) and links the docs page.

### A3. Docs (tools.mdx)

- New subsection documenting the **JSDoc description convention** (where the LLM-facing tool description comes from; `export const description` as the override).
- New **"Using an existing LangChain tool"** entry under Common patterns: instantiate the community tool at module scope, wrap in a plain function with a typed input.

### Part A testing

- Unit tests in `packages/cli/test/` for `loadToolDefinition`: a fake StructuredTool-shaped export produces the targeted error (asserting it names the tool and contains the docs link); `undefined` / string / plain-object defaults produce the described-export generic error; existing accepted shapes unaffected.

---

## Part B — sandboxed `ctx.fs` (PR 2: `@dawn-ai/core` + `@dawn-ai/sdk` + `@dawn-ai/cli`)

### B1. Gate extraction (refactor, no behavior change)

Move `gatePathOp`, `gateBashOp`, and `emitPermissionInterrupt` from `capabilities/built-in/workspace.ts` into a shared core module (`packages/core/src/capabilities/permission-gate.ts`), exported for internal use. The built-in workspace capability imports them; existing tests must pass unchanged.

### B2. `WorkspaceFs` + `DawnToolContext` types in `@dawn-ai/sdk`

```ts
export interface WorkspaceFs {
  /** Read a UTF-8 file. Relative paths resolve against the route's workspace/. */
  readFile(path: string, opts?: { readonly maxBytes?: number }): Promise<string>
  /** Read raw bytes (images, PDFs, …). Throws a clear error if the configured
      backend doesn't implement readBinaryFile. */
  readBinaryFile(path: string, opts?: { readonly maxBytes?: number }): Promise<Uint8Array>
  /** Write a UTF-8 file. localFilesystem creates missing parent directories. */
  writeFile(path: string, content: string): Promise<{ readonly bytesWritten: number }>
  /** List entries (leaf names). Defaults to the workspace root. */
  listDir(path?: string): Promise<readonly string[]>
}

export interface DawnToolContext {
  readonly signal: AbortSignal
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly fs: WorkspaceFs
}
```

`RuntimeContext` (workflow/graph entries) gains `readonly fs: WorkspaceFs`.

### B3. `createWorkspaceFs` factory in core

`packages/core/src/capabilities/workspace-fs.ts`: closes over `{ workspaceRoot, backend, permissions, signal }`; each method resolves the (workspace-relative) path, runs the shared gate (`readFile` op for both text and binary reads; `writeFile`; `listDir`), then delegates to the backend. `readBinaryFile` throws `"The configured filesystem backend does not support binary reads (readBinaryFile). localFilesystem supports it; custom backends must implement it."` when the backend lacks the optional method.

### B4. Agent-facing tools refactor onto the handle

`buildWorkspaceTools` constructs the handle and routes its tool bodies through it, so the LLM-facing tools and `ctx.fs` share one gated code path. The `tool-outputs/` special case (uncapped read + best-effort `touchFile`) is preserved — it stays in the agent-tool layer (it is offload plumbing, not part of the author-facing `WorkspaceFs` contract).

### B5. Threading

Tool `run` is invoked from multiple sites — cli `createDawnContext` (workflow/graph `ctx.tools`), and `@dawn-ai/langchain`'s `tool-converter.ts` / `tool-loop.ts` (agent routes). Rather than threading `fs` through every caller, **`prepareRouteExecution` (cli) injects it once by wrapping the assembled tool definitions**:

```ts
tools = tools.map((t) => ({ ...t, run: (input, ctx) => t.run(input, { ...ctx, fs }) }))
```

so `@dawn-ai/langchain` requires **no changes** (its locally-declared structural tool type still matches). Additionally:

- `prepareRouteExecution` hoists permissions-store creation out of the agent-only branch (workflow/graph routes need the store's allow/deny rules too) and builds the handle from the same sources the workspace capability uses (`config.backends?.filesystem ?? localFilesystem()`, `<appRoot>/workspace` regardless of whether the directory exists — honest ENOENT at call time).
- `createDawnContext` gains an `fs` option and exposes it on the workflow/graph `RuntimeContext`.
- `DiscoveredToolDefinition`'s and core `DawnToolDefinition`'s run-context types gain `readonly fs?: WorkspaceFs` (optional at the definition layer; the author-facing `DawnToolContext` declares it required since the cli always injects it). Capability-contributed tools receive and ignore it.

### B5a. Interrupt reachability (discovered during planning recon)

The interactive permission interrupt is LangGraph machinery — it only works inside a graph node. **Agent-route tools** run inside the generated graph (`DynamicStructuredTool`), so the full interactive prompt works there. **Workflow/graph entries and their `ctx.tools` calls run as plain functions** (`invokeEntry`), where `interrupt()` would throw. Therefore `createWorkspaceFs` takes an `interruptCapable` flag (set from the route kind): when an outside-workspace path is `unknown` in interactive mode and interrupts are not available, the gate **fails closed** with a message telling the user to add an allow rule to `dawn.config.ts` permissions. The extracted `gatePathOp` gains an option to suppress interrupting (default preserves current behavior).

### B6. Interrupt-resume caveat (documented, inherited)

A permission interrupt fired from inside tool code pauses mid-tool-execution; on resume LangGraph re-runs the node body, so the tool function executes again from the top. This is existing interrupt semantics, not new behavior — but `ctx.fs` makes it reachable from author code, so the docs must call it out: keep side effects before/around gated `fs` calls idempotent.

### B7. Docs

New docs-site page (**"Workspace filesystem"**, `apps/web/content/docs/workspace.mdx`) telling the complete story: the pluggable backend (`FilesystemBackend`, `localFilesystem`, `compose`, `FilesystemMiddleware`, `withFilesystemLogging`) → the agent-facing workspace tools → `ctx.fs` for tool/route authors (with the permission table and the interrupt-resume note). Closes the missing-backend-docs gap deferred from PR #207. tools.mdx's runtime-signature section updates to show `ctx.fs` and link the new page.

### Part B testing

- **core unit tests** (`packages/core/test/`): factory — relative-path jail resolution; inside-workspace silent allow; outside-workspace deny (non-interactive fail-closed) and store-allow; `writeFile`/`listDir` gating; binary read delegation; backend-lacks-binary error; `bypass` mode.
- **cli integration** (`packages/cli/test/`): a fixture route tool that uses `ctx.fs.readFile`/`writeFile` end-to-end; workflow entry receiving `ctx.fs`.
- **Regression:** existing workspace-capability tests pass unchanged after B1/B4.

---

## Out of scope (follow-ups)

- `@dawn-ai/testing` support for `ctx.fs` (harness-provided `WorkspaceFs` over a temp dir) — belongs to backlog #6's spec.
- `fromLangChainTool()` adapter — only if demand appears.
- `statFile`/`removeFile`/`touchFile`/`mkdir`/`writeBinaryFile` on `WorkspaceFs`.
- `dawn check` lint warning on raw `node:fs` imports in tool files — attractive once `ctx.fs` exists, but a separate increment.

## Changesets

Two PRs, one changeset each: PR 1 `"@dawn-ai/cli": minor`; PR 2 `"@dawn-ai/core": minor`, `"@dawn-ai/sdk": minor`, `"@dawn-ai/cli": minor` (fixed versioning bumps all together regardless).
