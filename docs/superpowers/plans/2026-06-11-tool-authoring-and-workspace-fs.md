# Tool Authoring Diagnostics + Sandboxed `ctx.fs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route-tool authors get a targeted error when they default-export a LangChain `tool()`, and a sandboxed, permission-gated `ctx.fs` filesystem handle on every tool and workflow/graph context.

**Architecture:** Two PRs from one spec (`docs/superpowers/specs/2026-06-11-tool-authoring-and-workspace-fs-design.md`). **Part A** (Tasks 1–3, PR 1) touches only `@dawn-ai/cli` tool discovery + docs. **Part B** (Tasks 4–13, PR 2) extracts the permission gate from the built-in workspace capability into a shared core module, adds a `createWorkspaceFs` factory, declares `WorkspaceFs`/`DawnToolContext` in the sdk, and injects the handle once in `prepareRouteExecution` by wrapping tool definitions — `@dawn-ai/langchain` is untouched.

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space indent, ESM `.js` specifiers), pnpm workspace, Vitest, Biome, changesets.

**Conventions you MUST follow:**
- Build before testing: `pnpm -r build` once at start; after editing a package that another package's tests consume via `dist/`, rebuild that package (`pnpm --filter <pkg> build`).
- Tests live in `packages/<pkg>/test/*.test.ts`. Run one package: `pnpm --filter @dawn-ai/cli test`.
- Lint after each task: `pnpm --filter <pkg> lint`. Biome forbids non-null assertions (`!.`) in src — bind optionals to locals instead.
- Part A is branch `feat/tool-authoring-diagnostics` off `main`; Part B continues on `feat/tool-authoring-workspace-fs` (already exists, contains the spec). Do not start Part B's code before Part A's PR is opened.

---

## Part A — authoring diagnostics + docs (PR 1: `@dawn-ai/cli`)

### Task 1: StructuredTool detection + descriptive generic error in tool discovery

**Files:**
- Modify: `packages/cli/src/lib/runtime/tool-discovery.ts` (the `loadToolDefinition` function, currently ends at the generic `throw` around line 158)
- Test: `packages/cli/test/tool-discovery-errors.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/tool-discovery-errors.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverToolDefinitions } from "../src/lib/runtime/tool-discovery.js"

describe("tool discovery error messages", () => {
  let appRoot: string
  let toolsDir: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-tooldisc-"))
    toolsDir = join(appRoot, "route", "tools")
    mkdirSync(toolsDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  function writeTool(name: string, source: string): void {
    writeFileSync(join(toolsDir, name), source, "utf8")
  }

  async function discover() {
    return discoverToolDefinitions({ appRoot, routeDir: join(appRoot, "route") })
  }

  it("names a LangChain StructuredTool-shaped default export and shows the wrapper fix", async () => {
    writeTool(
      "search.ts",
      `export default {
        name: "web_search",
        schema: {},
        invoke: async () => "results",
      }`,
    )
    await expect(discover()).rejects.toThrow(
      /default-exports a LangChain tool\(\) \(StructuredTool "web_search"\)/,
    )
    await expect(discover()).rejects.toThrow(/export default async/)
    await expect(discover()).rejects.toThrow(/dawnai\.org\/docs\/tools/)
  })

  it("describes a plain-object default export by its keys", async () => {
    writeTool("config.ts", `export default { apiKey: "x", region: "us" }`)
    await expect(discover()).rejects.toThrow(/an object with keys \[apiKey, region\]/)
    await expect(discover()).rejects.toThrow(/dawnai\.org\/docs\/tools/)
  })

  it("describes a missing default export", async () => {
    writeTool("nothing.ts", `export const helper = 1`)
    await expect(discover()).rejects.toThrow(/no default export/)
  })

  it("describes a primitive default export by type", async () => {
    writeTool("oops.ts", `export default "just a string"`)
    await expect(discover()).rejects.toThrow(/a string/)
  })

  it("still accepts a plain default-exported function", async () => {
    writeTool("greet.ts", `export default async (input: { name: string }) => input.name`)
    const tools = await discover()
    expect(tools.map((t) => t.name)).toEqual(["greet"])
  })

  it("still accepts an object with a run function", async () => {
    writeTool("runner.ts", `export default { run: async () => "ok" }`)
    const tools = await discover()
    expect(tools.map((t) => t.name)).toEqual(["runner"])
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @dawn-ai/cli test -- tool-discovery-errors`
Expected: the four error-message tests FAIL (current error is the generic `must default export a function`); the two acceptance tests PASS.

- [ ] **Step 3: Implement detection and descriptive errors**

In `packages/cli/src/lib/runtime/tool-discovery.ts`, replace the final `throw` in `loadToolDefinition` and add two helpers below it:

```ts
  if (looksLikeLangChainTool(definition)) {
    throw new Error(
      `Tool file ${filePath} default-exports a LangChain tool() (StructuredTool "${definition.name}").\n` +
        `Dawn tools are plain functions — Dawn infers the input/output types from the\n` +
        `function signature, so there's no schema wrapper. Convert it like this:\n\n` +
        `  const search = /* your existing tool or client */\n\n` +
        `  /** Describe what the tool does. */\n` +
        `  export default async (input: { readonly query: string }) =>\n` +
        `    search.invoke({ query: input.query })\n\n` +
        `Docs: https://dawnai.org/docs/tools`,
    )
  }

  throw new Error(
    `Tool file ${filePath} must default export a function (got ${describeExport(definition)}).\n` +
      `Docs: https://dawnai.org/docs/tools`,
  )
}

/**
 * Structural detection of a @langchain/core StructuredTool instance —
 * `.invoke()` plus `.name` plus a `schema` — without importing langchain.
 */
function looksLikeLangChainTool(value: unknown): value is { readonly name: string } {
  return (
    isRecord(value) &&
    typeof value.invoke === "function" &&
    typeof value.name === "string" &&
    "schema" in value
  )
}

function describeExport(value: unknown): string {
  if (value === undefined) return "no default export"
  if (value === null) return "null"
  if (isRecord(value)) return `an object with keys [${Object.keys(value).join(", ")}]`
  return `a ${typeof value}`
}
```

(`isRecord` is already imported at the top of the file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli test -- tool-discovery-errors`
Expected: all 6 PASS.

- [ ] **Step 5: Lint and run the full cli suite**

Run: `pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/cli test`
Expected: lint clean; all cli tests pass (no existing test asserts the old generic message — `tool-name-uniqueness.test.ts` tests a different error).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/tool-discovery.ts packages/cli/test/tool-discovery-errors.test.ts
git commit -m "feat(cli): targeted diagnostic for LangChain tool() default exports"
```

### Task 2: Document the JSDoc-description convention + LangChain wrapper pattern

**Files:**
- Modify: `apps/web/content/docs/tools.mdx`

- [ ] **Step 1: Add a "Tool descriptions" section** after the existing "The runtime signature" section (after its closing paragraph, before "## Invoking a tool"):

```mdx
## Tool descriptions

The description the LLM sees for an `agent`-route tool comes from a JSDoc comment directly above the default export:

```ts title="src/app/(public)/hello/[tenant]/tools/greet.ts"
/** Greet a user by name in the tenant's locale. */
export default async (input: { readonly name: string }) => {
  return { greeting: `Hello, ${input.name}!` }
}
```

`dawn typegen` extracts the comment into the route's `tools.json` manifest. To set it programmatically instead, export a string constant — an explicit `export const description` takes priority over the JSDoc comment:

```ts
export const description = "Greet a user by name in the tenant's locale."
```

Tools without a description still work, but the LLM only sees the tool name — write the one-liner.
```

- [ ] **Step 2: Add a "Using an existing LangChain tool" entry** under `## Common patterns` (append to the bullet list):

```mdx
- **Wrapping an existing LangChain tool** — instantiate the community tool at module scope, then expose it through a plain function with a typed input. Dawn tools are plain functions (not `tool()` wrappers) so the input/output types can be inferred from the signature:

  ```ts title="src/app/(public)/research/tools/search.ts"
  import { TavilySearch } from "@langchain/tavily"

  const tavily = new TavilySearch({ maxResults: 5 })

  /** Search the web for current information. */
  export default async (input: { readonly query: string }) =>
    tavily.invoke({ query: input.query })
  ```
```

- [ ] **Step 3: Verify the docs site builds**

Run: `pnpm --filter @dawn-ai/web build`
Expected: `✓ Compiled successfully`, static pages generated.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/tools.mdx
git commit -m "docs: JSDoc description convention + LangChain wrapper pattern in tools doc"
```

### Task 3: Part A changeset + PR

- [ ] **Step 1: Write the changeset** to `.changeset/tool-authoring-diagnostics.md`:

```md
---
"@dawn-ai/cli": minor
---

Friendlier tool-discovery errors. Default-exporting a LangChain `tool()` (StructuredTool) from a route tool file now produces a targeted error naming the export and showing the 3-line plain-function wrapper conversion; the generic "must default export a function" error now describes what was actually exported and links the tools documentation.
```

- [ ] **Step 2: Full verification**

Run: `pnpm -r build && pnpm --filter @dawn-ai/cli test && pnpm --filter @dawn-ai/cli lint`
Expected: all green.

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .changeset/tool-authoring-diagnostics.md
git commit -m "chore: changeset for tool-discovery diagnostics"
git push -u origin feat/tool-authoring-diagnostics
gh pr create --base main --title "feat(cli): targeted diagnostics for tool authoring mistakes" \
  --body "Part A of docs/superpowers/specs/2026-06-11-tool-authoring-and-workspace-fs-design.md (backlog #1). StructuredTool detection + descriptive generic error + tools.mdx additions."
```

---

## Part B — sandboxed `ctx.fs` (PR 2: core + sdk + cli)

> Branch: `feat/tool-authoring-workspace-fs`. If Part A merged first, rebase onto `main`.

### Task 4: Extract the permission gate into a shared core module (pure move)

**Files:**
- Create: `packages/core/src/capabilities/permission-gate.ts`
- Modify: `packages/core/src/capabilities/built-in/workspace.ts`
- Test: existing `packages/core/test/capabilities/workspace.test.ts` (must pass unchanged)

