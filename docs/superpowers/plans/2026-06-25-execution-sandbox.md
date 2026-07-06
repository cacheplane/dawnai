# Execution Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hard, per-thread execution sandbox (fs + exec + network isolation) for the agent workspace, via a provider-agnostic contract with a Docker reference implementation, fully opt-in through `dawn.config.ts`.

**Architecture:** A `SandboxProvider` yields per-thread `{ filesystem, exec }` backends that implement the existing `@dawn-ai/workspace` interfaces, so the workspace capability consumes them unchanged. A `SandboxManager` (per-server singleton) owns the per-thread lifecycle (acquire/reuse/idle-reap/release/destroy). The CLI runtime threads `thread_id` into route prep and swaps the local backends for the thread's sandbox handle. Docker reference shells out to the `docker` CLI; an in-memory `fakeSandbox` keeps unit + wiring tests Docker-free.

**Tech Stack:** TypeScript (ESM, `node:` builtins), Vitest, Biome, pnpm fixed-group workspace, `@dawn-ai/workspace` backend interfaces, the `docker` CLI.

**Spec:** `docs/superpowers/specs/2026-06-25-execution-sandbox-design.md` — read it first.

**Package placement (verified against the dep graph; do not change without re-checking):**
- Contract **types** → `@dawn-ai/workspace` (leaf; already owns `FilesystemBackend`/`ExecBackend`; `core` already depends on it → no cycle).
- `config()` helper → `@dawn-ai/core` (co-located with `DawnConfig`; `core`→`sdk` means `config()` canNOT live in `sdk`), re-exported from `@dawn-ai/cli`.
- Provider **impl** (`dockerSandbox`, `fakeSandbox`, conformance kit) → new `@dawn-ai/sandbox` (+ `/testing` subpath).
- `SandboxManager` + runtime wiring + `dawn check` pass → `@dawn-ai/cli`.

**Conventions to mirror:** `localExec`/`localFilesystem` factory style (`packages/workspace/src/local-exec.ts`); `resolveCheckpointer`/`resolveThreadsStore` config resolution (`packages/cli/src/lib/runtime/execute-route.ts:172-203`); `collectToolScopeErrors` for the `dawn check` pass (`packages/cli/src/lib/runtime/collect-tool-scope-errors.ts`); the `isSubagent` threading precedent for `threadId` plumbing (search `isSubagent` in `execute-route.ts`). Per `feedback_gpt5_only`, any example model id uses the gpt-5 family.

---

## Phase A — Contract types + `config()` helper (no Docker)

### Task 1: Sandbox contract types in `@dawn-ai/workspace`

**Files:**
- Create: `packages/workspace/src/sandbox-types.ts`
- Modify: `packages/workspace/src/index.ts`
- Test: `packages/workspace/test/sandbox-types.test.ts`

- [ ] **Step 1: Write the failing test** (type-level + a structural smoke so the module exists)

```ts
// packages/workspace/test/sandbox-types.test.ts
import { describe, expect, test } from "vitest"
import type {
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
} from "../src/sandbox-types.ts"
import type { ExecBackend, FilesystemBackend } from "../src/types.ts"

describe("sandbox contract types", () => {
  test("a handle exposes workspace backends + an in-sandbox root", () => {
    const fs = {} as FilesystemBackend
    const exec = {} as ExecBackend
    const handle: SandboxHandle = { threadId: "t1", filesystem: fs, exec, workspaceRoot: "/workspace" }
    expect(handle.workspaceRoot).toBe("/workspace")
  })

  test("policy network is a discriminated union (allow|deny)", () => {
    const allow: SandboxPolicy["network"] = { mode: "allow", denylist: ["1.2.3.4"] }
    const deny: SandboxPolicy["network"] = { mode: "deny", allowlist: ["registry.npmjs.org"] }
    expect(allow.mode).toBe("allow")
    expect(deny.mode).toBe("deny")
  })

  test("a provider implements acquire/release/destroy", async () => {
    const provider: SandboxProvider = {
      name: "noop",
      acquire: async ({ threadId }) => ({
        threadId,
        filesystem: {} as FilesystemBackend,
        exec: {} as ExecBackend,
        workspaceRoot: "/workspace",
      }),
      release: async () => {},
      destroy: async () => {},
    }
    const h = await provider.acquire({ threadId: "t1", policy: { network: { mode: "allow" } }, signal: new AbortController().signal })
    expect(h.threadId).toBe("t1")
    const cfg: SandboxConfig = { provider }
    expect(cfg.provider.name).toBe("noop")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/workspace test sandbox-types`
Expected: FAIL — cannot find module `../src/sandbox-types.ts`.

- [ ] **Step 3: Implement the types**

```ts
// packages/workspace/src/sandbox-types.ts
/**
 * Execution-sandbox contract. A SandboxProvider yields, per conversation
 * thread, a SandboxHandle whose filesystem/exec backends implement the same
 * interfaces the workspace capability already consumes — so swapping them in
 * redirects all of readFile/writeFile/listDir/runBash into the isolated env
 * with no change to the capability. See the execution-sandbox spec.
 */
import type { ExecBackend, FilesystemBackend } from "./types.js"

export interface SandboxPolicy {
  readonly network:
    | { readonly mode: "allow"; readonly denylist?: readonly string[] }
    | { readonly mode: "deny"; readonly allowlist?: readonly string[] }
  /** Explicit env injected into the sandbox. The host env is NEVER inherited. */
  readonly env?: Readonly<Record<string, string>>
  readonly resources?: {
    readonly memoryMb?: number
    readonly cpus?: number
    readonly timeoutMs?: number
  }
}

export interface SandboxHandle {
  readonly threadId: string
  readonly filesystem: FilesystemBackend
  readonly exec: ExecBackend
  /** Absolute path of the workspace root INSIDE the sandbox, e.g. "/workspace". */
  readonly workspaceRoot: string
}

export interface SandboxProvider {
  readonly name: string
  /**
   * Create-or-reattach the thread's sandbox. Idempotent per threadId: called at
   * the start of every turn; returns the same live sandbox across turns until
   * release()/destroy(). Reattaches an existing workspace volume by deterministic
   * name after a restart or container reap rather than starting empty.
   */
  acquire(input: {
    readonly threadId: string
    readonly policy: SandboxPolicy
    readonly signal: AbortSignal
  }): Promise<SandboxHandle>
  /** Drop warm compute but KEEP the workspace volume (idle-reap + shutdown). */
  release(threadId: string): Promise<void>
  /** Destroy the sandbox AND its workspace volume (thread delete). */
  destroy(threadId: string): Promise<void>
  /** Optional availability probe surfaced by `dawn check`. */
  preflight?(): Promise<{ readonly ok: boolean; readonly detail?: string }>
}

export interface SandboxConfig {
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  /** Manager-level idle reap window. Default 600_000 (10 min). */
  readonly idleTimeoutMs?: number
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/workspace/src/index.ts`:

```ts
export type {
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
} from "./sandbox-types.js"
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @dawn-ai/workspace test sandbox-types && pnpm --filter @dawn-ai/workspace typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/workspace/src/sandbox-types.ts packages/workspace/src/index.ts packages/workspace/test/sandbox-types.test.ts
git commit -m "feat(workspace): sandbox provider contract types"
```

### Task 2: `DawnConfig.sandbox` + `config()` helper

**Files:**
- Modify: `packages/core/src/types.ts` (the `DawnConfig` interface, ~line 9-80)
- Create: `packages/core/src/config-helper.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/index.ts` (re-export `config`)
- Test: `packages/core/test/config-helper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/config-helper.test.ts
import { describe, expect, test } from "vitest"
import { config } from "../src/config-helper.ts"
import type { DawnConfig } from "../src/types.ts"

describe("config()", () => {
  test("returns the same object (identity) for IntelliSense", () => {
    const c: DawnConfig = { appDir: "src/app" }
    expect(config(c)).toBe(c)
  })

  test("accepts a sandbox key", () => {
    const provider = {
      name: "noop",
      acquire: async () => ({ threadId: "t", filesystem: {} as never, exec: {} as never, workspaceRoot: "/workspace" }),
      release: async () => {},
      destroy: async () => {},
    }
    const c = config({ sandbox: { provider, network: { mode: "deny" } } })
    expect(c.sandbox?.provider.name).toBe("noop")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/core test config-helper`
