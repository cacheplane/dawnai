# Phase 3 — Workspace Capability + Pluggable Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor workspace tools (`readFile`, `writeFile`, `listDir`, `runBash`) from per-route hand-rolled files into a built-in capability auto-wired by the `workspace/` directory convention, with a pluggable filesystem/exec backend pair configurable in `dawn.config.ts` and shipping defaults plus functional composition primitives in a new `@dawn-ai/workspace` package.

**Architecture:** New `@dawn-ai/workspace` package (types + `localFilesystem`/`localExec` defaults + `compose`/`withLogging` helpers). New `createWorkspaceMarker()` capability in `@dawn-ai/core` that contributes the four tools wired to the configured (or default-local) backends. `dawn.config.ts` loader switches from a hand-rolled string-only parser to a `tsx`-evaluated import so callable backends can be expressed naturally. Path-jail enforcement lives in the capability; backends receive already-resolved absolute paths. Chat example's hand-rolled tool files delete.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, zod, `node:fs/promises`, `node:child_process`, `tsx/esm/api` (already a dep, used for route discovery).

**Spec:** `docs/superpowers/specs/2026-05-20-phase3-workspace-backends-design.md`

---

## File Structure (locked in here, used by all tasks below)

### New package: `packages/workspace/`

| Path | Responsibility |
|---|---|
| `packages/workspace/package.json` | `@dawn-ai/workspace` manifest |
| `packages/workspace/tsconfig.json` | TS config (extends `@dawn-ai/config-typescript`) |
| `packages/workspace/vitest.config.ts` | Vitest config (mirror `@dawn-ai/core` shape) |
| `packages/workspace/src/index.ts` | Barrel re-exports |
| `packages/workspace/src/types.ts` | `FilesystemBackend`, `ExecBackend`, `BackendContext`, middleware types |
| `packages/workspace/src/local-filesystem.ts` | `localFilesystem()` factory |
| `packages/workspace/src/local-exec.ts` | `localExec()` factory |
| `packages/workspace/src/compose.ts` | `compose()` helper |
| `packages/workspace/src/with-logging.ts` | `withLogging()` middleware |
| `packages/workspace/test/local-filesystem.test.ts` | Unit tests |
| `packages/workspace/test/local-exec.test.ts` | Unit tests |
| `packages/workspace/test/compose.test.ts` | Unit tests |
| `packages/workspace/test/with-logging.test.ts` | Unit tests |

### New files in existing packages

| Path | Responsibility |
|---|---|
| `packages/core/src/capabilities/built-in/workspace.ts` | `createWorkspaceMarker()` |
| `packages/core/test/capabilities/workspace.test.ts` | Marker unit tests |

### Modified files

| Path | Change |
|---|---|
| `packages/core/src/config.ts` | Replace hand-rolled parser with `tsx`-evaluated import |
| `packages/core/test/config.test.ts` | Rewrite tests for the new loader |
| `packages/core/src/types.ts` | Add `backends?` to `DawnConfig` |
| `packages/core/src/capabilities/types.ts` | Add `backends?` to `CapabilityMarkerContext` |
| `packages/core/src/index.ts` | Export `createWorkspaceMarker` |
| `packages/cli/src/lib/runtime/execute-route.ts` | Register marker; thread backends from loaded `dawn.config` |
| `packages/cli/src/lib/runtime/check-tool-name-uniqueness.ts` | Accept overridable tool names |
| `packages/cli/test/tool-name-uniqueness.test.ts` | Add overridable case |
| `packages/cli/src/lib/typegen/run-typegen.ts` | Add `WORKSPACE_EXTRA_TOOLS` gated on `hasWorkspace(routeDir)` |
| `pnpm-workspace.yaml` | Add `packages/workspace` (verify already covers `packages/*`) |
| `memory/project_phase_status.md` | Mark sub-project 4 in progress, then complete |

### Deleted files (chat example)

| Path | Why |
|---|---|
| `examples/chat/server/src/app/chat/tools/readFile.ts` | Capability provides this |
| `examples/chat/server/src/app/chat/tools/writeFile.ts` | Capability provides this |
| `examples/chat/server/src/app/chat/tools/listDir.ts` | Capability provides this |
| `examples/chat/server/src/app/chat/tools/runBash.ts` | Capability provides this |
| `examples/chat/server/src/app/chat/workspace-path.ts` | No longer referenced |
| `examples/chat/server/src/app/coordinator/subagents/research/tools/readFile.ts` | Capability provides this |
| `examples/chat/server/src/app/coordinator/subagents/research/tools/listDir.ts` | Capability provides this |
| `examples/chat/server/src/app/coordinator/subagents/research/workspace-path.ts` | No longer referenced |

---

# Phase A — `@dawn-ai/workspace` package

### Task 1: Scaffold the workspace package

**Files:**
- Create: `packages/workspace/package.json`
- Create: `packages/workspace/tsconfig.json`
- Create: `packages/workspace/tsconfig.build.json`
- Create: `packages/workspace/vitest.config.ts`
- Create: `packages/workspace/src/index.ts` (empty barrel for now)
- Verify: `pnpm-workspace.yaml` already covers `packages/*` (should — confirm with `grep packages pnpm-workspace.yaml`)

- [ ] **Step 1: Inspect a sibling package's manifest pattern**

Run: `cd /Users/blove/repos/dawn && cat packages/sdk/package.json | head -40`
Expected: see the conventional `name`, `version`, `type: "module"`, `exports`, `scripts`, `devDependencies` pattern. Note the version (likely `0.1.x`).

- [ ] **Step 2: Write `packages/workspace/package.json`**

```json
{
  "name": "@dawn-ai/workspace",
  "version": "0.1.8",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc -p . --noEmit",
    "lint": "biome check --config-path ../config-biome/biome.json package.json src test tsconfig.json tsconfig.build.json vitest.config.ts"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@dawn-ai/config-biome": "workspace:*",
    "@biomejs/biome": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

(Verify the `version`, catalog references, and `@dawn-ai/config-*` package names against an existing sibling — adjust if Dawn uses different names like `@dawn-ai/tsconfig`.)

- [ ] **Step 3: Write `packages/workspace/tsconfig.json`**

```json
{
  "extends": "@dawn-ai/config-typescript/base.json",
  "include": ["src", "test"]
}
```

(Match exactly what `packages/core/tsconfig.json` or `packages/sdk/tsconfig.json` does — adjust the extends path if those use a different shape.)

- [ ] **Step 4: Write `packages/workspace/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": false
  },
  "include": ["src"]
}
```

(Compare against `packages/sdk/tsconfig.build.json` — match exactly.)

- [ ] **Step 5: Write `packages/workspace/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
})
```

- [ ] **Step 6: Write `packages/workspace/src/index.ts` (empty barrel for now)**

```ts
// Re-exports will be added as types and impls land in subsequent tasks.
export {}
```

- [ ] **Step 7: Install + verify scaffolding**

Run from repo root:
```bash
cd /Users/blove/repos/dawn && pnpm install 2>&1 | tail -5
```
Expected: `Done in Ns`. The new `@dawn-ai/workspace` package is symlinked.

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace build 2>&1 | tail -5`
Expected: build succeeds (empty package builds fine).

- [ ] **Step 8: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/workspace/
git commit -m "$(cat <<'EOF'
scaffold(workspace): empty @dawn-ai/workspace package

Adds the package skeleton (manifest, tsconfig, vitest config) for the
upcoming pluggable workspace backends. No exports yet — types, defaults,
and helpers land in subsequent commits.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Type interfaces

**Files:**
- Create: `packages/workspace/src/types.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: Write the type file**

Create `packages/workspace/src/types.ts`:

```ts
/**
 * Workspace backend type interfaces.
 *
 * Backends are plain objects implementing these interfaces. The
 * workspace capability calls into them to perform filesystem reads,
 * writes, listings, and shell command execution. Defaults
 * (`localFilesystem`, `localExec`) ship in this package; users can
 * provide their own implementations via dawn.config.ts.
 */