- [ ] **Step 1: Create `permission-gate.ts`** by MOVING (cut, not copy) `GateResult`, `gatePathOp`, `gateBashOp`, `InterruptArgs`, and `emitPermissionInterrupt` from `built-in/workspace.ts`, verbatim except for exports and imports:

```ts
import type { PermissionsStore } from "@dawn-ai/permissions"
import { suggestedCommandPattern, suggestedPathPattern } from "@dawn-ai/permissions"
import { interrupt } from "@langchain/langgraph"
import { sep } from "node:path"

export type GateResult = { allowed: true } | { allowed: false; reason: string }

export type PathOperation = "readFile" | "writeFile" | "listDir"

export async function gatePathOp(
  permissions: PermissionsStore | undefined,
  operation: PathOperation,
  absPath: string,
  workspaceRoot: string,
): Promise<GateResult> {
  // ...body moved verbatim from built-in/workspace.ts...
}

export async function gateBashOp(
  permissions: PermissionsStore | undefined,
  command: string,
): Promise<GateResult> {
  // ...body moved verbatim...
}

// InterruptArgs + emitPermissionInterrupt moved verbatim (not exported beyond
// what gatePathOp/gateBashOp need — keep emitPermissionInterrupt module-private).
```

The `"readFile" | "writeFile" | "listDir"` union becomes the exported `PathOperation` alias; update the moved bodies to use it. Node import order per Biome (node builtins group as in existing files — check the file header pattern of `built-in/workspace.ts`).

- [ ] **Step 2: Update `built-in/workspace.ts`** to import from the new module:

```ts
import { gateBashOp, gatePathOp } from "../permission-gate.js"
```