Expected: FAIL — cannot find `../src/config-helper.ts`, and `sandbox` not on `DawnConfig`.

- [ ] **Step 3: Add the `sandbox` key to `DawnConfig`**

In `packages/core/src/types.ts`, add the import (near the existing `@dawn-ai/workspace` import) and the key (alongside the other optional keys):

```ts
import type { ExecBackend, FilesystemBackend, SandboxConfig } from "@dawn-ai/workspace"
// ... inside interface DawnConfig:
  readonly sandbox?: SandboxConfig
```

- [ ] **Step 4: Implement `config()`**

```ts
// packages/core/src/config-helper.ts
import type { DawnConfig } from "./types.js"

/**
 * Typed identity helper for `dawn.config.ts`. Purely for IntelliSense — the
 * loader reads `export default`, so `export default config({...})` and a bare
 * `export default {...}` are equivalent at runtime.
 */
export function config(c: DawnConfig): DawnConfig {
  return c
}
```

- [ ] **Step 5: Export from core, re-export from cli**

`packages/core/src/index.ts`:

```ts
export { config } from "./config-helper.js"
```

`packages/cli/src/index.ts` (mirror however core symbols are already re-exported there; if `agent` is re-exported, add `config` beside it):

```ts
export { config } from "@dawn-ai/core"
```

- [ ] **Step 6: Run tests + typecheck both packages**

Run: `pnpm --filter @dawn-ai/core test config-helper && pnpm --filter @dawn-ai/core typecheck && pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config-helper.ts packages/core/src/index.ts packages/cli/src/index.ts packages/core/test/config-helper.test.ts
git commit -m "feat(core): DawnConfig.sandbox key + typed config() helper"
```

---

## Phase B — `@dawn-ai/sandbox` package: `fakeSandbox`, conformance kit, `SandboxManager`

### Task 3: Scaffold the `@dawn-ai/sandbox` package

**Files:**
- Create: `packages/sandbox/package.json`, `packages/sandbox/tsconfig.json`, `packages/sandbox/tsconfig.build.json`, `packages/sandbox/vitest.config.ts`, `packages/sandbox/src/index.ts`
- Modify: `vitest.workspace.ts` (add the project), root release config if it enumerates packages (it does not — fixed group is in `.changeset/config.json`; confirm the new pkg name is covered by the `@dawn-ai/*` patterns)

- [ ] **Step 1: Create `package.json`** (mirror `packages/workspace/package.json` — a leaf-ish lib; sandbox depends only on `@dawn-ai/workspace` for the contract types)

```jsonc
{
  "name": "@dawn-ai/sandbox",
  "version": "0.8.4",            // match the current fixed-group version at implementation time
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./testing": { "types": "./dist/testing/index.d.ts", "default": "./dist/testing/index.js" }
  },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src test tsconfig.json vitest.config.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": { "@dawn-ai/workspace": "workspace:*" },
  "devDependencies": {
    "@dawn-ai/config-biome": "workspace:*",
    "@dawn-ai/config-typescript": "workspace:*",
    "vitest": "catalog:"        // match how other packages reference vitest (check packages/workspace/package.json)
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`** by copying `packages/workspace/`'s equivalents verbatim, then adjusting any `references` to point at `../workspace`. (Open `packages/workspace/tsconfig.build.json` and replicate, adding `{ "path": "../workspace" }` to `references`.)

- [ ] **Step 3: Create a placeholder index that re-exports the contract types** (so the public type surface is importable from `@dawn-ai/sandbox` too)

```ts
// packages/sandbox/src/index.ts
export type {
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
} from "@dawn-ai/workspace"
// dockerSandbox is added in Phase E.
```

- [ ] **Step 4: Register the vitest project**

Add `"./packages/sandbox/vitest.config.ts"` to the `projects` array in `vitest.workspace.ts`.

- [ ] **Step 5: Install + build to wire the workspace**

Run: `pnpm install && pnpm --filter @dawn-ai/sandbox build`
Expected: installs the new workspace package; build emits `dist/index.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox vitest.workspace.ts pnpm-lock.yaml
git commit -m "chore(sandbox): scaffold @dawn-ai/sandbox package"
```

### Task 4: `fakeSandbox` — in-memory provider

**Files:**
- Create: `packages/sandbox/src/testing/fake-sandbox.ts`, `packages/sandbox/src/testing/index.ts`
- Test: `packages/sandbox/test/fake-sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sandbox/test/fake-sandbox.test.ts
import { describe, expect, test } from "vitest"
import { fakeSandbox } from "../src/testing/index.ts"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })

describe("fakeSandbox", () => {
  test("isolates filesystem per thread, persists across acquire (reattach)", async () => {
    const provider = fakeSandbox()
    const a1 = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    await a1.filesystem.writeFile("/workspace/note.txt", "hello", ctx(a1.workspaceRoot))

    // same thread: reattach sees the file
    const a2 = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await a2.filesystem.readFile("/workspace/note.txt", ctx(a2.workspaceRoot))).toBe("hello")

    // different thread: empty + cannot see thread a's file
    const b = await provider.acquire({ threadId: "b", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await b.filesystem.listDir("/workspace", ctx(b.workspaceRoot))).toEqual([])
  })

  test("release keeps the volume, destroy clears it", async () => {
    const provider = fakeSandbox()
    const h = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    await h.filesystem.writeFile("/workspace/f", "1", ctx(h.workspaceRoot))

    await provider.release("a") // keep volume
    const after = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await after.filesystem.readFile("/workspace/f", ctx(after.workspaceRoot))).toBe("1")

    await provider.destroy("a") // clear volume
    const fresh = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    expect(await fresh.filesystem.listDir("/workspace", ctx(fresh.workspaceRoot))).toEqual([])
  })

  test("exec is scripted + records commands; runBash sees fs writes", async () => {
    const provider = fakeSandbox({ exec: async ({ command }) => ({ stdout: `ran:${command}`, stderr: "", exitCode: 0 }) })
    const h = await provider.acquire({ threadId: "a", policy: { network: { mode: "allow" } }, signal: ctx("/x").signal })
    const r = await h.exec.runCommand({ command: "echo hi" }, ctx(h.workspaceRoot))
    expect(r).toEqual({ stdout: "ran:echo hi", stderr: "", exitCode: 0 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test fake-sandbox`
Expected: FAIL — cannot find `../src/testing/index.ts`.

- [ ] **Step 3: Implement `fakeSandbox`**

```ts
// packages/sandbox/src/testing/fake-sandbox.ts
import type {
  BackendContext,
  ExecBackend,
  FilesystemBackend,
  SandboxHandle,
  SandboxProvider,
} from "@dawn-ai/workspace"

type ExecFn = (
  args: { readonly command: string; readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  ctx: BackendContext,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>

const ROOT = "/workspace"

/** In-memory SandboxProvider for unit + wiring tests. No Docker. */
export function fakeSandbox(opts: { readonly exec?: ExecFn } = {}): SandboxProvider {
  // volume per thread: path -> content. Survives release(), cleared by destroy().
  const volumes = new Map<string, Map<string, string>>()
  const liveThreads = new Set<string>()

  const volumeFor = (threadId: string): Map<string, string> => {
    let v = volumes.get(threadId)
    if (!v) {
      v = new Map()
      volumes.set(threadId, v)
    }
    return v
  }

  const makeFilesystem = (vol: Map<string, string>): FilesystemBackend => ({
    async readFile(path) {
      const v = vol.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    async writeFile(path, content) {
      vol.set(path, content)
      return { bytesWritten: Buffer.byteLength(content) }
    },
    async listDir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`
      const names = new Set<string>()
      for (const key of vol.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!)
      }
      return [...names].sort()
    },
    async realPath(path) {
      return path
    },
  })

  const defaultExec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 })

  return {
    name: "fake",
    async acquire({ threadId }): Promise<SandboxHandle> {
      liveThreads.add(threadId)
      const vol = volumeFor(threadId)
      const exec: ExecBackend = { runCommand: (args, ctx) => (opts.exec ?? defaultExec)(args, ctx) }
      return { threadId, filesystem: makeFilesystem(vol), exec, workspaceRoot: ROOT }
    },
    async release(threadId) {
      liveThreads.delete(threadId) // keep the volume
    },
    async destroy(threadId) {
      liveThreads.delete(threadId)
      volumes.delete(threadId)
    },
    async preflight() {
      return { ok: true }
    },
  }
}
```

```ts
// packages/sandbox/src/testing/index.ts
export { fakeSandbox } from "./fake-sandbox.js"
// runProviderConformance is added in Task 5.
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @dawn-ai/sandbox test fake-sandbox`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/testing packages/sandbox/test/fake-sandbox.test.ts
git commit -m "feat(sandbox): in-memory fakeSandbox provider for tests"
```

