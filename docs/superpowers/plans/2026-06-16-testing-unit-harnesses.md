# Testing Unit-Harnesses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three unit-test harnesses to `@dawn-ai/testing` — `createWorkspaceHarness`, `createToolHarness`, `createMiddlewareHarness` — so authors can test a route tool or a `FilesystemMiddleware` (and `ctx.fs` code) in isolation against the real `WorkspaceFs`/backend.

**Architecture:** One PR off `feat/testing-unit-harnesses` (spec: `docs/superpowers/specs/2026-06-16-testing-unit-harnesses-design.md`). Async `create*Harness` factories matching the existing `createAgentHarness` convention (`.close()` teardown + `[Symbol.asyncDispose]` for optional `await using`). The workspace harness is the shared fixture the other two build on. Real `createWorkspaceFs` (core) over a temp `localFilesystem` (workspace); permissive gating by default. W1 sets up deps + the workspace fixture; W2/W3 add the tool/middleware harnesses on top; W4 docs + changeset + PR.

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space, ESM `.js` specifiers), pnpm, Vitest, Biome, changesets.

**Conventions:** `pnpm -r build` once at start; rebuild `@dawn-ai/testing` after edits before running its tests if they consume `dist` (they import from `../src/` so usually not needed). Run `pnpm -r --if-present typecheck` before declaring done. `pyenv: cannot rehash` output is harmless noise. The package's tests use top-level `await` + `afterAll(() => h.close())` (see `test/harness-construct.test.ts`) and import from `../src/*.js`.

---

### Task W1: deps + `createWorkspaceHarness` (TDD)

**Files:**
- Modify: `packages/testing/package.json` (add `@dawn-ai/workspace`, `@dawn-ai/sdk`)
- Create: `packages/testing/src/workspace-harness.ts`
- Modify: `packages/testing/src/index.ts` (export it)
- Test: `packages/testing/test/workspace-harness.test.ts` (create)

- [ ] **Step 1: Add dependencies.** In `packages/testing/package.json`, add `@dawn-ai/workspace` and `@dawn-ai/sdk` to BOTH `peerDependencies` and `devDependencies`, matching how `@dawn-ai/core`/`@dawn-ai/cli` are already listed (check the existing version/`workspace:*` style and mirror it exactly). Run `pnpm install` so the workspace links resolve.

- [ ] **Step 2: Write the failing tests** (`packages/testing/test/workspace-harness.test.ts`):

```ts
import { existsSync, realpathSync } from "node:fs"
import { afterEach, expect, it } from "vitest"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { createWorkspaceHarness, type WorkspaceHarness } from "../src/workspace-harness.js"

const open: WorkspaceHarness[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()))
})
async function harness(...args: Parameters<typeof createWorkspaceHarness>) {
  const h = await createWorkspaceHarness(...args)
  open.push(h)
  return h
}

it("round-trips write -> fs.readFile and fs.writeFile -> read", async () => {
  const h = await harness()
  await h.write("notes/seed.md", "hi")
  expect(await h.fs.readFile("notes/seed.md")).toBe("hi")
  await h.fs.writeFile("out/result.md", "done")
  expect(await h.read("out/result.md")).toBe("done")
})

it("exposes a realpath'd workspace dir", async () => {
  const h = await harness()
  expect(h.dir).toBe(realpathSync(h.dir))
})

it("close() removes the temp dir and is idempotent", async () => {
  const h = await createWorkspaceHarness()
  const dir = h.dir
  await h.close()
  await h.close() // idempotent
  expect(existsSync(dir)).toBe(false)
})

it("supports `await using` auto-disposal", async () => {
  let captured = ""
  {
    await using h = await createWorkspaceHarness()
    captured = h.dir
    expect(existsSync(captured)).toBe(true)
  }
  expect(existsSync(captured)).toBe(false)
})

it("is permissive by default (allows an outside-workspace read)", async () => {
  const h = await harness()
  // an absolute path outside the workspace resolves with no permissions store
  await expect(h.fs.readFile("/etc/hostname")).resolves.toBeTypeOf("string")
})

it("fails closed for an outside path when a non-interactive store is injected", async () => {
  const h = await harness({
    permissions: createPermissionsStore({ appRoot: process.cwd(), mode: "non-interactive" }),
  })
  await expect(h.fs.readFile("/etc/hostname")).rejects.toThrow(/fail-closed/)
})
```

(If `createPermissionsStore`'s signature differs, read `packages/core/test/capabilities/workspace-fs.test.ts` for the exact construction pattern and match it. If reading `/etc/hostname` is unavailable in the sandbox, substitute any path outside the temp workspace that exists, e.g. the repo root.)

- [ ] **Step 3: Run to verify failure:** `pnpm --filter @dawn-ai/testing test -- workspace-harness` → FAIL (module missing).

- [ ] **Step 4: Implement `packages/testing/src/workspace-harness.ts`:**

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createWorkspaceFs } from "@dawn-ai/core"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { WorkspaceFs } from "@dawn-ai/sdk"
import { localFilesystem } from "@dawn-ai/workspace"