export interface BackendContext {
  /** Aborts when the parent agent run is cancelled. */
  readonly signal: AbortSignal
  /** Absolute filesystem path of the route's workspace directory. */
  readonly workspaceRoot: string
}

export interface FilesystemBackend {
  /**
   * Read a UTF-8 file. `path` is an already-resolved absolute path
   * inside `ctx.workspaceRoot` — the capability has done the path-jail.
   */
  readFile(path: string, ctx: BackendContext): Promise<string>

  /** Write a UTF-8 file. Returns the byte count of `content`. */
  writeFile(
    path: string,
    content: string,
    ctx: BackendContext,
  ): Promise<{ readonly bytesWritten: number }>

  /** List entries in a directory. Returns leaf names (not full paths). */
  listDir(path: string, ctx: BackendContext): Promise<readonly string[]>
}

export interface ExecBackend {
  /**
   * Run a shell command. `args.cwd`, if provided, is already-resolved
   * to an absolute path inside `ctx.workspaceRoot`.
   */
  runCommand(
    args: {
      readonly command: string
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
    },
    ctx: BackendContext,
  ): Promise<{
    readonly stdout: string
    readonly stderr: string
    readonly exitCode: number
  }>
}

/**
 * A filesystem middleware is a function that wraps a backend to add
 * cross-cutting behavior (logging, caching, etc.). Compose multiple
 * middlewares via `compose()`.
 */
export type FilesystemMiddleware = (next: FilesystemBackend) => FilesystemBackend

/** See FilesystemMiddleware. */
export type ExecMiddleware = (next: ExecBackend) => ExecBackend
```

- [ ] **Step 2: Re-export from the barrel**

Edit `packages/workspace/src/index.ts`:

```ts
export type {
  BackendContext,
  ExecBackend,
  ExecMiddleware,
  FilesystemBackend,
  FilesystemMiddleware,
} from "./types.js"
```

- [ ] **Step 3: Build + typecheck**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace build 2>&1 | tail -5`
Expected: success.

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace typecheck 2>&1 | tail -5`
Expected: success.

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/workspace/src/types.ts packages/workspace/src/index.ts
git commit -m "feat(workspace): type interfaces for filesystem + exec backends

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: `localFilesystem()` factory

**Files:**
- Create: `packages/workspace/src/local-filesystem.ts`
- Create: `packages/workspace/test/local-filesystem.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/workspace/test/local-filesystem.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localFilesystem } from "../src/local-filesystem.js"

function ctx(workspaceRoot: string) {
  return { signal: new AbortController().signal, workspaceRoot }
}