### Task 5: Provider conformance kit

**Files:**
- Create: `packages/sandbox/src/testing/conformance.ts`
- Modify: `packages/sandbox/src/testing/index.ts`
- Test: `packages/sandbox/test/conformance-fake.test.ts`

- [ ] **Step 1: Write the failing test** (run the kit against `fakeSandbox`)

```ts
// packages/sandbox/test/conformance-fake.test.ts
import { describe } from "vitest"
import { fakeSandbox, runProviderConformance } from "../src/testing/index.ts"

runProviderConformance({
  name: "fakeSandbox",
  makeProvider: () => fakeSandbox(),
  describe,
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test conformance-fake`
Expected: FAIL — `runProviderConformance` is not exported.

- [ ] **Step 3: Implement the conformance kit**

```ts
// packages/sandbox/src/testing/conformance.ts
import { expect, test } from "vitest"
import type { SandboxProvider } from "@dawn-ai/workspace"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const policy = { network: { mode: "allow" } } as const

/**
 * The contract every SandboxProvider must satisfy. Reused by fakeSandbox (CI)
 * and dockerSandbox (gated Docker lane) so the fake cannot drift from reality.
 * Pass vitest's `describe` so the kit can group under any runner.
 */
export function runProviderConformance(opts: {
  readonly name: string
  readonly makeProvider: () => SandboxProvider
  readonly describe: (name: string, fn: () => void) => void
}): void {
  opts.describe(`SandboxProvider conformance: ${opts.name}`, () => {
    test("acquire is idempotent per thread and reattaches the workspace", async () => {
      const p = opts.makeProvider()
      const a = await p.acquire({ threadId: "t1", policy, signal: ctx("/").signal })
      await a.filesystem.writeFile(`${a.workspaceRoot}/x`, "1", ctx(a.workspaceRoot))
      const b = await p.acquire({ threadId: "t1", policy, signal: ctx("/").signal })
      expect(await b.filesystem.readFile(`${b.workspaceRoot}/x`, ctx(b.workspaceRoot))).toBe("1")
      await p.destroy("t1")
    })

    test("threads are isolated", async () => {
      const p = opts.makeProvider()
      const a = await p.acquire({ threadId: "a", policy, signal: ctx("/").signal })
      await a.filesystem.writeFile(`${a.workspaceRoot}/secret`, "s", ctx(a.workspaceRoot))
      const b = await p.acquire({ threadId: "b", policy, signal: ctx("/").signal })
      expect(await b.filesystem.listDir(b.workspaceRoot, ctx(b.workspaceRoot))).not.toContain("secret")
      await p.destroy("a")
      await p.destroy("b")
    })

    test("release keeps the volume, destroy clears it", async () => {
      const p = opts.makeProvider()
      const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
      await a.filesystem.writeFile(`${a.workspaceRoot}/keep`, "1", ctx(a.workspaceRoot))
      await p.release("t")
      const r = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
      expect(await r.filesystem.readFile(`${r.workspaceRoot}/keep`, ctx(r.workspaceRoot))).toBe("1")
      await p.destroy("t")
      const d = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
      expect(await d.filesystem.listDir(d.workspaceRoot, ctx(d.workspaceRoot))).not.toContain("keep")
      await p.destroy("t")
    })

    test("exec returns a numeric exit code", async () => {
      const p = opts.makeProvider()
      const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
      const r = await a.exec.runCommand({ command: "true" }, ctx(a.workspaceRoot))
      expect(typeof r.exitCode).toBe("number")
      await p.destroy("t")
    })
  })
}
```

Add to `packages/sandbox/src/testing/index.ts`:

```ts
export { runProviderConformance } from "./conformance.js"
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @dawn-ai/sandbox test conformance-fake`
Expected: PASS (4 conformance tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/testing/conformance.ts packages/sandbox/src/testing/index.ts packages/sandbox/test/conformance-fake.test.ts
git commit -m "feat(sandbox): provider conformance kit"
```

### Task 6: `SandboxManager` (per-thread lifecycle)

**Files:**
- Create: `packages/cli/src/lib/runtime/sandbox-manager.ts`
- Test: `packages/cli/src/lib/runtime/sandbox-manager.test.ts`
- Note: `@dawn-ai/cli` must add `@dawn-ai/sandbox` as a **devDependency** (the manager only needs the contract types from `@dawn-ai/workspace`, which cli gets transitively via core; `@dawn-ai/sandbox` is a devDep so tests can import `fakeSandbox`).

- [ ] **Step 1: Add `@dawn-ai/sandbox` devDep to cli**

In `packages/cli/package.json` `devDependencies`: `"@dawn-ai/sandbox": "workspace:*"`, then `pnpm install`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/cli/src/lib/runtime/sandbox-manager.test.ts
import { describe, expect, test, vi } from "vitest"
import { fakeSandbox } from "@dawn-ai/sandbox/testing"
import type { SandboxProvider } from "@dawn-ai/workspace"
import { SandboxManager } from "./sandbox-manager.ts"

const policy = { network: { mode: "allow" } } as const
const signal = () => new AbortController().signal
const now = { t: 1_000 }
const clock = () => now.t

describe("SandboxManager", () => {
  test("reuses one handle across turns for a thread", async () => {
    const provider = fakeSandbox()
    const acquire = vi.spyOn(provider, "acquire")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    const h1 = await mgr.getForThread("t1", signal())
    const h2 = await mgr.getForThread("t1", signal())
    expect(h1).toBe(h2)
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  test("dedups concurrent acquires for the same thread", async () => {
    const provider = fakeSandbox()
    const acquire = vi.spyOn(provider, "acquire")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    const [a, b] = await Promise.all([mgr.getForThread("t1", signal()), mgr.getForThread("t1", signal())])
    expect(a).toBe(b)
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  test("reapIdle releases (not destroys) idle threads, keeping the volume", async () => {
    const provider = fakeSandbox()
    const release = vi.spyOn(provider, "release")
    const destroy = vi.spyOn(provider, "destroy")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    await mgr.getForThread("t1", signal())
    now.t = 25_000 // advance past idle window
    await mgr.reapIdle()
    expect(release).toHaveBeenCalledWith("t1")
    expect(destroy).not.toHaveBeenCalled()
    // next turn re-acquires
    await mgr.getForThread("t1", signal())
  })

  test("does not reap an in-flight (in-use) thread", async () => {
    const provider = fakeSandbox()
    const release = vi.spyOn(provider, "release")
    let resolveAcquire!: () => void
    vi.spyOn(provider, "acquire").mockImplementation(
      () => new Promise((r) => { resolveAcquire = () => r({ threadId: "t1", filesystem: {} as never, exec: {} as never, workspaceRoot: "/workspace" }) }),
    )
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 1, clock })
    const inflight = mgr.getForThread("t1", signal())
    now.t = 1_000_000
    await mgr.reapIdle()
    expect(release).not.toHaveBeenCalled()
    resolveAcquire()
    await inflight
  })

  test("releaseThread destroys + drops the entry", async () => {
    const provider = fakeSandbox()
    const destroy = vi.spyOn(provider, "destroy")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    await mgr.getForThread("t1", signal())
    await mgr.destroyThread("t1")
    expect(destroy).toHaveBeenCalledWith("t1")
  })

  test("releaseAll releases every live thread", async () => {
    const provider = fakeSandbox()
    const release = vi.spyOn(provider, "release")
    const mgr = new SandboxManager({ provider, policy, idleTimeoutMs: 10_000, clock })
    await mgr.getForThread("a", signal())
    await mgr.getForThread("b", signal())
    await mgr.releaseAll()
    expect(release.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"])
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/cli test sandbox-manager`
Expected: FAIL — cannot find `./sandbox-manager.ts`.

- [ ] **Step 4: Implement `SandboxManager`**

```ts
// packages/cli/src/lib/runtime/sandbox-manager.ts
import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"

interface Entry {
  handle?: SandboxHandle
  acquiring?: Promise<SandboxHandle>
  lastUsedAt: number
  inUse: number
}

/**
 * Owns the per-thread sandbox lifecycle. One instance per server process.
 * - getForThread: create-or-reuse the thread's handle (concurrent acquires deduped).
 * - reapIdle: release() warm compute for threads idle past idleTimeoutMs (volume kept).
 * - destroyThread: full teardown (volume removed) — thread delete.
 * - releaseAll: shutdown — release() everything (volume kept).
 */
export class SandboxManager {
  readonly #provider: SandboxProvider
  readonly #policy: SandboxPolicy
  readonly #idleTimeoutMs: number
  readonly #clock: () => number
  readonly #entries = new Map<string, Entry>()

  constructor(opts: {
    provider: SandboxProvider
    policy: SandboxPolicy
    idleTimeoutMs: number
    clock?: () => number
  }) {
    this.#provider = opts.provider
    this.#policy = opts.policy
    this.#idleTimeoutMs = opts.idleTimeoutMs
    this.#clock = opts.clock ?? Date.now
  }

  async getForThread(threadId: string, signal: AbortSignal): Promise<SandboxHandle> {
    const existing = this.#entries.get(threadId)
    if (existing?.handle) {
      existing.lastUsedAt = this.#clock()
      existing.inUse += 1
      try {
        return existing.handle
      } finally {
        existing.inUse -= 1
      }
    }
    if (existing?.acquiring) return existing.acquiring

    const entry: Entry = { lastUsedAt: this.#clock(), inUse: 1 }
    this.#entries.set(threadId, entry)
    entry.acquiring = this.#provider
      .acquire({ threadId, policy: this.#policy, signal })
      .then((handle) => {
        entry.handle = handle
        entry.acquiring = undefined
        entry.lastUsedAt = this.#clock()
        return handle
      })
      .catch((err) => {
        this.#entries.delete(threadId) // never cache a failed acquire
        throw err
      })
      .finally(() => {
        entry.inUse -= 1
      })
    return entry.acquiring
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.#clock() - this.#idleTimeoutMs
    for (const [threadId, entry] of [...this.#entries]) {
      if (entry.inUse > 0 || entry.acquiring) continue
      if (entry.lastUsedAt > cutoff) continue
      this.#entries.delete(threadId)
      await this.#provider.release(threadId) // keep the volume
    }
  }

  async destroyThread(threadId: string): Promise<void> {
    this.#entries.delete(threadId)
    await this.#provider.destroy(threadId)
  }

  async releaseAll(): Promise<void> {
    const ids = [...this.#entries.keys()]
    this.#entries.clear()
    await Promise.all(ids.map((id) => this.#provider.release(id)))
  }
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @dawn-ai/cli test sandbox-manager && pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json packages/cli/src/lib/runtime/sandbox-manager.ts packages/cli/src/lib/runtime/sandbox-manager.test.ts pnpm-lock.yaml
git commit -m "feat(cli): SandboxManager per-thread lifecycle"
```

---

## Phase C — Runtime wiring

### Task 7: Resolve the manager from config + thread the handle into route prep

**Files:**
- Create: `packages/cli/src/lib/runtime/resolve-sandbox.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (the `streamResolvedRoute`/`executeResolvedRoute`/`prepareRouteExecution` chain + backend construction sites at ~441-450, ~491-497, ~548-556)
- Test: `packages/cli/src/lib/runtime/resolve-sandbox.test.ts`

- [ ] **Step 1: Write the failing test for `resolveSandboxManager`**

```ts
// packages/cli/src/lib/runtime/resolve-sandbox.test.ts
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { resolveSandboxManager } from "./resolve-sandbox.ts"

const dirs: string[] = []
afterEach(async () => { /* tmp dirs auto-clean by OS; nothing to do */ })

describe("resolveSandboxManager", () => {
  test("returns undefined when no dawn.config.ts / no sandbox key", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-sbx-cfg-"))
    dirs.push(appRoot)
    expect(await resolveSandboxManager(appRoot)).toBeUndefined()
  })

  test("builds a manager from config.sandbox.provider", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-sbx-cfg-"))
    dirs.push(appRoot)
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      [
        `import { fakeSandbox } from "@dawn-ai/sandbox/testing"`,
        `export default { sandbox: { provider: fakeSandbox(), network: { mode: "deny" } } }`,
      ].join("\n"),
      "utf8",
    )
    const mgr = await resolveSandboxManager(appRoot)
    expect(mgr).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/cli test resolve-sandbox`
Expected: FAIL — cannot find `./resolve-sandbox.ts`.

- [ ] **Step 3: Implement `resolveSandboxManager`** (mirrors `resolveCheckpointer`, `execute-route.ts:189-203`)

```ts
// packages/cli/src/lib/runtime/resolve-sandbox.ts
import { loadDawnConfig } from "@dawn-ai/core"
import type { SandboxPolicy } from "@dawn-ai/workspace"
import { SandboxManager } from "./sandbox-manager.js"

const DEFAULT_IDLE_MS = 600_000
const DEFAULT_NETWORK: SandboxPolicy["network"] = { mode: "allow", denylist: ["169.254.169.254"] }

/** Build the per-server SandboxManager from dawn.config.ts, or undefined if unconfigured. */
export async function resolveSandboxManager(appRoot: string): Promise<SandboxManager | undefined> {
  let sandbox: import("@dawn-ai/workspace").SandboxConfig | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    sandbox = loaded.config.sandbox
  } catch {
    return undefined // no dawn.config.ts
  }
  if (!sandbox) return undefined
  const policy: SandboxPolicy = {
    network: sandbox.network ?? DEFAULT_NETWORK,
    ...(sandbox.env ? { env: sandbox.env } : {}),
    ...(sandbox.resources ? { resources: sandbox.resources } : {}),
  }
  return new SandboxManager({
    provider: sandbox.provider,
    policy,
    idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
  })
}
```

- [ ] **Step 4: Thread `threadId` + `sandboxManager` into route prep**

In `execute-route.ts`:
1. Add `readonly sandboxManager?: SandboxManager` and ensure `readonly threadId?: string` to the options of `streamResolvedRoute`, `executeResolvedRoute`, and `prepareRouteExecution` (search the existing `threadId` option on `streamResolvedRoute` ~line 248 and the `isSubagent` option to copy the threading pattern). Pass both from `streamResolvedRoute`/`executeResolvedRoute` down into `prepareRouteExecution`.
2. Inside `prepareRouteExecution`, BEFORE building backends (before `loadDawnConfig`/`configBackends` at ~441 and `createWorkspaceFs` at ~491), resolve the handle when both are present:

```ts
// inside prepareRouteExecution, after options are in scope
let sandboxBackends: { filesystem: FilesystemBackend; exec: ExecBackend } | undefined
let sandboxWorkspaceRoot: string | undefined
if (options.sandboxManager && options.threadId) {
  const handle = await options.sandboxManager.getForThread(
    options.threadId,
    options.signal ?? new AbortController().signal,
  )
  sandboxBackends = { filesystem: handle.filesystem, exec: handle.exec }
  sandboxWorkspaceRoot = handle.workspaceRoot
}
```

3. At each backend-construction site, prefer the sandbox handle:
   - `createWorkspaceFs` (~491): `workspaceRoot: sandboxWorkspaceRoot ?? join(options.appRoot, "workspace")`, `backend: sandboxBackends?.filesystem ?? configBackends?.filesystem ?? localFilesystem()`.
   - `applyCapabilities` backends (~552): pass `backends: sandboxBackends ?? configBackends` (the workspace capability also reads `workspaceRoot` from `context.appRoot` today; if the capability computes the host `workspace/` dir from `appRoot`, additionally thread `sandboxWorkspaceRoot` through `CapabilityMarkerContext` — see Step 5).
   - offload store (~1091): `backend: sandboxBackends?.filesystem ?? filesystem ?? localFilesystem()`.

- [ ] **Step 5: Thread the in-sandbox `workspaceRoot` into the workspace capability**

The workspace marker computes `workspaceRoot(context.appRoot)` (host `<appRoot>/workspace`) in `packages/core/src/capabilities/built-in/workspace.ts:121-123`. Add an optional `workspaceRoot?: string` to `CapabilityMarkerContext` (`packages/core/src/capabilities/types.ts`) and, in the workspace marker, prefer it: `const root = context.workspaceRoot ?? workspaceRoot(context.appRoot)`. When sandboxed, `detect` must return `true` without a host `existsSync` check — gate the `existsSync` on `context.workspaceRoot` being absent:

```ts
detect: async (_routeDir, context) =>
  context.workspaceRoot !== undefined || existsSync(workspaceRoot(context.appRoot)),
load: async (_routeDir, context) => {
  const root = context.workspaceRoot ?? workspaceRoot(context.appRoot)
  if (context.workspaceRoot === undefined && !existsSync(root)) return {}
  const fs = context.backends?.filesystem ?? localFilesystem()
  const exec = context.backends?.exec ?? localExec()
  // ...unchanged
}
```

Pass `...(sandboxWorkspaceRoot ? { workspaceRoot: sandboxWorkspaceRoot } : {})` in the `applyCapabilities` context object.

- [ ] **Step 6: Run typecheck + the resolve test**

Run: `pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/core typecheck && pnpm --filter @dawn-ai/cli test resolve-sandbox`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/src/lib/runtime/resolve-sandbox.test.ts packages/cli/src/lib/runtime/execute-route.ts packages/core/src/capabilities/built-in/workspace.ts packages/core/src/capabilities/types.ts
git commit -m "feat(cli): resolve sandbox manager + route the workspace into the thread sandbox"
```

### Task 8: Server singleton + DELETE/shutdown hooks + idle reaper

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts` (`createRuntimeRequestListener` ~54-76; DELETE handler ~268-285; `close()` ~107-133)
- Modify: `packages/cli/src/lib/runtime/build-route-table.ts` (wherever `buildRouteTable` threads singletons + calls `streamResolvedRoute`/`executeResolvedRoute` — pass `sandboxManager` + `threadId`)
- Test: covered by Task 10's wiring e2e (a unit test of the server lifecycle would require booting the server; the DELETE/shutdown hooks are asserted via the e2e + a focused manager test already exists).

- [ ] **Step 1: Build the manager singleton + reaper in `createRuntimeRequestListener`**

After `threadsStore`/`checkpointer` are resolved (~60), add:

```ts
const sandboxManager = await resolveSandboxManager(options.appRoot)
let reaper: ReturnType<typeof setInterval> | undefined
if (sandboxManager) {
  reaper = setInterval(() => { void sandboxManager.reapIdle() }, 60_000)
  reaper.unref?.()
}
```

Pass `sandboxManager` into `buildRouteTable({ ..., sandboxManager })`.

- [ ] **Step 2: Thread `sandboxManager` + `threadId` through `buildRouteTable` into the run handlers**

In `build-route-table.ts`, accept `sandboxManager` and pass `{ sandboxManager, threadId }` into every `streamResolvedRoute`/`executeResolvedRoute` call (the `runs/stream` and `runs/wait` handlers already extract `thread_id`).

- [ ] **Step 3: Hook DELETE → `destroyThread`**

In the `DELETE /threads/{id}` handler (`runtime-server.ts:268-285`), before `res.writeHead(204)`:

```ts
if (sandboxManager) await sandboxManager.destroyThread(threadId)
```

- [ ] **Step 4: Hook shutdown → `releaseAll`**

In `close()` (~107-133), after `shutdownController.abort(...)` and BEFORE the drain loop returns, add:

```ts
if (reaper) clearInterval(reaper)
if (sandboxManager) await sandboxManager.releaseAll()
```

- [ ] **Step 5: Typecheck + boot smoke**

Run: `pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS. (Behavioral coverage is Task 10.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/runtime-server.ts packages/cli/src/lib/runtime/build-route-table.ts
git commit -m "feat(cli): sandbox manager singleton, DELETE/shutdown hooks, idle reaper"
```

### Task 9: Wiring e2e via `@dawn-ai/testing` + `fakeSandbox`

**Files:**
- Create: `test/runtime/run-sandbox-wiring.test.ts`
- Create: `test/runtime/fixtures/sandbox-app/` (a minimal app with a `workspace/` route that writes + reads a file and runs a command)
- Modify: `test/runtime/vitest.config.ts` (add the test to `include`)

- [ ] **Step 1: Write the failing aimock e2e**

Build a fixture app whose route, on a user turn, calls `writeFile` then `readFile` then `runBash`. Configure `dawn.config.ts` with `sandbox: { provider: fakeSandbox() }`. Drive it through the in-process harness (`createAgentHarness` / the aimock runner used by `test/runtime/run-tool-scope.test.ts` — copy that test's setup). Assert:

```ts
// test/runtime/run-sandbox-wiring.test.ts  (skeleton; mirror run-tool-scope.test.ts for harness setup)
import { describe, expect, test } from "vitest"
// ...harness imports identical to run-tool-scope.test.ts...

describe("sandbox wiring", () => {
  test("workspace tools route through the sandbox handle (not localExec)", async () => {
    // 1. scaffold/point harness at test/runtime/fixtures/sandbox-app with a fakeSandbox spy provider
    // 2. run a turn that writes "report.md" then runs "echo hi"
    // 3. assert the file is readable back through the SAME provider's volume
    //    and NOT present on the host <appRoot>/workspace dir
    // 4. assert a second thread sees an empty workspace (isolation)
  })
})
```

Use a `fakeSandbox` whose `exec` records commands and whose volume you can inspect after the run (export a test variant that returns the volume map, or assert via a second `acquire` on the same threadId).

- [ ] **Step 2: Run to verify it fails** (before wiring is correct it will not isolate)

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts run-sandbox-wiring`
Expected: FAIL.

- [ ] **Step 3: Make it pass** — fix any wiring gaps surfaced (threadId propagation, capability `workspaceRoot`).

- [ ] **Step 4: Run + false-green check** — temporarily break the wiring (force `localExec`) and confirm the test FAILS, then restore.

Run: `pnpm exec vitest --run --config test/runtime/vitest.config.ts run-sandbox-wiring`
Expected: PASS (and proven non-trivial via the false-green check).

- [ ] **Step 5: Commit**

```bash
git add test/runtime/run-sandbox-wiring.test.ts test/runtime/fixtures/sandbox-app test/runtime/vitest.config.ts
git commit -m "test(runtime): sandbox wiring e2e via fakeSandbox (no Docker)"
```

---

## Phase D — `dawn check`

### Task 10: Sandbox config validation + preflight pass

**Files:**
- Create: `packages/cli/src/lib/runtime/collect-sandbox-errors.ts`
- Modify: `packages/cli/src/commands/check.ts` (~13-53; add a pass after the tool-scope pass)
- Test: `packages/cli/src/lib/runtime/collect-sandbox-errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/lib/runtime/collect-sandbox-errors.test.ts
import { describe, expect, test } from "vitest"
import { collectSandboxErrors } from "./collect-sandbox-errors.ts"

describe("collectSandboxErrors", () => {
  test("no sandbox config → no errors", async () => {
    expect(await collectSandboxErrors({})).toEqual([])
  })

  test("provider missing acquire → error", async () => {
    const errors = await collectSandboxErrors({ sandbox: { provider: { name: "bad" } as never } })
    expect(errors.join("\n")).toMatch(/acquire/)
  })

  test("preflight failure → error with detail", async () => {
    const provider = {
      name: "p", acquire: async () => ({}) as never, release: async () => {}, destroy: async () => {},
      preflight: async () => ({ ok: false, detail: "Docker daemon not reachable" }),
    }
    const errors = await collectSandboxErrors({ sandbox: { provider } })
    expect(errors.join("\n")).toMatch(/Docker daemon not reachable/)
  })

  test("healthy provider → no errors", async () => {
    const provider = {
      name: "p", acquire: async () => ({}) as never, release: async () => {}, destroy: async () => {},
      preflight: async () => ({ ok: true }),
    }
    expect(await collectSandboxErrors({ sandbox: { provider } })).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/cli test collect-sandbox-errors`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `collectSandboxErrors`**

```ts
// packages/cli/src/lib/runtime/collect-sandbox-errors.ts
import type { DawnConfig } from "@dawn-ai/core"

/** Validate the dawn.config.ts sandbox block + run the provider preflight. */
export async function collectSandboxErrors(config: Pick<DawnConfig, "sandbox">): Promise<readonly string[]> {
  const sandbox = config.sandbox
  if (!sandbox) return []
  const errors: string[] = []
  const p = sandbox.provider as Partial<import("@dawn-ai/workspace").SandboxProvider> | undefined
  if (!p || typeof p.acquire !== "function" || typeof p.release !== "function" || typeof p.destroy !== "function") {
    errors.push(`dawn.config sandbox.provider must implement acquire/release/destroy (got: ${p?.name ?? "undefined"}).`)
    return errors
  }
  if (typeof p.preflight === "function") {
    try {
      const result = await p.preflight()
      if (!result.ok) errors.push(`Sandbox provider "${p.name}" preflight failed: ${result.detail ?? "unavailable"}.`)
    } catch (error) {
      errors.push(`Sandbox provider "${p.name}" preflight threw: ${error instanceof Error ? error.message : String(error)}.`)
    }
  }
  return errors
}
```

- [ ] **Step 4: Wire into `dawn check`**

In `packages/cli/src/commands/check.ts`, after the tool-scope pass (~45-48), load the config once and run the pass (mirror how the config is already loaded for other passes; if check doesn't load config yet, add a `loadDawnConfig` guarded by try/catch returning `{}`):

```ts
const sandboxErrors = await collectSandboxErrors(loadedConfig ?? {})
if (sandboxErrors.length > 0) throw new CliError(sandboxErrors.join("\n"))
```

- [ ] **Step 5: Run tests + a manual check smoke**

Run: `pnpm --filter @dawn-ai/cli test collect-sandbox-errors && pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/collect-sandbox-errors.ts packages/cli/src/lib/runtime/collect-sandbox-errors.test.ts packages/cli/src/commands/check.ts
git commit -m "feat(cli): dawn check validates sandbox config + runs provider preflight"
```

---

## Phase E — Docker reference provider

### Task 11: `docker` CLI wrapper

**Files:**
- Create: `packages/sandbox/src/docker/docker-cli.ts`
- Test: `packages/sandbox/test/docker-cli.test.ts`

- [ ] **Step 1: Write the failing test** (inject a fake spawner so the unit test needs no Docker)

```ts
// packages/sandbox/test/docker-cli.test.ts
import { describe, expect, test } from "vitest"
import { createDocker } from "../src/docker/docker-cli.ts"

describe("createDocker", () => {
  test("runs docker with args, returns stdout/exit", async () => {
    const calls: string[][] = []
    const docker = createDocker({
      spawn: async (args, _opts) => { calls.push(args); return { stdout: "ok", stderr: "", exitCode: 0 } },
    })
    const r = await docker.run(["ps", "-q"])
    expect(r.stdout).toBe("ok")
    expect(calls[0]).toEqual(["ps", "-q"])
  })

  test("execInto pipes stdin and targets a container", async () => {
    const seen: { args: string[]; stdin?: string }[] = []
    const docker = createDocker({
      spawn: async (args, opts) => { seen.push({ args, stdin: opts?.stdin }); return { stdout: "", stderr: "", exitCode: 0 } },
    })
    await docker.exec("c1", ["sh", "-c", "cat > /workspace/f"], { stdin: "data" })
    expect(seen[0]!.args.slice(0, 2)).toEqual(["exec", "-i"])
    expect(seen[0]!.args).toContain("c1")
    expect(seen[0]!.stdin).toBe("data")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test docker-cli`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `createDocker`** (default spawner uses `node:child_process`; injectable for tests)

```ts
// packages/sandbox/src/docker/docker-cli.ts
import { spawn } from "node:child_process"

export interface SpawnResult { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
export type Spawner = (
  args: readonly string[],
  opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
) => Promise<SpawnResult>

const defaultSpawn: Spawner = (args, opts) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn("docker", [...args], { stdio: ["pipe", "pipe", "pipe"], ...(opts?.signal ? { signal: opts.signal } : {}) })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => { stdout += String(c) })
    child.stderr.on("data", (c) => { stderr += String(c) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
    if (opts?.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
  })

export interface Docker {
  run(args: readonly string[], opts?: { signal?: AbortSignal }): Promise<SpawnResult>
  exec(container: string, command: readonly string[], opts?: { stdin?: string; signal?: AbortSignal }): Promise<SpawnResult>
}

export function createDocker(deps: { spawn?: Spawner } = {}): Docker {
  const sp = deps.spawn ?? defaultSpawn
  return {
    run: (args, opts) => sp(args, opts),
    exec: (container, command, opts) =>
      sp(["exec", "-i", container, ...command], opts),
  }
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @dawn-ai/sandbox test docker-cli` → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/docker/docker-cli.ts packages/sandbox/test/docker-cli.test.ts
git commit -m "feat(sandbox): injectable docker CLI wrapper"
```

### Task 12: Docker filesystem + exec backends

**Files:**
- Create: `packages/sandbox/src/docker/docker-filesystem.ts`, `packages/sandbox/src/docker/docker-exec.ts`
- Test: `packages/sandbox/test/docker-backends.test.ts` (uses an injected fake `Docker`, no real daemon)

- [ ] **Step 1: Write the failing test**

```ts
// packages/sandbox/test/docker-backends.test.ts
import { describe, expect, test } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerExec } from "../src/docker/docker-exec.ts"
import { dockerFilesystem } from "../src/docker/docker-filesystem.ts"

const ctx = { signal: new AbortController().signal, workspaceRoot: "/workspace" }
const fakeDocker = (handlers: Partial<Docker>): Docker => ({
  run: handlers.run ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  exec: handlers.exec ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
})

describe("dockerFilesystem", () => {
  test("readFile cats inside the container", async () => {
    const fs = dockerFilesystem(fakeDocker({ exec: async (_c, cmd) => ({ stdout: cmd.join(" ").includes("cat") ? "file-body" : "", stderr: "", exitCode: 0 }) }), "c1")
    expect(await fs.readFile("/workspace/a.txt", ctx)).toBe("file-body")
  })
  test("writeFile pipes content via stdin", async () => {
    let stdin: string | undefined
    const fs = dockerFilesystem(fakeDocker({ exec: async (_c, _cmd, opts) => { stdin = opts?.stdin; return { stdout: "", stderr: "", exitCode: 0 } } }), "c1")
    const r = await fs.writeFile("/workspace/a.txt", "hello", ctx)
    expect(stdin).toBe("hello")
    expect(r.bytesWritten).toBe(5)
  })
  test("listDir parses ls -1 output", async () => {
    const fs = dockerFilesystem(fakeDocker({ exec: async () => ({ stdout: "a\nb\n", stderr: "", exitCode: 0 }) }), "c1")
    expect(await fs.listDir("/workspace", ctx)).toEqual(["a", "b"])
  })
})

describe("dockerExec", () => {
  test("runCommand runs sh -c inside the container", async () => {
    const exec = dockerExec(fakeDocker({ exec: async (_c, cmd) => ({ stdout: cmd.join(" "), stderr: "", exitCode: 0 }) }), "c1")
    const r = await exec.runCommand({ command: "echo hi" }, ctx)
    expect(r.stdout).toContain("echo hi")
    expect(r.exitCode).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @dawn-ai/sandbox test docker-backends` → FAIL.

- [ ] **Step 3: Implement the backends**

```ts
// packages/sandbox/src/docker/docker-exec.ts
import type { BackendContext, ExecBackend } from "@dawn-ai/workspace"
import type { Docker } from "./docker-cli.js"

export function dockerExec(docker: Docker, container: string): ExecBackend {
  return {
    async runCommand(args, ctx: BackendContext) {
      const envPrefix = args.env
        ? Object.entries(args.env).map(([k, v]) => `${k}=${shellQuote(v)} `).join("")
        : ""
      const cdPrefix = args.cwd ? `cd ${shellQuote(args.cwd)} && ` : ""
      const r = await docker.exec(container, ["sh", "-c", `${envPrefix}${cdPrefix}${args.command}`], { signal: ctx.signal })
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
    },
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}
```

```ts
// packages/sandbox/src/docker/docker-filesystem.ts
import type { BackendContext, FilesystemBackend } from "@dawn-ai/workspace"
import type { Docker } from "./docker-cli.js"

function q(s: string): string { return `'${s.replaceAll("'", `'\\''`)}'` }

export function dockerFilesystem(docker: Docker, container: string): FilesystemBackend {
  const run = (cmd: string, ctx: BackendContext, stdin?: string) =>
    docker.exec(container, ["sh", "-c", cmd], { ...(stdin !== undefined ? { stdin } : {}), signal: ctx.signal })
  return {
    async readFile(path, ctx) {
      const r = await run(`cat ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr.trim()}`)
      return r.stdout
    },
    async writeFile(path, content, ctx) {
      const r = await run(`cat > ${q(path)}`, ctx, content)
      if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr.trim()}`)
      return { bytesWritten: Buffer.byteLength(content) }
    },
    async listDir(path, ctx) {
      const r = await run(`ls -1 ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`listDir failed: ${r.stderr.trim()}`)
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    },
    async realPath(path, ctx) {
      const r = await run(`realpath -m ${q(path)}`, ctx)
      return r.exitCode === 0 ? r.stdout.trim() : path
    },
    async statFile(path, ctx) {
      const r = await run(`stat -c '%s %Y' ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`statFile failed: ${r.stderr.trim()}`)
      const [size, mtime] = r.stdout.trim().split(" ")
      return { size: Number(size), mtimeMs: Number(mtime) * 1000 }
    },
    async removeFile(path, ctx) { await run(`rm -f ${q(path)}`, ctx) },
    async touchFile(path, ctx) { await run(`touch ${q(path)}`, ctx) },
    async mkdir(path, ctx) { await run(`mkdir -p ${q(path)}`, ctx) },
  }
}
```

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/docker/docker-filesystem.ts packages/sandbox/src/docker/docker-exec.ts packages/sandbox/test/docker-backends.test.ts
git commit -m "feat(sandbox): docker filesystem + exec backends"
```

### Task 13: `dockerSandbox` provider

**Files:**
- Create: `packages/sandbox/src/docker/docker-sandbox.ts`
- Modify: `packages/sandbox/src/index.ts` (export `dockerSandbox`)
- Test: `packages/sandbox/test/docker-sandbox.unit.test.ts` (injected fake `Docker`; asserts lifecycle commands — no daemon)

- [ ] **Step 1: Write the failing unit test** (assert the docker commands acquire/release/destroy emit)

```ts
// packages/sandbox/test/docker-sandbox.unit.test.ts
import { describe, expect, test } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerSandbox } from "../src/docker/docker-sandbox.ts"

function recordingDocker(): { docker: Docker; runs: string[][] } {
  const runs: string[][] = []
  const docker: Docker = {
    run: async (args) => {
      runs.push([...args])
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 } // not running
      return { stdout: "ok", stderr: "", exitCode: 0 }
    },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  }
  return { docker, runs }
}

describe("dockerSandbox (unit, no daemon)", () => {
  const policy = { network: { mode: "deny" } } as const
  test("acquire runs a container named for the thread + names a volume", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    const h = await p.acquire({ threadId: "abc", policy, signal: new AbortController().signal })
    expect(h.workspaceRoot).toBe("/workspace")
    const runCmd = runs.find((r) => r[0] === "run")!
    expect(runCmd.join(" ")).toContain("dawn-sbx-abc")
    expect(runCmd.join(" ")).toContain("dawn-sbx-vol-abc")
    expect(runCmd.join(" ")).toContain("--network")
    expect(runCmd.join(" ")).toContain("none") // deny → --network none
  })
  test("release removes container but not volume; destroy removes both", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy, signal: new AbortController().signal })
    await p.release("abc")
    expect(runs.some((r) => r[0] === "rm" && r.includes("dawn-sbx-abc"))).toBe(true)
    expect(runs.some((r) => r[0] === "volume" && r[1] === "rm")).toBe(false)
    await p.destroy("abc")
    expect(runs.some((r) => r[0] === "volume" && r[1] === "rm" && r.includes("dawn-sbx-vol-abc"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement `dockerSandbox`**

```ts
// packages/sandbox/src/docker/docker-sandbox.ts
import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"
import { createDocker, type Docker } from "./docker-cli.js"
import { dockerExec } from "./docker-exec.js"
import { dockerFilesystem } from "./docker-filesystem.js"

const ROOT = "/workspace"
const containerName = (threadId: string) => `dawn-sbx-${sanitize(threadId)}`
const volumeName = (threadId: string) => `dawn-sbx-vol-${sanitize(threadId)}`
const sanitize = (s: string) => s.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")

export interface DockerSandboxOptions {
  readonly image: string
  /** Injected for tests; defaults to the real docker CLI. */
  readonly docker?: Docker
}

export function dockerSandbox(opts: DockerSandboxOptions): SandboxProvider {
  const docker = opts.docker ?? createDocker()

  const ensureContainer = async (threadId: string, policy: SandboxPolicy, signal: AbortSignal): Promise<string> => {
    const name = containerName(threadId)
    const running = await docker.run(["ps", "-q", "--filter", `name=^${name}$`], { signal })
    if (running.stdout.trim()) return name
    const existing = await docker.run(["ps", "-aq", "--filter", `name=^${name}$`], { signal })
    if (existing.stdout.trim()) {
      await docker.run(["start", name], { signal })
      return name
    }
    const net = policy.network.mode === "deny" ? ["--network", "none"] : ["--network", "bridge"]
    const envArgs = Object.entries(policy.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    const res = policy.resources
    const limits = [
      ...(res?.memoryMb ? ["--memory", `${res.memoryMb}m`] : []),
      ...(res?.cpus ? ["--cpus", String(res.cpus)] : []),
    ]
    await docker.run(
      [
        "run", "-d", "--name", name,
        "--label", `dawn.sandbox=${threadId}`,
        "-v", `${volumeName(threadId)}:${ROOT}`,
        "-w", ROOT,
        ...net, ...envArgs, ...limits,
        opts.image, "sleep", "infinity",
      ],
      { signal },
    )
    // best-effort denylist note (allow mode): full egress filtering deferred — see spec.
    return name
  }

  return {
    name: "docker",
    async acquire({ threadId, policy, signal }): Promise<SandboxHandle> {
      const container = await ensureContainer(threadId, policy, signal)
      return {
        threadId,
        filesystem: dockerFilesystem(docker, container),
        exec: dockerExec(docker, container),
        workspaceRoot: ROOT,
      }
    },
    async release(threadId) {
      await docker.run(["rm", "-f", containerName(threadId)]).catch(() => {})
    },
    async destroy(threadId) {
      await docker.run(["rm", "-f", containerName(threadId)]).catch(() => {})
      await docker.run(["volume", "rm", volumeName(threadId)]).catch(() => {})
    },
    async preflight() {
      const v = await docker.run(["version", "--format", "{{.Server.Version}}"]).catch(() => undefined)
      if (!v || v.exitCode !== 0) return { ok: false, detail: "Docker daemon not reachable (`docker version` failed)." }
      return { ok: true, detail: `Docker ${v.stdout.trim()}` }
    },
  }
}
```

Add to `packages/sandbox/src/index.ts`: `export { dockerSandbox, type DockerSandboxOptions } from "./docker/docker-sandbox.js"`.

- [ ] **Step 4: Run unit tests + typecheck** → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/docker/docker-sandbox.ts packages/sandbox/src/index.ts packages/sandbox/test/docker-sandbox.unit.test.ts
git commit -m "feat(sandbox): dockerSandbox provider (acquire/release/destroy/preflight)"
```

### Task 14: Gated real-Docker conformance + e2e + CI lane

**Files:**
- Create: `packages/sandbox/test/docker-sandbox.integration.test.ts` (gated `describe.skipIf(!process.env.DAWN_TEST_DOCKER)`)
- Modify: `.github/workflows/ci.yml` (new `sandbox-docker` job, NOT in the default `validate` job)

- [ ] **Step 1: Write the gated integration test**

```ts
// packages/sandbox/test/docker-sandbox.integration.test.ts
import { describe } from "vitest"
import { dockerSandbox } from "../src/index.ts"
import { runProviderConformance } from "../src/testing/index.ts"

const enabled = process.env.DAWN_TEST_DOCKER === "1"

describe.skipIf(!enabled)("dockerSandbox (real Docker)", () => {
  runProviderConformance({
    name: "dockerSandbox",
    makeProvider: () => dockerSandbox({ image: "node:22-slim" }),
    describe,
  })
  // Plus: a deny-network egress test (a `curl` inside the container fails) and a
  // host-fs-untouched assertion (the host has no file the agent wrote). Author
  // these as additional `test()`s here; each acquires a unique threadId and
  // destroys it in a finally block.
})
```

- [ ] **Step 2: Add the CI job** to `.github/workflows/ci.yml` (separate job; ubuntu runners ship Docker):

```yaml
  sandbox-docker:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<pinned-sha>   # match the pin used elsewhere in this file
      - uses: pnpm/action-setup@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version: 22.14.0 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @dawn-ai/sandbox build
      - run: docker pull node:22-slim
      - run: DAWN_TEST_DOCKER=1 pnpm --filter @dawn-ai/sandbox test docker-sandbox.integration
```

- [ ] **Step 3: Verify locally if Docker is available**

Run: `DAWN_TEST_DOCKER=1 pnpm --filter @dawn-ai/sandbox test docker-sandbox.integration` (skips cleanly without Docker / the env var).
Expected: PASS with Docker; SKIPPED otherwise.

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox/test/docker-sandbox.integration.test.ts .github/workflows/ci.yml
git commit -m "test(sandbox): gated real-Docker conformance + e2e CI lane"
```

---

## Phase F — Docs, changeset, release

### Task 15: `sandbox.mdx` docs page

**Files:**
- Create: `apps/web/content/docs/sandbox.mdx`, `apps/web/app/docs/sandbox/page.tsx`
- Modify: `apps/web/app/components/docs/nav.ts` (add the nav entry)

- [ ] **Step 1: Write the docs page** — base it on the spec's "Honest scope", "Config surface", and the walkthrough. Cover: enabling it (`config()` + `dockerSandbox`), what's isolated, network policy, the `config()` helper, writing a custom provider, testing with `fakeSandbox`, and the IS/IS-NOT section verbatim. Register the page in all three places (`DOCS_NAV` entry + `content/docs/sandbox.mdx` + `app/docs/sandbox/page.tsx`) — `check-docs.mjs` validates nav→file.

- [ ] **Step 2: Run the docs check**

Run: `node scripts/check-docs.mjs`
Expected: PASS (nav entry resolves; no banned marketing phrases — avoid "byte-identical" etc.).

- [ ] **Step 3: Commit**

```bash
git add apps/web/content/docs/sandbox.mdx apps/web/app/docs/sandbox/page.tsx apps/web/app/components/docs/nav.ts
git commit -m "docs: execution sandbox guide"
```

### Task 16: Changeset + full verification + PR

**Files:**
- Create: `.changeset/execution-sandbox.md`

- [ ] **Step 1: Write the changeset as `patch`** (GOTCHA 6: a `minor` forces the fixed 0.x group to 1.0.0 — keep it patch to stay pre-1.0)

```md
---
"@dawn-ai/sandbox": patch
"@dawn-ai/workspace": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

Add an opt-in execution sandbox: a provider-agnostic `SandboxProvider` contract
with a Docker reference (`dockerSandbox`), giving each conversation thread a
hard-isolated workspace (filesystem + shell + network). Enable via
`dawn.config.ts` `sandbox: { provider: dockerSandbox({ image }) }`; without it,
behavior is unchanged. Adds a typed `config()` helper. Honest scope: Docker's
boundary (not a microVM); `allow`-mode network denylist is best-effort in the
Docker reference. New package `@dawn-ai/sandbox` (+ `/testing` `fakeSandbox`).
```

- [ ] **Step 2: Full local verification**

Run: `pnpm lint && pnpm build && pnpm typecheck && pnpm test && node scripts/check-docs.mjs && pnpm verify:harness:framework`
Expected: all PASS. (Sandbox unit/wiring tests are Docker-free; the real-Docker lane runs only in CI / with `DAWN_TEST_DOCKER=1`.)

- [ ] **Step 3: Confirm the Version PR will compute a PATCH, not 1.0.0**

After opening the PR + merge, when the Version Packages PR appears, verify it resolves to the next patch (e.g. `0.8.5`), NOT `1.0.0`, before admin-merging (per GOTCHA 6 / #268). **New package `@dawn-ai/sandbox` is a first publish → it needs the one-time manual OIDC bootstrap** (`npm publish --access public` once + trusted-publishing config) exactly like `@dawn-ai/memory` at 0.8.3; budget for it at release.

- [ ] **Step 4: Commit + open PR**

```bash
git add .changeset/execution-sandbox.md
git commit -m "chore: changeset for execution sandbox (patch)"
git push -u origin feat/execution-sandbox
gh pr create --title "feat: execution sandbox (per-thread Docker isolation, opt-in)" --body "Implements docs/superpowers/specs/2026-06-25-execution-sandbox-design.md"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** contract (T1), config+helper (T2), package (T3), fakeSandbox (T4), conformance (T5), manager (T6), wiring + capability workspaceRoot (T7–T8), wiring e2e (T9), dawn check (T10), docker provider (T11–T13), gated docker lane (T14), docs (T15), changeset/release flags (T16). Network deny is exact (T13 `--network none`); allow-denylist is best-effort + documented (T13 comment, T15 docs).
- **Type consistency:** `SandboxProvider.acquire/release/destroy/preflight`, `SandboxHandle.{threadId,filesystem,exec,workspaceRoot}`, `SandboxPolicy.network` discriminated union, `SandboxManager.{getForThread,reapIdle,destroyThread,releaseAll}` are used identically across tasks.
- **Watch-outs:** (1) `vitest` / `catalog:` references in the new package.json must match how sibling packages reference deps — copy from `packages/workspace/package.json` exactly. (2) `threadId` must reach BOTH top-route and recursive subagent dispatch (T7) — assert subagent sharing in T9. (3) the workspace capability's `detect()` must not host-`existsSync` when sandboxed (T7 Step 5). (4) `Date.now` is used only in `SandboxManager` default clock (injectable) — keep lib code deterministic per the memory's no-`Date.now` rule for capabilities (the manager is runtime infra, not a capability, so a default `Date.now` is acceptable, but tests inject `clock`).