export interface WorkspaceHarness {
  readonly fs: WorkspaceFs
  readonly dir: string
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface WorkspaceHarnessOptions {
  readonly permissions?: PermissionsStore
}

export async function createWorkspaceHarness(
  opts?: WorkspaceHarnessOptions,
): Promise<WorkspaceHarness> {
  const root = await mkdtemp(join(tmpdir(), "dawn-ws-harness-"))
  const workspaceRoot = join(root, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  // The symlink-hardened gate canonicalizes the root; realpath here so
  // inside-workspace paths classify correctly (macOS /var -> /private/var).
  const canonicalRoot = realpathSync(workspaceRoot)
  const controller = new AbortController()
  const fs = createWorkspaceFs({
    workspaceRoot: canonicalRoot,
    backend: localFilesystem(),
    permissions: opts?.permissions,
    signal: controller.signal,
    interruptCapable: false,
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
    await rm(root, { force: true, recursive: true })
  }

  return {
    fs,
    dir: canonicalRoot,
    async read(path) {
      return await readFile(join(canonicalRoot, path), "utf8")
    },
    async write(path, content) {
      const abs = join(canonicalRoot, path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, "utf8")
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
```

Export `createWorkspaceHarness` + the two types from `packages/testing/src/index.ts` (follow the file's existing export grouping).

- [ ] **Step 5: Verify green:** `pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing test -- workspace-harness && pnpm --filter @dawn-ai/testing lint`. Then `pnpm -r build && pnpm -r --if-present typecheck`.

- [ ] **Step 6: Commit:**
```bash
git add packages/testing/package.json packages/testing/src/workspace-harness.ts packages/testing/src/index.ts packages/testing/test/workspace-harness.test.ts pnpm-lock.yaml
git commit -m "feat(testing): createWorkspaceHarness — real WorkspaceFs over a temp dir"
```

### Task W2: `createToolHarness` (TDD)

**Files:**
- Create: `packages/testing/src/tool-harness.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/tool-harness.test.ts` (create)

- [ ] **Step 1: Write the failing tests:**

```ts
import { afterEach, expect, it } from "vitest"
import type { DawnToolContext } from "@dawn-ai/sdk"
import { createToolHarness, type ToolHarness } from "../src/tool-harness.js"
import { createWorkspaceHarness } from "../src/workspace-harness.js"

const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()))
})

// fixture tool: writes a note, returns count of notes/
const stash = async (input: { name: string }, ctx: DawnToolContext) => {
  await ctx.fs.writeFile(`notes/${input.name}.md`, `# ${input.name}`)
  return { count: (await ctx.fs.listDir("notes")).length }
}

it("invokes a ctx.fs tool and exposes its workspace side effects", async () => {
  const h = await createToolHarness(stash)
  open.push(h)
  const result = await h.invoke({ name: "alpha" })
  expect(result).toEqual({ count: 1 })
  expect(await h.workspace.read("notes/alpha.md")).toContain("# alpha")
})

it("invoke() is reusable and accumulates workspace state", async () => {
  const h = await createToolHarness(stash)
  open.push(h)
  await h.invoke({ name: "a" })
  expect(await h.invoke({ name: "b" })).toEqual({ count: 2 })
})

it("passes the middleware bag to ctx.middleware", async () => {
  let seen: unknown
  const tool = async (_input: unknown, ctx: DawnToolContext) => {
    seen = ctx.middleware
    return "ok"
  }
  const h = await createToolHarness(tool, { middleware: { userId: "u1" } })
  open.push(h)
  await h.invoke({})
  expect(seen).toEqual({ userId: "u1" })
})

it("shares a passed-in workspace and does NOT close it", async () => {
  const ws = await createWorkspaceHarness()
  open.push(ws)
  const h = await createToolHarness(stash, { workspace: ws })
  await h.invoke({ name: "x" })
  await h.close() // must NOT remove ws
  expect(await ws.read("notes/x.md")).toContain("# x")
})
```

- [ ] **Step 2:** `pnpm --filter @dawn-ai/testing test -- tool-harness` → FAIL (module missing).

- [ ] **Step 3: Implement `packages/testing/src/tool-harness.ts`:**

```ts
import type { DawnToolContext, WorkspaceFs } from "@dawn-ai/sdk"
import type { PermissionsStore } from "@dawn-ai/permissions"
import { createWorkspaceHarness, type WorkspaceHarness } from "./workspace-harness.js"

export interface ToolHarness<I, O> {
  invoke(input: I): Promise<O>
  readonly workspace: WorkspaceHarness
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface ToolHarnessOptions {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly workspace?: WorkspaceHarness
  readonly permissions?: PermissionsStore
}

export async function createToolHarness<I, O>(
  tool: (input: I, ctx: DawnToolContext) => Promise<O> | O,
  opts?: ToolHarnessOptions,
): Promise<ToolHarness<I, O>> {
  const ownsWorkspace = opts?.workspace === undefined
  const workspace =
    opts?.workspace ??
    (await createWorkspaceHarness(opts?.permissions ? { permissions: opts.permissions } : undefined))
  const controller = new AbortController()
  const fs: WorkspaceFs = workspace.fs

  const close = async (): Promise<void> => {
    controller.abort()
    if (ownsWorkspace) await workspace.close()
  }

  return {
    async invoke(input) {
      const ctx: DawnToolContext = {
        signal: controller.signal,
        fs,
        ...(opts?.middleware ? { middleware: opts.middleware } : {}),
      }
      return await tool(input, ctx)
    },
    workspace,
    close,
    [Symbol.asyncDispose]: close,
  }
}
```

Export from `index.ts`.

- [ ] **Step 4:** `pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing test -- tool-harness && pnpm --filter @dawn-ai/testing lint`. Then `pnpm -r --if-present typecheck`.

- [ ] **Step 5: Commit:**
```bash
git add packages/testing/src/tool-harness.ts packages/testing/src/index.ts packages/testing/test/tool-harness.test.ts
git commit -m "feat(testing): createToolHarness — invoke a route tool against a real ctx.fs"
```

### Task W3: `createMiddlewareHarness` (TDD)

**Files:**
- Create: `packages/testing/src/middleware-harness.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/testing/test/middleware-harness.test.ts` (create)

- [ ] **Step 1: Write the failing tests:**

```ts
import { afterEach, expect, it } from "vitest"
import type { BackendContext, FilesystemBackend, FilesystemMiddleware } from "@dawn-ai/workspace"
import { createMiddlewareHarness, type MiddlewareHarness } from "../src/middleware-harness.js"

const open: MiddlewareHarness[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()))
})