describe("localFilesystem", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dawn-localfs-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("readFile returns UTF-8 contents", async () => {
    writeFileSync(join(root, "hello.txt"), "hi", "utf8")
    const fs = localFilesystem()
    expect(await fs.readFile(join(root, "hello.txt"), ctx(root))).toBe("hi")
  })

  it("readFile rejects files larger than maxFileBytes", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(2048), "utf8")
    const fs = localFilesystem({ maxFileBytes: 1024 })
    await expect(fs.readFile(join(root, "big.txt"), ctx(root))).rejects.toThrow(/too large/i)
  })

  it("writeFile returns the byte count", async () => {
    const fs = localFilesystem()
    const res = await fs.writeFile(join(root, "out.txt"), "abc", ctx(root))
    expect(res.bytesWritten).toBe(3)
  })

  it("listDir returns directory entries (leaf names only)", async () => {
    writeFileSync(join(root, "a.txt"), "", "utf8")
    mkdirSync(join(root, "sub"))
    const fs = localFilesystem()
    const entries = await fs.listDir(root, ctx(root))
    expect([...entries].sort()).toEqual(["a.txt", "sub"])
  })

  it("readFile on missing file raises ENOENT", async () => {
    const fs = localFilesystem()
    await expect(fs.readFile(join(root, "ghost.txt"), ctx(root))).rejects.toThrow(/ENOENT/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test 2>&1 | tail -10`
Expected: FAIL with `Cannot find module '../src/local-filesystem.js'`.

- [ ] **Step 3: Implement**

Create `packages/workspace/src/local-filesystem.ts`:

```ts
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import type { BackendContext, FilesystemBackend } from "./types.js"

const DEFAULT_MAX_FILE_BYTES = 256 * 1024

export interface LocalFilesystemOptions {
  /**
   * Reject `readFile` when the target file exceeds this size.
   * Default: 256 KiB.
   */
  readonly maxFileBytes?: number
}

export function localFilesystem(opts: LocalFilesystemOptions = {}): FilesystemBackend {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  return {
    async readFile(path: string, _ctx: BackendContext): Promise<string> {
      const s = await stat(path)
      if (s.size > maxBytes) {
        throw new Error(`File too large: ${s.size} bytes (max ${maxBytes}) at ${path}`)
      }
      return await readFile(path, "utf8")
    },
    async writeFile(
      path: string,
      content: string,
      _ctx: BackendContext,
    ): Promise<{ readonly bytesWritten: number }> {
      await writeFile(path, content, "utf8")
      return { bytesWritten: Buffer.byteLength(content, "utf8") }
    },
    async listDir(path: string, _ctx: BackendContext): Promise<readonly string[]> {
      return await readdir(path)
    },
  }
}
```

- [ ] **Step 4: Re-export from barrel**

Edit `packages/workspace/src/index.ts`, append:

```ts
export { localFilesystem, type LocalFilesystemOptions } from "./local-filesystem.js"
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test 2>&1 | tail -10`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/workspace/src/local-filesystem.ts \
        packages/workspace/test/local-filesystem.test.ts \
        packages/workspace/src/index.ts
git commit -m "feat(workspace): localFilesystem default backend

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: `localExec()` factory

**Files:**
- Create: `packages/workspace/src/local-exec.ts`
- Create: `packages/workspace/test/local-exec.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/workspace/test/local-exec.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localExec } from "../src/local-exec.js"

function ctx(workspaceRoot: string) {
  return { signal: new AbortController().signal, workspaceRoot }
}

describe("localExec", () => {
  it("runCommand captures stdout, stderr, exitCode", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec()
      const out = await exec.runCommand({ command: "echo hello" }, ctx(root))
      expect(out.stdout.trim()).toBe("hello")
      expect(out.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runCommand returns non-zero exitCode on failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec()
      const out = await exec.runCommand({ command: "exit 7" }, ctx(root))
      expect(out.exitCode).toBe(7)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runCommand enforces timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec({ timeout: 100 })
      await expect(
        exec.runCommand({ command: "sleep 1" }, ctx(root)),
      ).rejects.toThrow(/timeout/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runCommand respects allowedCommands regex allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "dawn-localexec-"))
    try {
      const exec = localExec({ allowedCommands: [/^echo\b/, /^ls\b/] })
      const ok = await exec.runCommand({ command: "echo allowed" }, ctx(root))
      expect(ok.stdout.trim()).toBe("allowed")
      await expect(
        exec.runCommand({ command: "rm -rf /" }, ctx(root)),
      ).rejects.toThrow(/not allowed/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test -- local-exec 2>&1 | tail -10`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `packages/workspace/src/local-exec.ts`:

```ts
import { exec as cpExec } from "node:child_process"
import { promisify } from "node:util"
import type { BackendContext, ExecBackend } from "./types.js"

const execAsync = promisify(cpExec)
const DEFAULT_TIMEOUT_MS = 30_000

export interface LocalExecOptions {
  /** Kill the command if it runs longer than this. Default 30 seconds. */
  readonly timeout?: number
  /**
   * Optional allowlist of command-line patterns. When non-empty, every
   * command must match at least one regex or `runCommand` throws before
   * spawning anything. Use to deny dangerous commands in production.
   */
  readonly allowedCommands?: readonly RegExp[]
}

export function localExec(opts: LocalExecOptions = {}): ExecBackend {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS
  const allowed = opts.allowedCommands
  return {
    async runCommand(args, ctx: BackendContext) {
      if (allowed && allowed.length > 0 && !allowed.some((re) => re.test(args.command))) {
        throw new Error(`Command not allowed by allowedCommands policy: ${args.command}`)
      }
      try {
        const result = await execAsync(args.command, {
          cwd: args.cwd ?? ctx.workspaceRoot,
          env: args.env ?? process.env,
          timeout,
          signal: ctx.signal,
        })
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
      } catch (err) {
        const e = err as NodeJS.ErrnoException & {
          code?: number | string
          stdout?: string
          stderr?: string
          killed?: boolean
        }
        if (e.killed && typeof e.code !== "number") {
          throw new Error(`Command timeout after ${timeout}ms: ${args.command}`)
        }
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          exitCode: typeof e.code === "number" ? e.code : 1,
        }
      }
    },
  }
}
```

- [ ] **Step 4: Re-export from barrel**

Edit `packages/workspace/src/index.ts`, append:

```ts
export { localExec, type LocalExecOptions } from "./local-exec.js"
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test 2>&1 | tail -10`
Expected: PASS (9 tests: 5 fs + 4 exec).

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/workspace/src/local-exec.ts \
        packages/workspace/test/local-exec.test.ts \
        packages/workspace/src/index.ts
git commit -m "feat(workspace): localExec default backend

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: `compose()` helper

**Files:**
- Create: `packages/workspace/src/compose.ts`
- Create: `packages/workspace/test/compose.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/workspace/test/compose.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { compose } from "../src/compose.js"
import type { FilesystemBackend, FilesystemMiddleware } from "../src/types.js"

const base: FilesystemBackend = {
  async readFile() { return "BASE" },
  async writeFile() { return { bytesWritten: 0 } },
  async listDir() { return [] },
}

describe("compose", () => {
  it("with zero middlewares returns the base unchanged", () => {
    expect(compose<FilesystemBackend>()(base)).toBe(base)
  })

  it("with one middleware wraps the base", async () => {
    const upper: FilesystemMiddleware = (next) => ({
      ...next,
      readFile: async (p, c) => (await next.readFile(p, c)).toLowerCase(),
    })
    const wrapped = compose(upper)(base)
    expect(await wrapped.readFile("x", { signal: new AbortController().signal, workspaceRoot: "/" })).toBe("base")
  })

  it("applies middlewares right-to-left (outermost first)", async () => {
    const trace: string[] = []
    const a: FilesystemMiddleware = (next) => ({
      ...next,
      readFile: async (p, c) => { trace.push("a:before"); const r = await next.readFile(p, c); trace.push("a:after"); return r },
    })
    const b: FilesystemMiddleware = (next) => ({
      ...next,
      readFile: async (p, c) => { trace.push("b:before"); const r = await next.readFile(p, c); trace.push("b:after"); return r },
    })
    await compose(a, b)(base).readFile("x", { signal: new AbortController().signal, workspaceRoot: "/" })
    // `compose(a, b)` reads "a wraps b wraps base", so order is a:before, b:before, b:after, a:after
    expect(trace).toEqual(["a:before", "b:before", "b:after", "a:after"])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test -- compose 2>&1 | tail -10`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `packages/workspace/src/compose.ts`:

```ts
/**
 * Compose middleware functions into a single wrapper.
 *
 * Order: the LEFTMOST middleware is the OUTERMOST. Given
 * `compose(a, b, c)(base)`, the call order is `a -> b -> c -> base`,
 * mirroring how function call stacks read top-down.
 *
 * With zero middlewares, returns the base unchanged (no wrapper object).
 */
export function compose<T>(...middlewares: ReadonlyArray<(next: T) => T>): (base: T) => T {
  if (middlewares.length === 0) return (base) => base
  return (base) => middlewares.reduceRight((acc, mw) => mw(acc), base)
}
```

- [ ] **Step 4: Re-export**

Edit `packages/workspace/src/index.ts`, append:

```ts
export { compose } from "./compose.js"
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test 2>&1 | tail -10`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/workspace/src/compose.ts \
        packages/workspace/test/compose.test.ts \
        packages/workspace/src/index.ts
git commit -m "feat(workspace): compose() middleware helper

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: `withLogging()` middleware

**Files:**
- Create: `packages/workspace/src/with-logging.ts`
- Create: `packages/workspace/test/with-logging.test.ts`
- Modify: `packages/workspace/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/workspace/test/with-logging.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { withFilesystemLogging } from "../src/with-logging.js"
import type { FilesystemBackend } from "../src/types.js"

const base: FilesystemBackend = {
  async readFile() { return "ok" },
  async writeFile() { return { bytesWritten: 5 } },
  async listDir() { return ["a"] },
}

const ctx = { signal: new AbortController().signal, workspaceRoot: "/r" }

describe("withFilesystemLogging", () => {
  it("invokes the destination callback for each method", async () => {
    const log: Array<{ method: string; args: unknown[] }> = []
    const wrapped = withFilesystemLogging({ destination: (e) => log.push(e) })(base)
    await wrapped.readFile("a.md", ctx)
    await wrapped.writeFile("b.md", "hi", ctx)
    await wrapped.listDir("/r", ctx)
    expect(log.map((e) => e.method)).toEqual(["readFile", "writeFile", "listDir"])
    expect(log[0]!.args).toEqual(["a.md"])
    expect(log[1]!.args).toEqual(["b.md", "hi"])
  })

  it("forwards return values unchanged", async () => {
    const wrapped = withFilesystemLogging({ destination: () => undefined })(base)
    expect(await wrapped.readFile("a.md", ctx)).toBe("ok")
    expect(await wrapped.writeFile("b.md", "hi", ctx)).toEqual({ bytesWritten: 5 })
    expect([...(await wrapped.listDir("/r", ctx))]).toEqual(["a"])
  })

  it("defaults destination to console.error when not provided", async () => {
    const original = console.error
    const logged: string[] = []
    console.error = ((msg: string) => logged.push(msg)) as typeof console.error
    try {
      const wrapped = withFilesystemLogging()(base)
      await wrapped.readFile("a.md", ctx)
    } finally {
      console.error = original
    }
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain("readFile")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test -- with-logging 2>&1 | tail -10`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/workspace/src/with-logging.ts`:

```ts
import type { ExecMiddleware, FilesystemBackend, FilesystemMiddleware } from "./types.js"

export interface LoggingOptions {
  /**
   * Where to send log lines. Default: `console.error`.
   *
   * Pass a function for structured logging. The argument is
   * `{ method, args }` so the function can format however it wants.
   */
  readonly destination?: ((entry: { method: string; args: unknown[] }) => void)
}

function emit(opts: LoggingOptions, method: string, args: unknown[]): void {
  if (opts.destination) {
    opts.destination({ method, args })
    return
  }
  console.error(`[dawn:workspace] ${method}(${args.map((a) => JSON.stringify(a)).join(", ")})`)
}

export function withFilesystemLogging(opts: LoggingOptions = {}): FilesystemMiddleware {
  return (next: FilesystemBackend) => ({
    readFile: async (path, ctx) => {
      emit(opts, "readFile", [path])
      return next.readFile(path, ctx)
    },
    writeFile: async (path, content, ctx) => {
      emit(opts, "writeFile", [path, content])
      return next.writeFile(path, content, ctx)
    },
    listDir: async (path, ctx) => {
      emit(opts, "listDir", [path])
      return next.listDir(path, ctx)
    },
  })
}

export function withExecLogging(opts: LoggingOptions = {}): ExecMiddleware {
  return (next) => ({
    runCommand: async (args, ctx) => {
      emit(opts, "runCommand", [args.command, args.cwd])
      return next.runCommand(args, ctx)
    },
  })
}
```

(Two named functions, one per interface. Cleaner than the conditional-type approach floated in the spec — explicit type signatures, no inference magic.)

- [ ] **Step 4: Re-export**

Edit `packages/workspace/src/index.ts`, append:

```ts
export { withExecLogging, withFilesystemLogging, type LoggingOptions } from "./with-logging.js"
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/workspace test 2>&1 | tail -10`
Expected: PASS (15 tests).

- [ ] **Step 6: Verify full repo still builds**

Run: `cd /Users/blove/repos/dawn && pnpm build 2>&1 | tail -8`
Expected: success across all packages.

- [ ] **Step 7: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/workspace/src/with-logging.ts \
        packages/workspace/test/with-logging.test.ts \
        packages/workspace/src/index.ts
git commit -m "feat(workspace): withFilesystemLogging + withExecLogging middlewares

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

# Phase B — Config loader switch

### Task 7: Replace hand-rolled config parser with `tsx`-evaluated import

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/test/config.test.ts`

- [ ] **Step 1: Read the current loader + tests**

Run: `cd /Users/blove/repos/dawn && wc -l packages/core/src/config.ts packages/core/test/config.test.ts`
Read both to understand:
- The current parser supports `const FOO = "x"` + `export default { appDir }` + `export default { appDir: "..." }`. Nothing else.
- Existing tests verify successful parses + rejection of unsupported syntax.

- [ ] **Step 2: Rewrite `packages/core/src/config.ts`**

Replace the entire file with:

```ts
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { DawnConfig, LoadDawnConfigOptions, LoadedDawnConfig } from "./types.js"

export const DAWN_CONFIG_FILE = "dawn.config.ts"

let loaderPromise: Promise<void> | undefined

async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= (async () => {
    const { register } = (await import("tsx/esm/api")) as {
      readonly register: () => unknown
    }
    register()
  })()
  await loaderPromise
}

export async function loadDawnConfig(options: LoadDawnConfigOptions): Promise<LoadedDawnConfig> {
  const configPath = join(options.appRoot, DAWN_CONFIG_FILE)
  await access(configPath, constants.F_OK)
  await registerTsxLoader()

  const mod = (await import(pathToFileURL(configPath).href)) as {
    readonly default?: unknown
  }

  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(
      `${DAWN_CONFIG_FILE} must export default an object. Got: ${typeof mod.default}`,
    )
  }

  return {
    appRoot: options.appRoot,
    config: mod.default as DawnConfig,
    configPath,
  }
}
```

- [ ] **Step 3: Rewrite `packages/core/test/config.test.ts`**

Replace with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DAWN_CONFIG_FILE, loadDawnConfig } from "../src/config.js"

describe("loadDawnConfig", () => {
  let appRoot: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-config-"))
  })

  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function writeConfig(source: string): Promise<void> {
    await writeFile(join(appRoot, DAWN_CONFIG_FILE), source, "utf8")
  }

  it("loads a config with just appDir", async () => {
    await writeConfig(`export default { appDir: "src/app" }\n`)
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.config).toMatchObject({ appDir: "src/app" })
    expect(loaded.configPath).toBe(join(appRoot, DAWN_CONFIG_FILE))
  })

  it("loads a config with no fields (empty object)", async () => {
    await writeConfig(`export default {}\n`)
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.config).toEqual({})
  })

  it("loads a config that imports from another module", async () => {
    // Note: this test mostly verifies the tsx loader is registered — the
    // existence of an importable file is enough; the import doesn't have
    // to be a real package.
    await writeConfig(`
      const APP_DIR = "src/app"
      export default { appDir: APP_DIR }
    `)
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.config).toMatchObject({ appDir: "src/app" })
  })

  it("rejects missing default export", async () => {
    await writeConfig(`export const named = { appDir: "x" }\n`)
    await expect(loadDawnConfig({ appRoot })).rejects.toThrow(/must export default/i)
  })

  it("rejects non-object default export", async () => {
    await writeConfig(`export default "hello"\n`)
    await expect(loadDawnConfig({ appRoot })).rejects.toThrow(/must export default an object/i)
  })

  it("propagates TS syntax errors from the imported module", async () => {
    await writeConfig(`export default { appDir:\n`) // syntactically invalid
    await expect(loadDawnConfig({ appRoot })).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run config tests**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core test -- config.test 2>&1 | tail -10`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full repo tests to catch unrelated regressions**

Run: `cd /Users/blove/repos/dawn && pnpm test 2>&1 | tail -10`
Expected: all tests pass. (One file in `packages/core/test/discover-routes.test.ts` writes a `dawn.config.ts` with `export default { appDir: "src/app" }` — that's a valid TS module under the new loader too, so should still work.)

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "$(cat <<'EOF'
feat(core): switch dawn.config.ts loader from hand-rolled parser to tsx import

The hand-rolled parser supported only string-literal property values
and const string bindings. The upcoming workspace capability needs to
express callable backend values in dawn.config.ts, which strings can't
express. Switch to a tsx-evaluated dynamic import (same loader Dawn
already uses for route discovery and tool execution).

Existing dawn.config.ts files (just { appDir }) remain valid TS
modules and continue to load without modification.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

# Phase C — Capability marker

### Task 8: Extend `DawnConfig` + `CapabilityMarkerContext` with `backends?`

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/capabilities/types.ts`
- Modify: `packages/core/package.json` (add `@dawn-ai/workspace` peer/dep — type-only)

- [ ] **Step 1: Add the workspace package as a type-only dependency on @dawn-ai/core**

Edit `packages/core/package.json`. Add to `devDependencies` (type-only — no runtime dep):

```json
"@dawn-ai/workspace": "workspace:*"
```

- [ ] **Step 2: Extend `DawnConfig`**

Edit `packages/core/src/types.ts`. Find the `DawnConfig` interface (around line 5) and update:

```ts
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import type { RouteKind } from "@dawn-ai/sdk"

export type { RouteKind }

export interface DawnConfig {
  readonly appDir?: string
  readonly backends?: {
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
}
```

- [ ] **Step 3: Extend `CapabilityMarkerContext`**

Edit `packages/core/src/capabilities/types.ts`. Add to the imports at the top:

```ts
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
```

Update the `CapabilityMarkerContext` interface:

```ts
export interface CapabilityMarkerContext {
  readonly routeManifest: RouteManifest
  readonly descriptor: DawnAgent | undefined
  readonly descriptorRouteMap?: ReadonlyMap<DawnAgent, string>
  readonly backends?: {
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
}
```

- [ ] **Step 4: Install + verify**

Run: `cd /Users/blove/repos/dawn && pnpm install --silent 2>&1 | tail -3`
Expected: workspace package is symlinked into core.

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core typecheck 2>&1 | tail -5`
Expected: 0 errors.

- [ ] **Step 5: Run full repo tests**

Run: `cd /Users/blove/repos/dawn && pnpm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/core/package.json \
        packages/core/src/types.ts \
        packages/core/src/capabilities/types.ts
git commit -m "feat(core): add backends field to DawnConfig + CapabilityMarkerContext

Type-only edge: @dawn-ai/core now imports FilesystemBackend/ExecBackend
types from @dawn-ai/workspace via 'import type'. No runtime weight.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Implement `createWorkspaceMarker`

**Files:**
- Create: `packages/core/src/capabilities/built-in/workspace.ts`
- Create: `packages/core/test/capabilities/workspace.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json` (`@dawn-ai/workspace` is now a runtime dep too — for the default backends)

- [ ] **Step 1: Promote workspace from devDep to dep in `@dawn-ai/core`**

Edit `packages/core/package.json`. Move `@dawn-ai/workspace` from `devDependencies` to `dependencies`. The marker needs `localFilesystem()` and `localExec()` at runtime as defaults.

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/capabilities/workspace.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createWorkspaceMarker } from "../../src/capabilities/built-in/workspace.js"
import type { CapabilityMarkerContext } from "../../src/capabilities/types.js"

function emptyManifest() {
  return { appRoot: "/app", routes: [] }
}

function ctx(extras: Partial<CapabilityMarkerContext> = {}): CapabilityMarkerContext {
  return {
    routeManifest: emptyManifest(),
    descriptor: undefined,
    ...extras,
  }
}

describe("createWorkspaceMarker — detect", () => {
  let routeDir: string
  beforeEach(() => { routeDir = mkdtempSync(join(tmpdir(), "dawn-workspace-cap-")) })
  afterEach(() => { rmSync(routeDir, { recursive: true, force: true }) })

  it("returns false when no workspace/ directory exists", async () => {
    const detected = await createWorkspaceMarker().detect(routeDir, ctx())
    expect(detected).toBe(false)
  })

  it("returns true when workspace/ exists", async () => {
    mkdirSync(join(routeDir, "workspace"))
    const detected = await createWorkspaceMarker().detect(routeDir, ctx())
    expect(detected).toBe(true)
  })
})

describe("createWorkspaceMarker — load", () => {
  let routeDir: string
  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-workspace-cap-"))
    mkdirSync(join(routeDir, "workspace"))
  })
  afterEach(() => { rmSync(routeDir, { recursive: true, force: true }) })

  it("contributes exactly four tools when workspace/ exists", async () => {
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    const names = (contribution.tools ?? []).map((t) => t.name).sort()
    expect(names).toEqual(["listDir", "readFile", "runBash", "writeFile"])
  })

  it("contributes no tools when workspace/ is absent", async () => {
    rmSync(join(routeDir, "workspace"), { recursive: true })
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    expect(contribution.tools).toBeUndefined()
  })

  it("readFile tool calls the configured backend with an absolute path inside the jail", async () => {
    writeFileSync(join(routeDir, "workspace", "hello.txt"), "hi", "utf8")
    const fakeBackend = {
      readFile: vi.fn().mockResolvedValue("hi"),
      writeFile: vi.fn(),
      listDir: vi.fn(),
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx({ backends: { filesystem: fakeBackend } }),
    )
    const readTool = contribution.tools!.find((t) => t.name === "readFile")!
    const result = await readTool.run({ path: "hello.txt" }, { signal: new AbortController().signal })
    expect(result).toBe("hi")
    expect(fakeBackend.readFile).toHaveBeenCalledOnce()
    const [absPath] = fakeBackend.readFile.mock.calls[0]!
    expect(absPath).toBe(join(routeDir, "workspace", "hello.txt"))
  })

  it("rejects path-jail escapes with a clear error", async () => {
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    const readTool = contribution.tools!.find((t) => t.name === "readFile")!
    await expect(
      readTool.run({ path: "../../etc/passwd" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/outside workspace/i)
  })

  it("uses the default local backends when none configured", async () => {
    writeFileSync(join(routeDir, "workspace", "ok.txt"), "ok", "utf8")
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    const readTool = contribution.tools!.find((t) => t.name === "readFile")!
    const result = await readTool.run({ path: "ok.txt" }, { signal: new AbortController().signal })
    expect(result).toBe("ok")
  })

  it("runBash tool calls the configured exec backend", async () => {
    const fakeExec = {
      runCommand: vi.fn().mockResolvedValue({ stdout: "world", stderr: "", exitCode: 0 }),
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx({ backends: { exec: fakeExec } }),
    )
    const runBash = contribution.tools!.find((t) => t.name === "runBash")!
    const result = await runBash.run(
      { command: "echo world" },
      { signal: new AbortController().signal },
    )
    expect(result).toMatchObject({ stdout: "world", exitCode: 0 })
    expect(fakeExec.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo world" }),
      expect.any(Object),
    )
  })

  it("marks all four tools as overridable", async () => {
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    for (const t of contribution.tools ?? []) {
      // Overridable tools carry a flag the uniqueness check reads; see Task 10.
      expect((t as unknown as { overridable?: boolean }).overridable).toBe(true)
    }
  })
})
```

- [ ] **Step 3: Run tests to verify failure**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core test -- workspace.test 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../../src/capabilities/built-in/workspace.js'`.

- [ ] **Step 4: Implement the marker**

Create `packages/core/src/capabilities/built-in/workspace.ts`:

```ts
import { existsSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { z } from "zod"

import { localExec, localFilesystem } from "@dawn-ai/workspace"
import type { BackendContext, ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"

import type { CapabilityMarker, DawnToolDefinition } from "../types.js"

const WORKSPACE_DIRNAME = "workspace"

const READ_FILE_INPUT = z.object({ path: z.string().min(1) })
const WRITE_FILE_INPUT = z.object({ path: z.string().min(1), content: z.string() })
const LIST_DIR_INPUT = z.object({ path: z.string().default(".") })
const RUN_BASH_INPUT = z.object({ command: z.string().min(1) })

function pathJail(userPath: string, workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot, userPath)
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(`Path is outside workspace: ${userPath}`)
  }
  return resolved
}

function backendContext(workspaceRoot: string, signal: AbortSignal): BackendContext {
  return { signal, workspaceRoot }
}

interface OverridableTool extends DawnToolDefinition {
  readonly overridable: true
}

function buildWorkspaceTools(
  workspaceRoot: string,
  fs: FilesystemBackend,
  exec: ExecBackend,
): readonly OverridableTool[] {
  const readFile: OverridableTool = {
    name: "readFile",
    description: "Read a UTF-8 file from the workspace.",
    schema: READ_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path } = READ_FILE_INPUT.parse(input)
      const safe = pathJail(path, workspaceRoot)
      return fs.readFile(safe, backendContext(workspaceRoot, ctx.signal))
    },
  }
  const writeFile: OverridableTool = {
    name: "writeFile",
    description: "Write a UTF-8 file inside the workspace.",
    schema: WRITE_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path, content } = WRITE_FILE_INPUT.parse(input)
      const safe = pathJail(path, workspaceRoot)
      const result = await fs.writeFile(safe, content, backendContext(workspaceRoot, ctx.signal))
      return `wrote ${result.bytesWritten} bytes to ${path}`
    },
  }
  const listDir: OverridableTool = {
    name: "listDir",
    description: "List entries in a workspace directory.",
    schema: LIST_DIR_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path } = LIST_DIR_INPUT.parse(input)
      const safe = pathJail(path, workspaceRoot)
      const entries = await fs.listDir(safe, backendContext(workspaceRoot, ctx.signal))
      return [...entries]
    },
  }
  const runBash: OverridableTool = {
    name: "runBash",
    description: "Run a shell command inside the workspace.",
    schema: RUN_BASH_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { command } = RUN_BASH_INPUT.parse(input)
      return exec.runCommand({ command }, backendContext(workspaceRoot, ctx.signal))
    },
  }
  return [readFile, writeFile, listDir, runBash]
}

export function createWorkspaceMarker(): CapabilityMarker {
  return {
    name: "workspace",
    detect: async (routeDir, _context) => existsSync(join(routeDir, WORKSPACE_DIRNAME)),
    load: async (routeDir, context) => {
      const workspaceRoot = join(routeDir, WORKSPACE_DIRNAME)
      if (!existsSync(workspaceRoot)) return {}
      const fs = context.backends?.filesystem ?? localFilesystem()
      const exec = context.backends?.exec ?? localExec()
      return { tools: buildWorkspaceTools(workspaceRoot, fs, exec) }
    },
  }
}
```

- [ ] **Step 5: Export from the core barrel**

Edit `packages/core/src/index.ts`, add (next to the other `createXxxMarker` exports):

```ts
export { createWorkspaceMarker } from "./capabilities/built-in/workspace.js"
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core test 2>&1 | tail -10`
Expected: PASS (existing tests + 9 new workspace tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/core/package.json \
        packages/core/src/capabilities/built-in/workspace.ts \
        packages/core/test/capabilities/workspace.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core): createWorkspaceMarker capability

Auto-detects a route's workspace/ directory and contributes four tools
(readFile/writeFile/listDir/runBash) routed through configurable
backends. Defaults to localFilesystem + localExec when no backends are
configured in dawn.config.ts. Path-jail enforced in the capability;
backends receive resolved absolute paths.

Tools carry an `overridable: true` flag so the uniqueness-check
inversion in the next commit can let user-authored tools/<name>.ts
files supersede them.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: Invert tool-name uniqueness check for overridable tools

**Files:**
- Modify: `packages/cli/src/lib/runtime/check-tool-name-uniqueness.ts`
- Modify: `packages/cli/test/tool-name-uniqueness.test.ts`
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (the call site uses the new behavior)

- [ ] **Step 1: Add the failing test**

Append to `packages/cli/test/tool-name-uniqueness.test.ts`:

```ts
describe("checkToolNameUniqueness — overridable", () => {
  it("when a capability tool is overridable, a user tool with the same name does NOT error and replaces it", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "readFile" }],
      capabilityTools: [{ name: "readFile", overridable: true }],
      reservedNames: new Set(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The returned `effectiveCapabilityTools` drops the overridden tool.
    expect(result.effectiveCapabilityTools).toEqual([])
  })

  it("when a capability tool is NOT overridable, a user tool with the same name still errors", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "writeTodos" }],
      capabilityTools: [{ name: "writeTodos" }], // no overridable flag = false
      reservedNames: new Set(),
    })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli test -- tool-name-uniqueness 2>&1 | tail -10`
Expected: FAIL — `result.effectiveCapabilityTools` doesn't exist yet; and the overridable case errors.

- [ ] **Step 3: Update the check**

Edit `packages/cli/src/lib/runtime/check-tool-name-uniqueness.ts`:

```ts
export interface ToolNameCheckInput {
  readonly userTools: ReadonlyArray<{ readonly name: string }>
  readonly capabilityTools: ReadonlyArray<{ readonly name: string; readonly overridable?: boolean }>
  readonly reservedNames: ReadonlySet<string>
}

export type ToolNameCheckResult =
  | {
      readonly ok: true
      /**
       * Capability tools with the overridable ones removed when shadowed by
       * a user tool. The runtime should use THIS list when composing the
       * final tool set, not the input `capabilityTools`.
       */
      readonly effectiveCapabilityTools: ReadonlyArray<{ readonly name: string; readonly overridable?: boolean }>
    }
  | { readonly ok: false; readonly message: string }

export function checkToolNameUniqueness(input: ToolNameCheckInput): ToolNameCheckResult {
  const userNames = new Set(input.userTools.map((t) => t.name))
  const effective: typeof input.capabilityTools = []

  for (const cap of input.capabilityTools) {
    if (userNames.has(cap.name)) {
      if (cap.overridable) {
        // Drop from the effective list; user tool wins.
        continue
      }
      return {
        ok: false,
        message: `Capability conflict: tool name "${cap.name}" is contributed by a capability and also defined in tools/. Remove the user tool or remove the capability marker file.`,
      }
    }
    effective.push(cap)
  }

  for (const t of input.userTools) {
    if (input.reservedNames.has(t.name)) {
      return {
        ok: false,
        message: `Reserved tool name: "${t.name}" is reserved by the Dawn harness and cannot be used as a user tool name.`,
      }
    }
  }

  return { ok: true, effectiveCapabilityTools: effective }
}
```

- [ ] **Step 4: Update the callsite in `execute-route.ts`**

In `packages/cli/src/lib/runtime/execute-route.ts`, find the existing block that calls `checkToolNameUniqueness` (around line 305 — the area introduced in PR #155). The current code throws on collision and otherwise concatenates `tools = [...tools, ...capTools]`. Adjust to use the new `effectiveCapabilityTools`:

```ts
const RESERVED_TOOL_NAMES = new Set(["task"])
const check = checkToolNameUniqueness({
  userTools: tools.map((t) => ({ name: t.name })),
  capabilityTools: capTools.map((t) => ({
    name: t.name,
    ...((t as unknown as { overridable?: boolean }).overridable ? { overridable: true } : {}),
  })),
  reservedNames: RESERVED_TOOL_NAMES,
})
if (!check.ok) {
  return { message: check.message, ok: false }
}

// Use the effective set so overridden tools are dropped before merging.
const effectiveCapNames = new Set(check.effectiveCapabilityTools.map((t) => t.name))
const filteredCapTools = capTools.filter((t) => effectiveCapNames.has(t.name))
tools = [...tools, ...filteredCapTools]
```

(The existing state-field collision check below stays unchanged.)

- [ ] **Step 5: Run all the relevant tests**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli test 2>&1 | tail -10`
Expected: PASS (existing tests + 2 new uniqueness tests).

Run: `cd /Users/blove/repos/dawn && pnpm test 2>&1 | tail -10`
Expected: full repo green.

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/cli/src/lib/runtime/check-tool-name-uniqueness.ts \
        packages/cli/test/tool-name-uniqueness.test.ts \
        packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): support overridable capability tools

Tools marked overridable on a capability contribution can be shadowed
by a user-authored tool with the same name. Used by the workspace
capability so authors can override readFile/writeFile/listDir/runBash
by dropping a file in tools/. Non-overridable capability tools
(writeTodos, readSkill, task) retain the collision error.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

# Phase D — Runtime wiring

### Task 11: Register `createWorkspaceMarker` + thread backends from config

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Add imports + the marker to the registry**

Edit `packages/cli/src/lib/runtime/execute-route.ts`. Add to the existing imports from `@dawn-ai/core`:

```ts
import {
  // ...existing
  createWorkspaceMarker,
  loadDawnConfig,
} from "@dawn-ai/core"
```

Find the `createCapabilityRegistry([...])` block and add the marker:

```ts
const registry = createCapabilityRegistry([
  createPlanningMarker(),
  createAgentsMdMarker(),
  createSkillsMarker(),
  createSubagentsMarker(),
  createWorkspaceMarker(),
])
```

- [ ] **Step 2: Load `dawn.config.ts` once + thread backends into `applyCapabilities` context**

Before the `applyCapabilities` call (around the block that builds `descriptorRouteMap`), load the config:

```ts
let configBackends: { filesystem?: FilesystemBackend; exec?: ExecBackend } | undefined
try {
  const loaded = await loadDawnConfig({ appRoot })
  configBackends = loaded.config.backends
} catch {
  // No dawn.config.ts (or unreadable) — the workspace capability falls
  // back to its defaults (localFilesystem + localExec).
}

const applied = await applyCapabilities(registry, routeDir, {
  routeManifest,
  descriptor,
  descriptorRouteMap,
  backends: configBackends,
})
```

Add the type imports at the top:

```ts
import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
```

And add `@dawn-ai/workspace` to `packages/cli/package.json` dependencies (`pnpm add @dawn-ai/workspace --filter @dawn-ai/cli --workspace`).

- [ ] **Step 3: Run all tests**

Run: `cd /Users/blove/repos/dawn && pnpm test 2>&1 | tail -10`
Expected: all green.

Run: `cd /Users/blove/repos/dawn && pnpm build 2>&1 | tail -10`
Expected: all packages build.

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/cli/src/lib/runtime/execute-route.ts packages/cli/package.json
git commit -m "feat(cli): register workspace capability + thread backends from dawn.config

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 12: Typegen — surface workspace tools

**Files:**
- Modify: `packages/cli/src/lib/typegen/run-typegen.ts`
- Modify or create: `packages/cli/test/run-typegen.test.ts` (the existing test from sub-project 3)

- [ ] **Step 1: Read the existing pattern**

Read `packages/cli/src/lib/typegen/run-typegen.ts`. Note the `PLANNING_EXTRA_TOOL`, `SKILLS_EXTRA_TOOL`, `SUBAGENTS_EXTRA_TOOL` declarations and their `hasX(routeDir)` gates around line 21-100.

- [ ] **Step 2: Add a failing test**

Append to `packages/cli/test/run-typegen.test.ts`:

```ts
describe("typegen — workspace capability", () => {
  // Use the existing temp-dir + manifest helpers in this test file.
  it("includes readFile/writeFile/listDir/runBash for routes with a workspace/ directory", async () => {
    // Set up a tmp app with src/app/foo/{index.ts, workspace/}.
    // Run runTypegen and read .dawn/dawn.generated.d.ts.
    // Assert all four tool names appear in foo's tool union.
    // (Mirror the existing readSkill/task assertions in this file.)
  })

  it("does NOT include the four tools when workspace/ is absent", async () => {
    // Same setup minus workspace/.
    // Assert none of readFile/writeFile/listDir/runBash appear.
  })
})
```

Read the existing `task` typegen test (added in PR #156 Task 12) and mirror its structure exactly. Same helpers, same temp-dir pattern.

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli test -- run-typegen 2>&1 | tail -10`
Expected: FAIL.

- [ ] **Step 4: Add the workspace typegen entries**

Edit `packages/cli/src/lib/typegen/run-typegen.ts`. Add after `SUBAGENTS_EXTRA_TOOL`:

```ts
const WORKSPACE_EXTRA_TOOLS: readonly ExtractedToolType[] = [
  {
    name: "readFile",
    description: "Read a UTF-8 file from the workspace.",
    inputType: `{ path: string }`,
    outputType: `string`,
  },
  {
    name: "writeFile",
    description: "Write a UTF-8 file inside the workspace.",
    inputType: `{ path: string; content: string }`,
    outputType: `string`,
  },
  {
    name: "listDir",
    description: "List entries in a workspace directory.",
    inputType: `{ path?: string }`,
    outputType: `string[]`,
  },
  {
    name: "runBash",
    description: "Run a shell command inside the workspace.",
    inputType: `{ command: string }`,
    outputType: `{ stdout: string; stderr: string; exitCode: number }`,
  },
]

function hasWorkspace(routeDir: string): boolean {
  return existsSync(join(routeDir, "workspace"))
}
```

In the `extraTools` build block (the one with the existing `hasSubagents` gate), add:

```ts
if (hasWorkspace(route.routeDir)) {
  extraTools.push(...WORKSPACE_EXTRA_TOOLS)
}
```

- [ ] **Step 5: Run tests + verify**

Run: `cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/cli/src/lib/typegen/run-typegen.ts packages/cli/test/run-typegen.test.ts
git commit -m "feat(cli): typegen surfaces workspace tools for routes with workspace/

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

# Phase E — Chat example migration + smoke

### Task 13: Delete hand-rolled workspace tools from the chat example

**Files:**
- Delete: 4 files under `examples/chat/server/src/app/chat/tools/`
- Delete: 2 files under `examples/chat/server/src/app/coordinator/subagents/research/tools/`
- Delete: 2 `workspace-path.ts` helpers if unreferenced after the above

- [ ] **Step 1: Delete chat route's workspace tool files**

```bash
cd /Users/blove/repos/dawn
git rm examples/chat/server/src/app/chat/tools/readFile.ts
git rm examples/chat/server/src/app/chat/tools/writeFile.ts
git rm examples/chat/server/src/app/chat/tools/listDir.ts
git rm examples/chat/server/src/app/chat/tools/runBash.ts
```

- [ ] **Step 2: Check if `chat/workspace-path.ts` is still referenced**

Run: `cd /Users/blove/repos/dawn && grep -rn "workspace-path\b" examples/chat/server/src/app/chat/ --include="*.ts" 2>/dev/null`
Expected: no matches (only the deleted tool files referenced it). If any remain, leave the helper in place.

If no remaining references, delete:
```bash
git rm examples/chat/server/src/app/chat/workspace-path.ts
```

- [ ] **Step 3: Delete research subagent's workspace tools + helper**

```bash
git rm examples/chat/server/src/app/coordinator/subagents/research/tools/readFile.ts
git rm examples/chat/server/src/app/coordinator/subagents/research/tools/listDir.ts
```

Run: `cd /Users/blove/repos/dawn && grep -rn "workspace-path\b" examples/chat/server/src/app/coordinator/ --include="*.ts" 2>/dev/null`
Expected: no matches. Then:
```bash
git rm examples/chat/server/src/app/coordinator/subagents/research/workspace-path.ts
```

- [ ] **Step 4: Build the chat example**

Run: `cd /Users/blove/repos/dawn/examples/chat/server && pnpm build 2>&1 | tail -10`
Expected: `4 route(s) compiled` (chat, coordinator, coordinator/subagents/research, coordinator/subagents/summarizer). Build succeeds.

- [ ] **Step 5: Verify typegen surfaces the workspace tools on the routes that have a workspace/ dir**

Run:
```bash
cd /Users/blove/repos/dawn/examples/chat/server
grep -A 6 'route "/chat"' .dawn/dawn.generated.d.ts | head -20
grep -A 6 'route "/coordinator/subagents/research"' .dawn/dawn.generated.d.ts | head -20
```
Expected:
- `/chat` route's tool union contains `readFile`, `writeFile`, `listDir`, `runBash`, plus existing `writeTodos` and `readSkill`.
- `/coordinator/subagents/research` route's tool union contains the 4 workspace tools (the subagent has `workspace/` via its own dir, OR inherits the workspace convention — verify behavior matches the spec's intent. If the research subagent route doesn't have its own `workspace/` directory, ADD one before this test or accept that those tools no longer show — the spec migration assumes the workspace dir is set up correctly for each route).

If the research subagent didn't have its own workspace dir originally and was working through path manipulation, create one:

```bash
mkdir -p examples/chat/server/src/app/coordinator/subagents/research/workspace
touch examples/chat/server/src/app/coordinator/subagents/research/workspace/.gitkeep
```

(The spec convention is: each route that wants workspace tools has its own `workspace/` directory. If the existing arrangement pointed all routes at a single shared workspace, that needs review — but most likely the migration just needs the per-route dir, even if it's empty or symlinked.)

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add -A
git commit -m "$(cat <<'EOF'
refactor(examples/chat): migrate to workspace capability

Delete the hand-rolled readFile/writeFile/listDir/runBash tool files
(and their workspace-path helpers) from both the /chat route and the
research subagent. The workspace capability auto-contributes these
tools when the route has a workspace/ directory.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Smoke test via Chrome MCP web client

**Files:** none modified; this is verification only.

- [ ] **Step 1: Start dev servers**

```bash
cd /Users/blove/repos/dawn/examples/chat/server && OPENAI_API_KEY="$(grep OPENAI_API_KEY /Users/blove/repos/dawn/.env | cut -d= -f2-)" pnpm dev &
cd /Users/blove/repos/dawn/examples/chat/web && pnpm dev &
# Wait for both: "Dawn dev ready at http://127.0.0.1:3001" and "Ready in Nms"
```

- [ ] **Step 2: Drive `/chat` through the web picker**

Navigate Chrome MCP to `http://localhost:3000`. Click the `/chat` radio (it's the default). Type "Briefly list the files in the workspace." Click Send. Wait ~30 seconds.

Verify via DOM inspection (JavaScript in the page) that the SSE log contains:
- `event: tool_call data: {"name":"listDir"}` — the workspace capability's listDir tool fired
- `event: tool_result` with the listing
- `event: chunk` events streaming the agent's natural-language response
- `event: done`
- 0 errors (`subagent_failed`, recursion, etc.)

- [ ] **Step 3: Drive `/coordinator` through the picker**

Click the `/coordinator` radio. Type "Use research to read AGENTS.md and list its camelCase tool names. Then ask summarizer for a 2-bullet TL;DR." Click Send. Wait ~60 seconds.

Verify via DOM inspection:
- 2 `subagent.start` events, 2 `subagent.end` events (one each for research, summarizer)
- `subagent.tool_call` events for `readFile` (research's workspace capability)
- `subagent.message` events streaming the children's tokens
- 0 paired duplicates (raw `chunk` whose data matches a `subagent.message` chunk) — sub-project 3's bubbling fix should still hold
- `event: done` with non-empty final assistant text

- [ ] **Step 4: Kill dev servers**

```bash
pkill -f "dawn.*dev"
pkill -f "next dev -p 3000"
```

- [ ] **Step 5: If anything failed**

Debug per the failure. Likely candidates:
- A route is missing its `workspace/` dir → the capability didn't activate → no tools were contributed → the agent has nothing to call.
- The capability's path-jail rejected a path the old tool used to accept → may indicate a behavior delta from the old hand-rolled tool.

Iterate until both probes pass. No move to Task 15 until smoke is clean.

---

### Task 15: Update phase status memory + open PR

**Files:**
- Modify: `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md`

- [ ] **Step 1: Update the memory note**

Edit `project_phase_status.md`. Find:

```
4. Pluggable filesystem / exec backends (`dawn.config.ts`).
```

Replace with:

```
4. ✅ **Workspace capability + pluggable backends** — shipped in [PR #TBD](https://github.com/cacheplane/dawnai/pull/TBD). Workspace tools (readFile/writeFile/listDir/runBash) auto-contributed by a capability triggered by `<route>/workspace/`. New `@dawn-ai/workspace` package ships `FilesystemBackend`/`ExecBackend` interfaces + `localFilesystem`/`localExec` defaults + `compose`/`withFilesystemLogging`/`withExecLogging` helpers. `dawn.config.ts` switched from hand-rolled string-only parser to `tsx`-evaluated import so callable backends can be expressed. Path-jail enforced in the capability; backends receive resolved absolute paths. Tool override pathway: write `tools/<name>.ts` to shadow a capability-contributed tool. Chat example's hand-rolled workspace tools deleted. HITL permission gating for jail escapes deferred to sub-project 4.5.
```

Update the top summary to show 6/7 sub-projects shipped (still in Phase 3).

- [ ] **Step 2: Push the branch + open the PR**

```bash
cd /Users/blove/repos/dawn
git push -u origin claude/phase3-workspace
```

```bash
gh pr create --title "feat(core,cli,workspace): phase 3 — workspace capability + pluggable backends (sub-project 4)" --body "$(cat <<'EOF'
## Summary

Sub-project 4 of the Dawn opinionated agent harness. The workspace
tools (readFile/writeFile/listDir/runBash) move from hand-rolled
per-route files into a built-in capability auto-wired by the
`workspace/` directory convention. Filesystem and exec implementations
become pluggable via a new `@dawn-ai/workspace` package; defaults
preserve existing behavior so apps that don't touch `dawn.config.ts`
keep working unchanged.

`dawn.config.ts` loader switches from a hand-rolled string-only
parser to a `tsx`-evaluated import so callable backend values can be
expressed naturally.

## Changes

- New `@dawn-ai/workspace` package: `FilesystemBackend` / `ExecBackend`
  type interfaces, `localFilesystem()` and `localExec()` defaults,
  `compose()` helper for middleware composition, demonstration
  `withFilesystemLogging` / `withExecLogging` middlewares.
- New `createWorkspaceMarker()` capability in `@dawn-ai/core`. Detects
  the `workspace/` directory under a route; contributes four tools
  routed through the configured backends; enforces path-jail before
  calling the backend so backends receive trusted absolute paths.
- `DawnConfig` and `CapabilityMarkerContext` gain an optional
  `backends: { filesystem?, exec? }` field. When omitted, the
  capability falls back to `localFilesystem()` + `localExec()`.
- Tool-name uniqueness check supports overridable capability tools:
  user-authored `tools/readFile.ts` (etc.) replaces the workspace
  capability's contribution; non-overridable capability tools
  (writeTodos, readSkill, task) retain the collision error.
- Typegen surfaces the four workspace tools on routes with a
  `workspace/` directory.
- Chat example's hand-rolled tool files delete from `/chat` and from
  `/coordinator/subagents/research`.

## Test plan

- [x] `@dawn-ai/workspace` unit tests: types + localFilesystem (5) +
  localExec (4) + compose (3) + with-logging (3) = 15 cases
- [x] `createWorkspaceMarker` unit tests: detect, load, tool wiring,
  path-jail, default backends, override flag (8 cases)
- [x] `checkToolNameUniqueness` overridable cases (2 new cases)
- [x] Config loader rewrite: 6 cases including syntax-error
  propagation
- [x] Typegen: workspace tools appear when `workspace/` exists, absent
  otherwise (2 cases)
- [x] Full repo green; build + typecheck + lint clean
- [x] Manual Chrome MCP smoke: `/chat` and `/coordinator` both produce
  clean SSE streams; 0 duplicates; 0 errors; `done` event fires

## Deferred / known limitations

- **HITL permission system (sub-project 4.5)** — the capability hard-
  refuses jail escapes today. A future PR introduces an `interrupt()`
  flow so the user can grant per-path permissions, with persistence
  to a yet-to-be-decided location (likely `.dawn/permissions.json`).
- **Per-route backend override** — currently global only. Add via
  descriptor field if a real use case surfaces.
- **OS-level isolation** — out of scope; documented as deployment
  guidance. The path-jail in the capability is a correctness boundary,
  not a security boundary against hostile agents.
- **Backend method extensibility** — adding methods beyond the four
  standard ones does NOT auto-contribute tools. Authors write
  additional tools in `tools/` as today.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Update the memory note with the real PR number**

Once the PR is created, replace `[PR #TBD]` with the actual URL.

- [ ] **Step 4: Auto-merge on green**

```bash
gh pr merge --squash --delete-branch --auto
```

Wait for validate-green. Once merged, the sub-project is complete.

---

## Self-review notes

- **Spec coverage:** every section of the spec maps to a task. New package (T1-6). Config loader switch (T7). DawnConfig + CapabilityMarkerContext extension (T8). Marker implementation (T9). Tool override inversion (T10). Runtime wiring (T11). Typegen (T12). Chat example migration (T13). Smoke (T14). Memory update + PR (T15).
- **Placeholders:** none. Every step has actual code or actual commands. The `hasWorkspace` typegen test's body is intentionally outlined rather than fully written because it mirrors the existing `task` typegen test in the same file — the implementer should copy that test's structure (which I've called out explicitly in Step 1).
- **Type consistency:** `FilesystemBackend` / `ExecBackend` / `BackendContext` signatures stable from T2 through T9. `OverridableTool` shape locked in T9. `effectiveCapabilityTools` from T10 used in T11 (implicitly via the existing call site). Path-jail signature stable.
- **One known sharp edge:** T11's `effectiveCapabilityTools` usage requires `execute-route.ts`'s tool-merge to filter `capTools` by the names in the effective set rather than iterating `capTools` directly. The plan calls this out explicitly. If T10's API doesn't end up returning `effectiveCapabilityTools`, T11's implementation needs adjustment.