and delete the moved code (also remove the now-unused `interrupt`, `suggestedCommandPattern`, `suggestedPathPattern` imports and, if no longer referenced, `sep`; keep `sep` if `readFile`'s tool-outputs check still uses it — it does).

- [ ] **Step 3: Build + regression**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/core test`
Expected: build clean; ALL core tests pass unchanged (especially `test/capabilities/workspace.test.ts`).

- [ ] **Step 4: Lint and commit**

Run: `pnpm --filter @dawn-ai/core lint`

```bash
git add packages/core/src/capabilities/permission-gate.ts packages/core/src/capabilities/built-in/workspace.ts
git commit -m "refactor(core): extract workspace permission gate into shared module"
```

### Task 5: `gatePathOp` interrupt-suppression option

**Files:**
- Modify: `packages/core/src/capabilities/permission-gate.ts`
- Test: `packages/core/test/capabilities/permission-gate.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { gatePathOp } from "../../src/capabilities/permission-gate.js"

function storeStub(mode: "interactive" | "non-interactive" | "bypass") {
  return {
    mode,
    match: () => "unknown" as const,
    addAllow: async () => {},
    load: async () => {},
  } as never
}

describe("gatePathOp interrupt suppression", () => {
  it("fails closed with guidance when interactive but interrupts unavailable", async () => {
    const result = await gatePathOp(storeStub("interactive"), "readFile", "/outside/x", "/ws", {
      interruptCapable: false,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/allow rule/)
      expect(result.reason).toMatch(/dawn\.config/)
    }
  })

  it("still allows inside-workspace paths without consulting the store", async () => {
    const result = await gatePathOp(storeStub("interactive"), "readFile", "/ws/notes.md", "/ws", {
      interruptCapable: false,
    })
    expect(result.allowed).toBe(true)
  })
})
```

(If the store stub's shape drifts from `PermissionsStore`, build a minimal real store via `@dawn-ai/permissions` `createPermissionsStore` the way `packages/core/test/capabilities/workspace.test.ts` does — copy its pattern.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @dawn-ai/core test -- permission-gate`
Expected: FAIL — `gatePathOp` doesn't accept a 5th argument; interactive+unknown path tries to `interrupt()` and throws a LangGraph error instead of failing closed.

- [ ] **Step 3: Implement the option**

In `gatePathOp`, add the parameter and the branch (before the interactive-interrupt path):

```ts
export async function gatePathOp(
  permissions: PermissionsStore | undefined,
  operation: PathOperation,
  absPath: string,
  workspaceRoot: string,
  opts?: { readonly interruptCapable?: boolean },
): Promise<GateResult> {
  // ...unchanged until the `decision === "unknown"` handling...
  if (permissions.mode === "non-interactive") {
    return { allowed: false, reason: `Permission denied (fail-closed): ${absPath}` }
  }
  if (opts?.interruptCapable === false) {
    return {
      allowed: false,
      reason:
        `Permission denied: ${absPath} is outside the workspace and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "${operation}" to the permissions config in dawn.config.ts.`,
    }
  }
  // ...existing interrupt path unchanged (default: interrupts allowed)...
```

- [ ] **Step 4: Verify green + regression**

Run: `pnpm --filter @dawn-ai/core test`
Expected: new tests PASS, all existing tests still pass (omitted option preserves behavior).

- [ ] **Step 5: Lint + commit**

```bash
git add packages/core/src/capabilities/permission-gate.ts packages/core/test/capabilities/permission-gate.test.ts
git commit -m "feat(core): gatePathOp can fail closed where interrupts are unavailable"
```

### Task 6: `WorkspaceFs` + `DawnToolContext` types in `@dawn-ai/sdk`

**Files:**
- Create: `packages/sdk/src/workspace-fs.ts`
- Modify: `packages/sdk/src/runtime-context.ts`, `packages/sdk/src/index.ts`

- [ ] **Step 1: Create `packages/sdk/src/workspace-fs.ts`:**

```ts
/**
 * Sandboxed filesystem handle scoped to the route's workspace/ directory.
 *
 * Relative paths resolve against the workspace root. Every call is
 * permission-gated with the same rules as the agent-facing workspace tools:
 * paths inside workspace/ are always allowed; paths outside consult the
 * permissions store (interactive prompt where available, fail-closed
 * otherwise).
 */
export interface WorkspaceFs {
  /** Read a UTF-8 file. */
  readFile(path: string, opts?: { readonly maxBytes?: number }): Promise<string>
  /**
   * Read raw bytes (images, PDFs, …). Throws a descriptive error when the
   * configured filesystem backend does not implement binary reads.
   */
  readBinaryFile(path: string, opts?: { readonly maxBytes?: number }): Promise<Uint8Array>
  /** Write a UTF-8 file. localFilesystem creates missing parent directories. */
  writeFile(path: string, content: string): Promise<{ readonly bytesWritten: number }>
  /** List entries (leaf names). Defaults to the workspace root. */
  listDir(path?: string): Promise<readonly string[]>
}

/** The context argument Dawn passes to a route tool's function. */
export interface DawnToolContext {
  readonly signal: AbortSignal
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly fs: WorkspaceFs
}
```

- [ ] **Step 2: Add `fs` to `RuntimeContext`** in `packages/sdk/src/runtime-context.ts`:

```ts
import type { WorkspaceFs } from "./workspace-fs.js"

export interface RuntimeContext<TTools extends ToolRegistry = ToolRegistry> {
  readonly signal: AbortSignal
  readonly tools: TTools
  readonly fs: WorkspaceFs
}
```

- [ ] **Step 3: Export from `packages/sdk/src/index.ts`** — add `DawnToolContext` and `WorkspaceFs` to the type-export block (alphabetical position within the existing `export type {...}` lists).

- [ ] **Step 4: Build the workspace + check downstream**

Run: `pnpm --filter @dawn-ai/sdk build && pnpm -r build`
Expected: sdk builds. **Downstream `pnpm -r build` may fail** where `RuntimeContext` objects are constructed without `fs` (cli `createDawnContext`) — that is expected mid-feature; note the failures, they are fixed in Task 9. If the breakage blocks unrelated packages, temporarily mark `fs` optional is NOT allowed — instead proceed directly to Task 9 before committing, or commit sdk + cli wiring together at Task 9. Use one commit at the end of Task 9 if needed.

- [ ] **Step 5: Commit (alone if downstream still builds, else fold into Task 9's commit)**

```bash
git add packages/sdk/src/workspace-fs.ts packages/sdk/src/runtime-context.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): WorkspaceFs and DawnToolContext types; fs on RuntimeContext"
```

### Task 7: `createWorkspaceFs` factory in core (TDD)

**Files:**
- Create: `packages/core/src/capabilities/workspace-fs.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/test/capabilities/workspace-fs.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localFilesystem } from "@dawn-ai/workspace"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createWorkspaceFs } from "../../src/capabilities/workspace-fs.js"

describe("createWorkspaceFs", () => {
  let root: string
  let workspaceRoot: string
  const signal = new AbortController().signal

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dawn-wsfs-"))
    workspaceRoot = join(root, "workspace")
    mkdirSync(workspaceRoot, { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function make(backend = localFilesystem()) {
    return createWorkspaceFs({
      workspaceRoot,
      backend,
      permissions: undefined,
      signal,
      interruptCapable: false,
    })
  }

  it("resolves relative paths against the workspace root", async () => {
    writeFileSync(join(workspaceRoot, "notes.md"), "hello", "utf8")
    const fs = make()
    expect(await fs.readFile("notes.md")).toBe("hello")
  })

  it("round-trips writeFile/readFile and listDir", async () => {
    const fs = make()
    const res = await fs.writeFile("reports/out.md", "data")
    expect(res.bytesWritten).toBe(4)
    expect(await fs.readFile("reports/out.md")).toBe("data")
    expect([...(await fs.listDir("reports"))]).toEqual(["out.md"])
    expect([...(await fs.listDir())]).toContain("reports")
  })

  it("reads binary files as Uint8Array", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(join(workspaceRoot, "img.png"), bytes)
    const fs = make()
    const out = await fs.readBinaryFile("img.png")
    expect(out).toBeInstanceOf(Uint8Array)
    expect([...out]).toEqual([...bytes])
  })

  it("throws a descriptive error when the backend lacks readBinaryFile", async () => {
    const textOnly = {
      readFile: async () => "x",
      writeFile: async () => ({ bytesWritten: 1 }),
      listDir: async () => [],
    }
    const fs = createWorkspaceFs({
      workspaceRoot,
      backend: textOnly,
      permissions: undefined,
      signal,
      interruptCapable: false,
    })
    await expect(fs.readBinaryFile("img.png")).rejects.toThrow(
      /does not support binary reads \(readBinaryFile\)/,
    )
  })

  it("allows everything silently when no permissions store is provided", async () => {
    const outside = join(root, "outside.txt")
    writeFileSync(outside, "secret", "utf8")
    const fs = make()
    expect(await fs.readFile(outside)).toBe("secret")
  })

  it("forwards maxBytes to the backend", async () => {
    writeFileSync(join(workspaceRoot, "big.txt"), "x".repeat(100), "utf8")
    const fs = createWorkspaceFs({
      workspaceRoot,
      backend: localFilesystem({ maxFileBytes: 10 }),
      permissions: undefined,
      signal,
      interruptCapable: false,
    })
    await expect(fs.readFile("big.txt")).rejects.toThrow(/too large/)
    expect(await fs.readFile("big.txt", { maxBytes: 1000 })).toBe("x".repeat(100))
  })
})

describe("createWorkspaceFs permission gating", () => {
  // Copy the permissions-store construction pattern from
  // packages/core/test/capabilities/workspace.test.ts (createPermissionsStore
  // from @dawn-ai/permissions with mode + config), then assert:
  // - non-interactive store + outside path -> rejects /fail-closed/
  // - non-interactive store with allow rule for the path -> resolves
  // - interactive store + outside path + interruptCapable:false -> rejects /allow rule/
  // - writeFile outside -> gated with operation "writeFile"
  // - bypass-mode store + outside path -> resolves (no gating)
})
```

Fill in the second describe block by copying the exact store-construction pattern found in `packages/core/test/capabilities/workspace.test.ts` — read that file first; do not invent a stub shape.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @dawn-ai/core test -- workspace-fs`
Expected: FAIL — module `../../src/capabilities/workspace-fs.js` does not exist.

- [ ] **Step 3: Implement `packages/core/src/capabilities/workspace-fs.ts`:**

```ts
import { resolve } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { WorkspaceFs } from "@dawn-ai/sdk"
import type { FilesystemBackend } from "@dawn-ai/workspace"
import { gatePathOp, type PathOperation } from "./permission-gate.js"

export interface CreateWorkspaceFsOptions {
  readonly workspaceRoot: string
  readonly backend: FilesystemBackend
  readonly permissions: PermissionsStore | undefined
  readonly signal: AbortSignal
  /**
   * Whether this execution context can surface the interactive LangGraph
   * permission interrupt (true inside agent-route tool execution; false for
   * workflow/graph entries, which run outside the graph).
   */
  readonly interruptCapable: boolean
}

/**
 * Build the author-facing sandboxed filesystem handle (`ctx.fs`). Paths are
 * workspace-relative; every call runs the same permission gate as the
 * agent-facing workspace tools.
 */
export function createWorkspaceFs(opts: CreateWorkspaceFsOptions): WorkspaceFs {
  const bctx = { signal: opts.signal, workspaceRoot: opts.workspaceRoot }

  async function gate(operation: PathOperation, path: string): Promise<string> {
    const absPath = resolve(opts.workspaceRoot, path)
    const result = await gatePathOp(opts.permissions, operation, absPath, opts.workspaceRoot, {
      interruptCapable: opts.interruptCapable,
    })
    if (!result.allowed) throw new Error(result.reason)
    return absPath
  }

  return {
    async readFile(path, readOpts) {
      return opts.backend.readFile(await gate("readFile", path), bctx, readOpts)
    },
    async readBinaryFile(path, readOpts) {
      const absPath = await gate("readFile", path)
      const { readBinaryFile } = opts.backend
      if (!readBinaryFile) {
        throw new Error(
          "The configured filesystem backend does not support binary reads (readBinaryFile). " +
            "localFilesystem supports it; custom backends must implement it.",
        )
      }
      return readBinaryFile.call(opts.backend, absPath, bctx, readOpts)
    },
    async writeFile(path, content) {
      return opts.backend.writeFile(await gate("writeFile", path), content, bctx)
    },
    async listDir(path = ".") {
      return [...(await opts.backend.listDir(await gate("listDir", path), bctx))]
    },
  }
}
```

Export from `packages/core/src/index.ts`: add `export { createWorkspaceFs, type CreateWorkspaceFsOptions } from "./capabilities/workspace-fs.js"` in the existing export block.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/core test -- workspace-fs`
Expected: all PASS.

- [ ] **Step 5: Lint + commit**

```bash
git add packages/core/src/capabilities/workspace-fs.ts packages/core/src/index.ts packages/core/test/capabilities/workspace-fs.test.ts
git commit -m "feat(core): createWorkspaceFs sandboxed filesystem handle"
```

### Task 8: Refactor the agent-facing workspace tools onto the handle

**Files:**
- Modify: `packages/core/src/capabilities/built-in/workspace.ts` (`buildWorkspaceTools`)
- Test: existing `packages/core/test/capabilities/workspace.test.ts` must pass unchanged

- [ ] **Step 1: Rewrite the four tool bodies** to construct the handle per call (`interruptCapable: true` — agent tools run inside the graph) and delegate. `readFile` keeps the `tool-outputs/` special case in the tool layer:

```ts
const readFile: OverridableTool = {
  name: "readFile",
  description: "Read a UTF-8 file from the workspace.",
  schema: READ_FILE_INPUT,
  overridable: true,
  run: async (input, ctx) => {
    const { path } = READ_FILE_INPUT.parse(input)
    const handle = createWorkspaceFs({
      workspaceRoot,
      backend: fs,
      permissions,
      signal: ctx.signal,
      interruptCapable: true,
    })
    const absPath = resolve(workspaceRoot, path)
    const rel = relative(workspaceRoot, absPath)
    // NOTE: must match SUBDIR ("tool-outputs") in @dawn-ai/langchain offload-store.ts
    const isToolOutput = rel === "tool-outputs" || rel.startsWith(`tool-outputs${sep}`)
    const data = await handle.readFile(
      path,
      isToolOutput ? { maxBytes: Number.POSITIVE_INFINITY } : undefined,
    )
    if (isToolOutput && fs.touchFile) {
      try {
        await fs.touchFile(absPath, { signal: ctx.signal, workspaceRoot })
      } catch {
        /* touch is best-effort; never fail a read because of it */
      }
    }
    return data
  },
}
```

`writeFile` / `listDir` / `runBash`: `writeFile` and `listDir` delegate to the handle (preserving their current return shapes: the `wrote N bytes to <path>` string and the mutable array copy); `runBash` keeps using `gateBashOp` + `exec` directly (no change beyond the Task 4 import move).

- [ ] **Step 2: Regression**

Run: `pnpm --filter @dawn-ai/core test`
Expected: ALL pass unchanged — this is a pure internal refactor; permission behavior, messages, and return shapes are identical.

- [ ] **Step 3: Lint + commit**

```bash
git add packages/core/src/capabilities/built-in/workspace.ts
git commit -m "refactor(core): workspace agent tools delegate to createWorkspaceFs"
```

### Task 9: Thread `fs` through the cli (context types, createDawnContext, prepareRouteExecution)

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (`DawnToolDefinition.run` context)
- Modify: `packages/cli/src/lib/runtime/tool-discovery.ts` (`DiscoveredToolDefinition.run` context)
- Modify: `packages/cli/src/lib/runtime/dawn-context.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`
- Test: `packages/cli/test/dawn-context.test.ts` (create); existing suites as regression

- [ ] **Step 1: Write the failing test** (`packages/cli/test/dawn-context.test.ts`):

```ts
import { describe, expect, it } from "vitest"
import type { WorkspaceFs } from "@dawn-ai/sdk"
import { createDawnContext } from "../src/lib/runtime/dawn-context.js"

const fakeFs: WorkspaceFs = {
  readFile: async () => "content",
  readBinaryFile: async () => Uint8Array.from([1]),
  writeFile: async () => ({ bytesWritten: 1 }),
  listDir: async () => [],
}

describe("createDawnContext fs threading", () => {
  it("exposes fs on the route context", () => {
    const context = createDawnContext({ tools: [], fs: fakeFs })
    expect(context.fs).toBe(fakeFs)
  })

  it("passes fs to tool run contexts", async () => {
    let seenFs: WorkspaceFs | undefined
    const context = createDawnContext({
      fs: fakeFs,
      tools: [
        {
          filePath: "/x/tools/probe.ts",
          name: "probe",
          scope: "route-local",
          run: (_input, ctx) => {
            seenFs = ctx.fs
            return "ok"
          },
        },
      ],
    })
    await context.tools.probe?.({})
    expect(seenFs).toBe(fakeFs)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @dawn-ai/cli test -- dawn-context`
Expected: FAIL — `createDawnContext` has no `fs` option.

- [ ] **Step 3: Implement the type + context changes**

`packages/core/src/capabilities/types.ts` — `DawnToolDefinition.run`'s context gains the optional member:

```ts
import type { DawnAgent, WorkspaceFs } from "@dawn-ai/sdk"
// ...
  readonly run: (
    input: unknown,
    context: {
      readonly middleware?: Readonly<Record<string, unknown>>
      readonly signal: AbortSignal
      readonly fs?: WorkspaceFs
    },
  ) => Promise<unknown> | unknown
```

`packages/cli/src/lib/runtime/tool-discovery.ts` — same addition to `DiscoveredToolDefinition.run`'s context type (import `type { WorkspaceFs } from "@dawn-ai/sdk"`).

`packages/cli/src/lib/runtime/dawn-context.ts`:

```ts
import type { WorkspaceFs } from "@dawn-ai/sdk"
import type { DiscoveredToolDefinition } from "./tool-discovery.js"

export interface DawnRouteContext {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly tools: Record<string, (input: unknown) => Promise<unknown>>
  readonly fs: WorkspaceFs
}

export function createDawnContext(options: {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
  readonly tools: readonly DiscoveredToolDefinition[]
  readonly fs: WorkspaceFs
}): DawnRouteContext {
  const signal = options.signal ?? new AbortController().signal
  const middleware = options.middleware
  const tools = Object.fromEntries(
    options.tools.map((tool) => [
      tool.name,
      async (input: unknown) =>
        await tool.run(input, {
          ...(middleware ? { middleware } : {}),
          signal,
          fs: options.fs,
        }),
    ]),
  )

  const context: DawnRouteContext = { signal, tools, fs: options.fs }
  if (middleware) {
    return { ...context, middleware }
  }
  return context
}
```

- [ ] **Step 4: Wire `prepareRouteExecution`** in `packages/cli/src/lib/runtime/execute-route.ts`:

1. **Hoist permissions-store creation** out of the `if (normalized.kind === "agent")` block: move the `envMode`/`mode` resolution and `createPermissionsStore` + `await permissionsStore.load()` lines to just after the `threadsStore` assignment, so all route kinds have the store. The agent branch keeps using the hoisted `permissionsStore` variable in `applyCapabilities`.
2. **Build the handle** right after the hoisted store (import `createWorkspaceFs` from `@dawn-ai/core` and `localFilesystem` from `@dawn-ai/workspace` — check whether execute-route already imports `localFilesystem`; `buildOffload` may — reuse the import):

```ts
const workspaceFs = createWorkspaceFs({
  workspaceRoot: join(options.appRoot, "workspace"),
  backend: configBackends?.filesystem ?? localFilesystem(),
  permissions: permissionsStore,
  signal: options.signal ?? new AbortController().signal,
  interruptCapable: normalized.kind === "agent",
})
```

3. **Wrap the assembled tools** immediately before `prepareRouteExecution` returns them (after the capability-tool merge):

```ts
// Inject ctx.fs once here so every downstream invoker (createDawnContext,
// the langchain tool converter/loop) hands tools the sandboxed handle.
tools = tools.map((t) => ({
  ...t,
  run: (input: unknown, ctx: { middleware?: Readonly<Record<string, unknown>>; signal: AbortSignal }) =>
    t.run(input, { ...ctx, fs: workspaceFs }),
}))
```

4. **Return `workspaceFs` in the prepared result** (add to the prepared object's type and both `return` sites) and **pass it at both `createDawnContext` call sites** (`fs: workspaceFs` — destructure `workspaceFs` alongside `tools` at both `prepared` destructuring sites).

- [ ] **Step 5: Build + full cli regression**

Run: `pnpm -r build && pnpm --filter @dawn-ai/cli test && pnpm --filter @dawn-ai/core test`
Expected: build clean (this completes the `RuntimeContext.fs` consumers from Task 6); dawn-context tests PASS; full cli + core suites pass. If any existing cli test constructs `createDawnContext` directly, give it a stub fs (the `fakeFs` from Step 1).

- [ ] **Step 6: Lint + commit**

```bash
git add packages/core/src/capabilities/types.ts packages/cli/src/lib/runtime/tool-discovery.ts packages/cli/src/lib/runtime/dawn-context.ts packages/cli/src/lib/runtime/execute-route.ts packages/cli/test/dawn-context.test.ts
git commit -m "feat(cli): inject sandboxed ctx.fs into tool and route contexts"
```

(If Task 6's commit was deferred, include the sdk files here.)

### Task 10: End-to-end integration test (fixture route using `ctx.fs`)

**Files:**
- Test: `packages/cli/test/workspace-fs-integration.test.ts` (create)

- [ ] **Step 1: Study an existing in-process fixture test** — read `packages/cli/test/run-command.test.ts` (or `offload-exempt.test.ts`) and copy its scaffold pattern: how it creates a temp app dir with `src/app/<route>/index.ts`, a `workspace/` dir, sets `DAWN_PERMISSIONS_MODE`, and invokes the route in-process.

- [ ] **Step 2: Write the test** — a workflow route whose entry and tool both use `ctx.fs`:

Fixture files (written by the test into a temp app):

```ts
// src/app/(public)/notes/index.ts
export async function workflow(state: { readonly name: string }, ctx) {
  await ctx.tools.stash({ name: state.name })
  const listed = await ctx.fs.listDir("stash")
  return { ...state, files: listed }
}
```

```ts
// src/app/(public)/notes/tools/stash.ts
export default async (input: { readonly name: string }, ctx) => {
  await ctx.fs.writeFile(`stash/${input.name}.txt`, `stashed ${input.name}`)
  return { ok: true }
}
```

Assertions (with `DAWN_PERMISSIONS_MODE=non-interactive` set for the test):
- executing the route with input `{ name: "alpha" }` succeeds;
- the returned state's `files` equals `["alpha.txt"]`;
- the file physically exists at `<appRoot>/workspace/stash/alpha.txt` with content `stashed alpha`;
- a second fixture tool that calls `ctx.fs.readFile("../outside.txt")` (escaping the workspace) rejects, and the route output surfaces an error matching `/Permission denied/`.

Exact scaffold code: follow the studied pattern from Step 1 — same helpers, same execute entry point (`executeRouteInProcess`/equivalent exported runner the existing tests use).

- [ ] **Step 3: Run it**

Run: `pnpm --filter @dawn-ai/cli test -- workspace-fs-integration`
Expected: PASS (everything was implemented in Tasks 4–9; this validates the seam end-to-end). If it fails, debug the wiring — do not weaken the assertions.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/workspace-fs-integration.test.ts
git commit -m "test(cli): end-to-end ctx.fs integration coverage"
```

### Task 11: Docs — `workspace.mdx` page + tools.mdx context update

**Files:**
- Create: `apps/web/content/docs/workspace.mdx`
- Modify: `apps/web/app/components/docs/nav.ts` (add `{ label: "Workspace Filesystem", href: "/docs/workspace" }` to the "Concepts" section after "Middleware")
- Modify: `apps/web/content/docs/tools.mdx` ("The runtime signature" section)

- [ ] **Step 1: Write `workspace.mdx`** with this structure (write real prose, not placeholders):

```mdx
# Workspace Filesystem

[intro: every route gets a sandboxed workspace/ directory; three layers: pluggable backend, agent-facing tools, ctx.fs for authors]

## The pluggable backend
[FilesystemBackend interface summary: readFile/readBinaryFile/writeFile/listDir + optional methods; localFilesystem defaults — 256 KiB cap, writeFile creates parents; configuring a custom backend via dawn.config.ts backends.filesystem]

## Middleware
[compose() + FilesystemMiddleware; withFilesystemLogging example with destination option; note that middleware must forward optional methods]

## ctx.fs for tools and routes
[the WorkspaceFs surface with a tool example (readBinaryFile → base64) and a workflow example; relative paths resolve against workspace/]

## Permissions
[table: inside workspace = silent allow; outside = store consultation; interactive prompt (agent-route tools only) / fail-closed (non-interactive, and workflow/graph contexts where prompts can't appear — add allow rules to dawn.config.ts); bypass mode]

## Interrupt-resume caveat
[a permission prompt fired from inside tool code re-runs the tool body on resume; keep side effects around gated fs calls idempotent]
```

Use the code examples from the spec (`docs/superpowers/specs/2026-06-11-tool-authoring-and-workspace-fs-design.md` §B2 and the appendix of the binary-read spec) as the basis for the `ctx.fs` section.

- [ ] **Step 2: Update tools.mdx "The runtime signature"** — change the signature description and example so `ctx` is `DawnToolContext` (signal, middleware?, fs) imported from `@dawn-ai/sdk`, and link the new page:

```ts
import type { DawnToolContext } from "@dawn-ai/sdk"

export default async (input: { readonly tenant: string }, ctx: DawnToolContext) => {
  const greeting = await ctx.fs.readFile("greeting-template.md")
  // ...
}
```

Add to the Related cards: `{ href: "/docs/workspace", title: "Workspace Filesystem", subtitle: "the sandboxed ctx.fs handle and pluggable backend" }`.

- [ ] **Step 3: Build the docs site**

Run: `pnpm --filter @dawn-ai/web build`
Expected: compiles, page count increases by one.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/workspace.mdx apps/web/app/components/docs/nav.ts apps/web/content/docs/tools.mdx
git commit -m "docs: workspace filesystem page; ctx.fs in tools runtime signature"
```

### Task 12: Part B changeset + full verification

- [ ] **Step 1: Write `.changeset/workspace-fs-context.md`:**

```md
---
"@dawn-ai/core": minor
"@dawn-ai/sdk": minor
"@dawn-ai/cli": minor
---

Sandboxed `ctx.fs` for route tools and workflow/graph entries. Tools and route entries now receive a `WorkspaceFs` handle (`readFile`, `readBinaryFile`, `writeFile`, `listDir`) that resolves paths against the route's `workspace/` directory and runs the same permission gate as the agent-facing workspace tools — no more dropping to `node:fs`. The permission gate is extracted to a shared core module; in execution contexts where interactive prompts can't appear (workflow/graph entries), outside-workspace access fails closed with guidance to add an allow rule.
```

- [ ] **Step 2: Full verification**

Run: `pnpm -r build && pnpm --filter @dawn-ai/workspace test && pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/langchain test && pnpm --filter @dawn-ai/cli test && pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/cli lint && pnpm --filter @dawn-ai/sdk lint`
Expected: everything green.

- [ ] **Step 3: Commit + push + PR**

```bash
git add .changeset/workspace-fs-context.md
git commit -m "chore: changeset for sandboxed ctx.fs"
git push -u origin feat/tool-authoring-workspace-fs
gh pr create --base main --title "feat: sandboxed ctx.fs for route tools and workflow entries" \
  --body "Part B of docs/superpowers/specs/2026-06-11-tool-authoring-and-workspace-fs-design.md (backlog #3). Gate extraction, createWorkspaceFs, sdk types, cli threading, workspace.mdx docs."
```

### Task 13: Post-merge housekeeping

- [ ] After both PRs merge: verify the changesets "Version Packages" PR includes both entries; confirm `examples/chat/server` still builds in CI (it exercises the full pipeline).