// a complete logging middleware that forwards every method (incl. realPath)
const withLog = (log: string[]): FilesystemMiddleware => (next) => ({
  readFile: (p, c, o) => { log.push(`read ${p}`); return next.readFile(p, c, o) },
  writeFile: (p, content, c) => { log.push(`write ${p}`); return next.writeFile(p, content, c) },
  listDir: (p, c) => next.listDir(p, c),
  realPath: (p, c) => next.realPath(p, c),
  ...(next.readBinaryFile && { readBinaryFile: (p, c, o) => next.readBinaryFile!(p, c, o) }),
  ...(next.statFile && { statFile: (p, c) => next.statFile!(p, c) }),
  ...(next.removeFile && { removeFile: (p, c) => next.removeFile!(p, c) }),
  ...(next.touchFile && { touchFile: (p, c) => next.touchFile!(p, c) }),
  ...(next.mkdir && { mkdir: (p, c) => next.mkdir!(p, c) }),
})

it("composes the middleware over a temp backend and records calls while serving I/O", async () => {
  const log: string[] = []
  const h = await createMiddlewareHarness(withLog(log))
  open.push(h)
  const file = join(h.dir, "a.md")
  await h.backend.writeFile(file, "hi", h.ctx)
  expect(await h.backend.readFile(file, h.ctx)).toBe("hi")
  expect(log).toEqual([`write ${file}`, `read ${file}`])
})

it("assertForwardsAll passes for a complete middleware", async () => {
  const h = await createMiddlewareHarness(withLog([]))
  open.push(h)
  expect(() => h.assertForwardsAll()).not.toThrow()
})

it("assertForwardsAll throws for a middleware that drops realPath", async () => {
  const incomplete: FilesystemMiddleware = (next) => ({
    readFile: next.readFile,
    writeFile: next.writeFile,
    listDir: next.listDir,
    // realPath omitted (the #207-class bug; realPath is required)
  }) as unknown as FilesystemBackend
  const h = await createMiddlewareHarness(incomplete)
  open.push(h)
  expect(() => h.assertForwardsAll()).toThrow(/realPath/)
})
```

(Add `import { join } from "node:path"`.)

- [ ] **Step 2:** `pnpm --filter @dawn-ai/testing test -- middleware-harness` → FAIL.

- [ ] **Step 3: Implement `packages/testing/src/middleware-harness.ts`:**

```ts
import { mkdtemp, rm } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BackendContext,
  FilesystemBackend,
  FilesystemMiddleware,
} from "@dawn-ai/workspace"
import { localFilesystem } from "@dawn-ai/workspace"

export interface MiddlewareHarness {
  readonly backend: FilesystemBackend
  readonly ctx: BackendContext
  readonly dir: string
  assertForwardsAll(): void
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function createMiddlewareHarness(
  middleware: FilesystemMiddleware,
): Promise<MiddlewareHarness> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "dawn-mw-harness-")))
  const base = localFilesystem()
  const backend = middleware(base)
  const controller = new AbortController()
  const ctx: BackendContext = { signal: controller.signal, workspaceRoot: dir }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
    await rm(dir, { force: true, recursive: true })
  }

  return {
    backend,
    ctx,
    dir,
    assertForwardsAll() {
      const missing = (Object.keys(base) as Array<keyof FilesystemBackend>).filter(
        (method) => typeof base[method] === "function" && typeof backend[method] !== "function",
      )
      if (missing.length > 0) {
        throw new Error(
          `Middleware dropped backend method(s) the base provides: ${missing.join(", ")}. ` +
            "A FilesystemMiddleware must forward every method (required and optional) it does not intercept.",
        )
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
```

(Note: `Object.keys(localFilesystem())` enumerates the methods the base actually implements — `realPath`, `readBinaryFile`, `statFile`, etc. — so `assertForwardsAll` catches any the middleware fails to forward. Verify `localFilesystem()` returns a plain object whose own keys are the methods; if it uses a prototype/class, adjust to enumerate accordingly.)

Export from `index.ts`.

- [ ] **Step 4:** `pnpm --filter @dawn-ai/testing build && pnpm --filter @dawn-ai/testing test -- middleware-harness && pnpm --filter @dawn-ai/testing lint`. Then `pnpm -r --if-present typecheck`.

- [ ] **Step 5: Commit:**
```bash
git add packages/testing/src/middleware-harness.ts packages/testing/src/index.ts packages/testing/test/middleware-harness.test.ts
git commit -m "feat(testing): createMiddlewareHarness — exercise a FilesystemMiddleware + assertForwardsAll"
```

### Task W4: docs + changeset + full verification + PR

**Files:**
- Modify: `apps/web/content/docs/testing.mdx`
- Create: `.changeset/testing-unit-harnesses.md`

- [ ] **Step 1: Docs.** Add a **"Unit-testing tools and middleware"** section to `apps/web/content/docs/testing.mdx` (place it after the scenario content, before "Related" — read the file to match heading style). Cover the three harnesses with short examples: `createToolHarness` invoking a `ctx.fs` tool and asserting `workspace.read(...)`; `createWorkspaceHarness` for testing `ctx.fs` code directly; `createMiddlewareHarness` + `assertForwardsAll()`. Show both `afterEach(() => h.close())` and `await using` patterns. Note these complement (don't replace) the scenario harness. Build docs: `pnpm --filter @dawn-ai/web build` (revert `apps/web/next-env.d.ts` churn).

- [ ] **Step 2: Changeset** `.changeset/testing-unit-harnesses.md`:

```md
---
"@dawn-ai/testing": minor
---

Unit-test harnesses for tools, middleware, and the workspace. `createToolHarness(tool)` invokes a route tool against a real, temp-backed `ctx.fs` (reusable `invoke()` for cumulative-state assertions); `createMiddlewareHarness(mw)` exercises a `FilesystemMiddleware` over a temp `localFilesystem` and offers `assertForwardsAll()` to catch dropped backend methods; `createWorkspaceHarness()` is the shared temp-`WorkspaceFs` fixture, also usable to test `ctx.fs` code directly. All are async `create*Harness` factories with `.close()` and `[Symbol.asyncDispose]` (for `await using`), matching `createAgentHarness`. Adds `@dawn-ai/workspace` and `@dawn-ai/sdk` as peer dependencies.
```

- [ ] **Step 3: Full verification (report each):**
```
pnpm -r build
pnpm -r --if-present typecheck
pnpm --filter @dawn-ai/testing test
pnpm --filter @dawn-ai/testing lint
pnpm --filter @dawn-ai/web build
```
Expected green. Revert any `next-env.d.ts` churn.

- [ ] **Step 4: Commit, push, PR:**
```bash
git add apps/web/content/docs/testing.mdx .changeset/testing-unit-harnesses.md
git commit -m "docs: unit-testing tools and middleware; changeset"
git push -u origin feat/testing-unit-harnesses
gh pr create --base main --title "feat(testing): unit harnesses for tools, middleware, and the workspace" \
  --body "Backlog #6. Spec: docs/superpowers/specs/2026-06-16-testing-unit-harnesses-design.md. createWorkspaceHarness / createToolHarness / createMiddlewareHarness — async create*Harness factories (close() + Symbol.asyncDispose) that test tools/middleware against the real WorkspaceFs/backend over a temp dir."
```
Then enable auto-merge: `gh pr merge feat/testing-unit-harnesses --auto --squash` (report outcome).
