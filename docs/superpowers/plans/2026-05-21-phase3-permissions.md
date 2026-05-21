# Phase 3 — HITL Permissions Implementation Plan (sub-project 4.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workspace capability's hard-refuse-on-path-jail-escape behavior with a human-in-the-loop interrupt flow, and add the same prompt-for-approval gating to `runBash` and all path-touching operations outside the workspace. Three operating modes (interactive / non-interactive / bypass) configurable in `dawn.config.ts` and overridable via `DAWN_PERMISSIONS_MODE` env var. Persisted decisions live in `.dawn/permissions.json` (project-local, gitignored).

**Architecture:** New `@dawn-ai/permissions` package ships `PermissionsStore` (file I/O + pattern matching + write queue), public types, smart-default pattern inference. Workspace capability adds a permission check between path-jail / bash invocation and the backend call. Dawn's HTTP dev server (`packages/cli/src/lib/dev/runtime-server.ts`) gains a `POST /threads/:thread_id/resume` endpoint. Agent adapter propagates LangGraph `interrupt()` events as `event: interrupt` SSE envelopes. Chat-web client renders an inline permission panel and proxies resume calls.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, zod, LangGraph 1.x `interrupt()` + `Command({resume})`, native `node:http`, Next.js 16.

**Spec:** `docs/superpowers/specs/2026-05-21-phase3-permissions-design.md`

---

## File Structure (locked here, used by all tasks)

### New package

| Path | Purpose |
|---|---|
| `packages/permissions/package.json` | `@dawn-ai/permissions` manifest |
| `packages/permissions/tsconfig.json` | TS config (mirror sibling packages) |
| `packages/permissions/vitest.config.ts` | Vitest config |
| `packages/permissions/src/index.ts` | Barrel re-exports |
| `packages/permissions/src/types.ts` | `PermissionsFile`, `PermissionMode`, `PermissionRequest`, `PermissionDecision`, `PermissionsStore` interface |
| `packages/permissions/src/pattern-matching.ts` | `match(tool, candidate, allowMap, denyMap)` → `"allow" | "deny" | "unknown"` |
| `packages/permissions/src/suggested-pattern.ts` | `suggestedCommandPattern(cmd)` + `suggestedPathPattern(path)` |
| `packages/permissions/src/permissions-store.ts` | `createPermissionsStore({appRoot, config, mode})` — load, match, addAllow, gitignore handling, write queue |
| `packages/permissions/test/*.test.ts` | Unit tests per file |

### New + modified in existing packages

| Path | Change |
|---|---|
| `packages/core/package.json` | Add `@dawn-ai/permissions` to dependencies |
| `packages/core/src/types.ts` | Extend `DawnConfig` with `permissions?: { mode, allow, deny }` |
| `packages/core/src/capabilities/types.ts` | Extend `CapabilityMarkerContext` with `permissions?: PermissionsStore` |
| `packages/core/src/capabilities/built-in/workspace.ts` | Gate every tool's `run()` through the permissions store; mode-aware path-jail (bypass disables) |
| `packages/core/test/capabilities/workspace.test.ts` | Add interrupt-flow tests |
| `packages/cli/src/lib/runtime/execute-route.ts` | Construct `PermissionsStore` from loaded config + env-var override; thread into `CapabilityMarkerContext` |
| `packages/cli/src/lib/dev/runtime-server.ts` | Register `POST /threads/:thread_id/resume` route + thread-state map |
| `packages/cli/test/resume-endpoint.test.ts` | New — endpoint tests |
| `packages/langchain/src/agent-adapter.ts` | Detect LangGraph `interrupt` events in `streamEvents` v2 output → yield `{type: "interrupt", data: ...}` chunks; handle `Command({resume})` re-invocation path |
| `packages/langchain/test/agent-adapter-interrupt.test.ts` | New — interrupt propagation test |
| `examples/chat/server/dawn.config.ts` | Seeded `permissions.allow` for demo (`bash: ["ls"]`) and `permissions.deny` (`bash: ["rm -rf", "sudo"]`) |
| `examples/chat/web/app/api/permission-resume/route.ts` | New — proxy to Dawn's resume endpoint |
| `examples/chat/web/app/page.tsx` | Inline permission panel + button handlers + resume POST |
| `memory/project_phase_status.md` | Mark sub-project 4.5 |

---

## Phase A — `@dawn-ai/permissions` package

### Task 1: Scaffold the permissions package

**Files:**
- Create: `packages/permissions/package.json`
- Create: `packages/permissions/tsconfig.json`
- Create: `packages/permissions/vitest.config.ts`
- Create: `packages/permissions/src/index.ts`

- [ ] **Step 1: Inspect sibling pattern**

Run: `cd /Users/blove/repos/dawn && cat packages/workspace/package.json`
Note the exact catalog references and devDeps (workspace is the most-recent sibling and the closest template).

- [ ] **Step 2: Write `packages/permissions/package.json`**

Mirror `packages/workspace/package.json` exactly, substituting:
- `name`: `"@dawn-ai/permissions"`
- `version`: match siblings (likely `0.1.8`)

No runtime deps yet. Same scripts (`build`, `test`, `typecheck`, `lint`).

- [ ] **Step 3: Write `packages/permissions/tsconfig.json`**

```json
{
  "extends": "@dawn-ai/config-typescript/node.json",
  "include": ["src", "test"],
  "compilerOptions": { "outDir": "dist", "rootDir": "." }
}
```

(Match `packages/workspace/tsconfig.json` exactly — copy-paste then adjust paths.)

- [ ] **Step 4: Write `packages/permissions/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
})
```

- [ ] **Step 5: Write `packages/permissions/src/index.ts`**

```ts
// Re-exports will be added as types and impls land in subsequent tasks.
export {}
```

- [ ] **Step 6: Verify**

```bash
cd /Users/blove/repos/dawn && pnpm install 2>&1 | tail -3
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions build 2>&1 | tail -5
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions test 2>&1 | tail -5
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions lint 2>&1 | tail -5
```

All should succeed (test passes with no test files).

- [ ] **Step 7: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/permissions/
git commit -m "scaffold(permissions): empty @dawn-ai/permissions package

Adds the package skeleton for the upcoming HITL permissions system.
No exports yet — types, pattern matching, and store land in subsequent
commits.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Public types

**Files:**
- Create: `packages/permissions/src/types.ts`
- Modify: `packages/permissions/src/index.ts`

- [ ] **Step 1: Write `packages/permissions/src/types.ts`**

```ts
/**
 * Public types for the Dawn HITL permissions system.
 *
 * The workspace capability calls into a `PermissionsStore` before
 * invoking its filesystem/exec backends. The store consults the
 * runtime file at .dawn/permissions.json plus the config-seeded
 * allow/deny lists and returns one of three decisions: "allow",
 * "deny", or "unknown". On "unknown" in interactive mode the
 * capability emits LangGraph's `interrupt()` with a `PermissionRequest`
 * payload; the resume mechanism returns a `PermissionDecision`.
 */

export type PermissionMode = "interactive" | "non-interactive" | "bypass"

export type PermissionDecision = "once" | "always" | "deny"

export interface PermissionsFile {
  readonly version: 1
  readonly allow: Readonly<Record<string, readonly string[]>>
  readonly deny: Readonly<Record<string, readonly string[]>>
}

export interface CommandDetail {
  readonly command: string
  readonly suggestedPattern: string
}

export interface PathDetail {
  readonly path: string
  readonly operation: "readFile" | "writeFile" | "listDir"
  readonly suggestedPattern: string
}

export interface PermissionRequest {
  readonly interruptId: string
  readonly kind: "command" | "path"
  readonly detail: CommandDetail | PathDetail
  readonly threadId: string
  readonly callId?: string
}

export interface PermissionsStore {
  /** Loaded once at construction; subsequent loads not exposed in v1. */
  match(tool: string, candidate: string): "allow" | "deny" | "unknown"
  /** Persists an allow entry to disk and updates the in-memory cache. */
  addAllow(tool: string, pattern: string): Promise<void>
  /** Active mode (resolved from config + env at construction). */
  readonly mode: PermissionMode
}
```

- [ ] **Step 2: Re-export from barrel**

Edit `packages/permissions/src/index.ts`. Replace with:

```ts
export type {
  CommandDetail,
  PathDetail,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionsFile,
  PermissionsStore,
} from "./types.js"
```

- [ ] **Step 3: Verify**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions build 2>&1 | tail -3
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions typecheck 2>&1 | tail -3
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions lint 2>&1 | tail -3
```

Expect: all clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/permissions/src/types.ts packages/permissions/src/index.ts
git commit -m "feat(permissions): public types

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Suggested-pattern helpers

**Files:**
- Create: `packages/permissions/src/suggested-pattern.ts`
- Create: `packages/permissions/test/suggested-pattern.test.ts`
- Modify: `packages/permissions/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/permissions/test/suggested-pattern.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  suggestedCommandPattern,
  suggestedPathPattern,
} from "../src/suggested-pattern.js"

describe("suggestedCommandPattern", () => {
  it("returns the first two tokens for a multi-word command", () => {
    expect(suggestedCommandPattern("npm install react")).toBe("npm install")
  })

  it("returns the single token for a one-word command", () => {
    expect(suggestedCommandPattern("ls")).toBe("ls")
  })

  it("returns first two tokens even when the second is short", () => {
    expect(suggestedCommandPattern("git status")).toBe("git status")
    expect(suggestedCommandPattern("git push origin main")).toBe("git push")
  })

  it("strips leading/trailing whitespace before tokenizing", () => {
    expect(suggestedCommandPattern("  npm  install  react  ")).toBe("npm install")
  })

  it("handles empty input as empty pattern", () => {
    expect(suggestedCommandPattern("")).toBe("")
    expect(suggestedCommandPattern("   ")).toBe("")
  })
})

describe("suggestedPathPattern", () => {
  it("returns the parent directory with trailing slash", () => {
    expect(suggestedPathPattern("/Users/blove/.zshrc")).toBe("/Users/blove/")
    expect(suggestedPathPattern("/var/log/app.log")).toBe("/var/log/")
  })

  it("returns the dir itself with trailing slash when input ends with slash", () => {
    expect(suggestedPathPattern("/Users/blove/Documents/")).toBe("/Users/blove/Documents/")
  })

  it("returns root when input is a top-level file", () => {
    expect(suggestedPathPattern("/etc")).toBe("/")
  })

  it("handles relative paths", () => {
    expect(suggestedPathPattern("notes/agenda.md")).toBe("notes/")
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions test 2>&1 | tail -10
```
Expect: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/permissions/src/suggested-pattern.ts`:

```ts
import { dirname } from "node:path"

/**
 * Default suggested pattern for a shell command.
 *
 * Returns the first two whitespace-separated tokens. `npm install react`
 * → `npm install`. `ls` → `ls`. This is the sweet spot — covers
 * `npm install <X>` and `npm test` as distinct patterns, vs lumping
 * everything under `npm`.
 */
export function suggestedCommandPattern(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length === 0) return ""
  const tokens = trimmed.split(/\s+/)
  return tokens.slice(0, 2).join(" ")
}

/**
 * Default suggested pattern for a filesystem path.
 *
 * Returns the parent directory of the path with a trailing slash.
 * `/Users/blove/.zshrc` → `/Users/blove/`. Trailing slash makes
 * prefix matching unambiguous (so `/var/log/` does not match
 * `/var/logger/app.log`).
 */
export function suggestedPathPattern(path: string): string {
  if (path.endsWith("/")) return path
  const parent = dirname(path)
  return parent === "/" ? "/" : `${parent}/`
}
```

- [ ] **Step 4: Re-export**

Edit `packages/permissions/src/index.ts`. Append:

```ts
export { suggestedCommandPattern, suggestedPathPattern } from "./suggested-pattern.js"
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions test 2>&1 | tail -5
```
Expect: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/permissions/src/suggested-pattern.ts \
        packages/permissions/test/suggested-pattern.test.ts \
        packages/permissions/src/index.ts
git commit -m "feat(permissions): suggested-pattern helpers for commands and paths

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Pattern matching

**Files:**
- Create: `packages/permissions/src/pattern-matching.ts`
- Create: `packages/permissions/test/pattern-matching.test.ts`
- Modify: `packages/permissions/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/permissions/test/pattern-matching.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { matchPermission } from "../src/pattern-matching.js"

describe("matchPermission", () => {
  it("returns unknown when no entries match", () => {
    expect(
      matchPermission("bash", "npm install", {}, {}),
    ).toBe("unknown")
  })

  it("returns allow when candidate matches an allow prefix", () => {
    expect(
      matchPermission("bash", "npm install react", { bash: ["npm install"] }, {}),
    ).toBe("allow")
  })

  it("returns deny when candidate matches a deny prefix", () => {
    expect(
      matchPermission("bash", "rm -rf /tmp", {}, { bash: ["rm -rf"] }),
    ).toBe("deny")
  })

  it("deny wins over allow when both match", () => {
    expect(
      matchPermission(
        "bash",
        "rm -rf /tmp",
        { bash: ["rm"] },  // would match "rm -rf /tmp" as prefix? No — "rm " vs "rm -rf"
        { bash: ["rm -rf"] },
      ),
    ).toBe("deny")
  })

  it("does NOT match an allow entry that is not a prefix", () => {
    expect(
      matchPermission("bash", "npm test", { bash: ["npm install"] }, {}),
    ).toBe("unknown")
  })

  it("treats path candidates with absolute prefixes", () => {
    expect(
      matchPermission(
        "readFile",
        "/Users/blove/.zshrc",
        { readFile: ["/Users/blove/"] },
        {},
      ),
    ).toBe("allow")
  })

  it("does not cross directory boundary without trailing slash", () => {
    // /var/logger/app.log should NOT match allow=/var/log (no trailing slash)
    // because /var/log is a prefix string of /var/logger. With trailing slash
    // it does NOT match.
    expect(
      matchPermission(
        "readFile",
        "/var/logger/app.log",
        { readFile: ["/var/log/"] },
        {},
      ),
    ).toBe("unknown")
  })

  it("returns unknown for a tool with no entries in either list", () => {
    expect(
      matchPermission(
        "runUnknownTool",
        "anything",
        { bash: ["ls"] },
        { writeFile: ["/tmp/"] },
      ),
    ).toBe("unknown")
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions test 2>&1 | tail -8
```
Expect: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/permissions/src/pattern-matching.ts`:

```ts
type PatternMap = Readonly<Record<string, readonly string[]>>

/**
 * Match a tool+candidate against allow + deny pattern maps.
 *
 * Semantics:
 *   - deny wins over allow (a candidate that matches both returns "deny")
 *   - prefix matching: `candidate.startsWith(pattern)`
 *   - no entries for tool in either map → "unknown"
 *
 * Patterns are expected to encode any required boundary themselves (e.g.,
 * path patterns should end with "/" to prevent crossing directory
 * boundaries; command patterns are first-N tokens already).
 */
export function matchPermission(
  tool: string,
  candidate: string,
  allow: PatternMap,
  deny: PatternMap,
): "allow" | "deny" | "unknown" {
  const denyList = deny[tool] ?? []
  for (const pattern of denyList) {
    if (candidate.startsWith(pattern)) return "deny"
  }
  const allowList = allow[tool] ?? []
  for (const pattern of allowList) {
    if (candidate.startsWith(pattern)) return "allow"
  }
  return "unknown"
}
```

- [ ] **Step 4: Re-export**

Edit `packages/permissions/src/index.ts`. Append:

```ts
export { matchPermission } from "./pattern-matching.js"
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions test 2>&1 | tail -5
```
Expect: PASS (17 total: 9 + 8 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/permissions/src/pattern-matching.ts \
        packages/permissions/test/pattern-matching.test.ts \
        packages/permissions/src/index.ts
git commit -m "feat(permissions): pattern-matching engine (allow/deny/unknown)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: PermissionsStore

**Files:**
- Create: `packages/permissions/src/permissions-store.ts`
- Create: `packages/permissions/test/permissions-store.test.ts`
- Modify: `packages/permissions/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/permissions/test/permissions-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPermissionsStore } from "../src/permissions-store.js"
import type { PermissionsFile } from "../src/types.js"

describe("createPermissionsStore — load + match", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-perms-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("returns unknown when no file or config", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install")).toBe("unknown")
  })

  it("matches entries from .dawn/permissions.json", async () => {
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({
        version: 1,
        allow: { bash: ["npm install"] },
        deny: {},
      }),
      { encoding: "utf8", flag: "w" },
    )
    // mkdir is needed before writeFileSync — adjust:
    // Actually the test should use mkdirSync first
  })
})
```

(Wait — let me rewrite this test more carefully. The implementer should follow the corrected version below.)

Use this corrected test file:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPermissionsStore } from "../src/permissions-store.js"

describe("createPermissionsStore — load + match", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-perms-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("returns unknown when no file and no config", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install")).toBe("unknown")
  })

  it("matches entries from .dawn/permissions.json", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({
        version: 1,
        allow: { bash: ["npm install"] },
        deny: {},
      }),
    )
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install react")).toBe("allow")
    expect(store.match("bash", "rm -rf /")).toBe("unknown")
  })

  it("merges config + runtime file (both contribute allows)", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["ls"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { bash: ["npm install"] }, deny: {} },
      mode: "interactive",
    })
    await store.load()
    expect(store.match("bash", "ls -la")).toBe("allow")
    expect(store.match("bash", "npm install react")).toBe("allow")
  })

  it("deny from config wins over allow from runtime file", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["rm"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { bash: ["rm -rf"] } },
      mode: "interactive",
    })
    await store.load()
    expect(store.match("bash", "rm -rf /tmp")).toBe("deny")
  })

  it("ignores the runtime file in non-interactive mode", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["npm install"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { bash: ["ls"] }, deny: {} },
      mode: "non-interactive",
    })
    await store.load()
    expect(store.match("bash", "npm install react")).toBe("unknown")
    expect(store.match("bash", "ls -la")).toBe("allow")
  })

  it("ignores everything in bypass mode", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: {}, deny: { bash: ["rm"] } }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { bash: ["rm"] } },
      mode: "bypass",
    })
    await store.load()
    // bypass mode: store always returns "unknown" (which the capability interprets as "go ahead")
    expect(store.match("bash", "rm -rf /")).toBe("unknown")
  })

  it("throws on malformed JSON in the runtime file", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(join(appRoot, ".dawn", "permissions.json"), "{ not valid json")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await expect(store.load()).rejects.toThrow(/permissions\.json/i)
  })
})

describe("createPermissionsStore — addAllow", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-perms-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("persists an allow entry and updates the in-memory cache atomically", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install")).toBe("unknown")
    await store.addAllow("bash", "npm install")
    expect(store.match("bash", "npm install react")).toBe("allow")
    const raw = readFileSync(join(appRoot, ".dawn", "permissions.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.allow.bash).toContain("npm install")
  })

  it("appends .dawn/ to .gitignore on first write (idempotent)", async () => {
    writeFileSync(join(appRoot, ".gitignore"), "node_modules/\n.next/\n")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi).toContain(".dawn/")
    expect(gi).toContain("node_modules/") // preserved existing
  })

  it("creates .gitignore with .dawn/ when none exists", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi).toBe(".dawn/\n")
  })

  it("does not duplicate .dawn/ if already in .gitignore", async () => {
    writeFileSync(join(appRoot, ".gitignore"), "node_modules/\n.dawn/\n")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi.match(/\.dawn\//g)?.length).toBe(1)
  })

  it("serializes concurrent addAllow calls", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await Promise.all([
      store.addAllow("bash", "ls"),
      store.addAllow("bash", "pwd"),
      store.addAllow("bash", "cat"),
    ])
    const raw = readFileSync(join(appRoot, ".dawn", "permissions.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect([...parsed.allow.bash].sort()).toEqual(["cat", "ls", "pwd"])
  })

  it("exposes the resolved mode", () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "non-interactive" })
    expect(store.mode).toBe("non-interactive")
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions test 2>&1 | tail -10
```
Expect: FAIL — `Cannot find module '../src/permissions-store.js'`.

- [ ] **Step 3: Implement**

Create `packages/permissions/src/permissions-store.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { matchPermission } from "./pattern-matching.js"
import type {
  PermissionMode,
  PermissionsFile,
  PermissionsStore,
} from "./types.js"

const PERMISSIONS_DIR = ".dawn"
const PERMISSIONS_FILE = "permissions.json"

interface CreateOptions {
  readonly appRoot: string
  readonly config: PermissionsFile | undefined
  readonly mode: PermissionMode
}

type MutableMap = Record<string, string[]>

interface State {
  configAllow: MutableMap
  configDeny: MutableMap
  runtimeAllow: MutableMap
  runtimeDeny: MutableMap
}

function emptyState(): State {
  return { configAllow: {}, configDeny: {}, runtimeAllow: {}, runtimeDeny: {} }
}

function cloneMap(src: Readonly<Record<string, readonly string[]>>): MutableMap {
  const out: MutableMap = {}
  for (const [k, v] of Object.entries(src)) out[k] = [...v]
  return out
}

function effectiveAllow(state: State, mode: PermissionMode): Record<string, string[]> {
  if (mode === "bypass") return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(state.configAllow)) out[k] = [...v]
  if (mode === "interactive") {
    for (const [k, v] of Object.entries(state.runtimeAllow)) {
      out[k] = [...(out[k] ?? []), ...v]
    }
  }
  return out
}

function effectiveDeny(state: State, mode: PermissionMode): Record<string, string[]> {
  if (mode === "bypass") return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(state.configDeny)) out[k] = [...v]
  if (mode === "interactive") {
    for (const [k, v] of Object.entries(state.runtimeDeny)) {
      out[k] = [...(out[k] ?? []), ...v]
    }
  }
  return out
}

export function createPermissionsStore(opts: CreateOptions): PermissionsStore {
  const { appRoot, config, mode } = opts
  const state = emptyState()
  if (config) {
    state.configAllow = cloneMap(config.allow)
    state.configDeny = cloneMap(config.deny)
  }

  let writeQueue: Promise<void> = Promise.resolve()

  async function loadRuntimeFile(): Promise<void> {
    const filePath = join(appRoot, PERMISSIONS_DIR, PERMISSIONS_FILE)
    if (!existsSync(filePath)) return
    let raw: string
    try {
      raw = await readFile(filePath, "utf8")
    } catch (err) {
      throw new Error(`Failed to read permissions.json: ${(err as Error).message}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`Malformed permissions.json: ${(err as Error).message}`)
    }
    const p = parsed as Partial<PermissionsFile>
    if (p.allow && typeof p.allow === "object") state.runtimeAllow = cloneMap(p.allow as Record<string, readonly string[]>)
    if (p.deny && typeof p.deny === "object") state.runtimeDeny = cloneMap(p.deny as Record<string, readonly string[]>)
  }

  async function persistRuntimeFile(): Promise<void> {
    const dir = join(appRoot, PERMISSIONS_DIR)
    await mkdir(dir, { recursive: true })
    const file: PermissionsFile = {
      version: 1,
      allow: state.runtimeAllow,
      deny: state.runtimeDeny,
    }
    await writeFile(join(dir, PERMISSIONS_FILE), `${JSON.stringify(file, null, 2)}\n`, "utf8")
  }

  async function ensureGitignoreEntry(): Promise<void> {
    const gitignorePath = join(appRoot, ".gitignore")
    let content = ""
    if (existsSync(gitignorePath)) {
      content = await readFile(gitignorePath, "utf8")
      if (content.split("\n").some((line) => line.trim() === ".dawn/")) return
      if (!content.endsWith("\n") && content.length > 0) content += "\n"
      content += ".dawn/\n"
    } else {
      content = ".dawn/\n"
    }
    await writeFile(gitignorePath, content, "utf8")
  }

  return {
    mode,
    match(tool: string, candidate: string) {
      return matchPermission(tool, candidate, effectiveAllow(state, mode), effectiveDeny(state, mode))
    },
    async load() {
      if (mode === "interactive") {
        await loadRuntimeFile()
      }
    },
    async addAllow(tool: string, pattern: string) {
      const job = async () => {
        const list = state.runtimeAllow[tool] ?? []
        if (!list.includes(pattern)) list.push(pattern)
        state.runtimeAllow[tool] = list
        await persistRuntimeFile()
        await ensureGitignoreEntry()
      }
      writeQueue = writeQueue.then(job, job)
      await writeQueue
    },
  }
}
```

- [ ] **Step 4: Re-export**

Edit `packages/permissions/src/index.ts`. Append:

```ts
export { createPermissionsStore } from "./permissions-store.js"
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions test 2>&1 | tail -10
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions build 2>&1 | tail -3
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/permissions lint 2>&1 | tail -3
```
Expect: PASS (~28 tests total), build + lint clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/permissions/src/permissions-store.ts \
        packages/permissions/test/permissions-store.test.ts \
        packages/permissions/src/index.ts
git commit -m "feat(permissions): PermissionsStore with file I/O + write queue + gitignore handling

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase B — Config + capability changes

### Task 6: Extend DawnConfig + CapabilityMarkerContext

**Files:**
- Modify: `packages/core/package.json` — add `@dawn-ai/permissions` to devDependencies (type-only for now)
- Modify: `packages/core/src/types.ts` — extend `DawnConfig`
- Modify: `packages/core/src/capabilities/types.ts` — extend `CapabilityMarkerContext`

- [ ] **Step 1: Add permissions package as type-only dep**

Edit `packages/core/package.json`. Add to `devDependencies`:

```json
"@dawn-ai/permissions": "workspace:*"
```

Run: `cd /Users/blove/repos/dawn && pnpm install --silent 2>&1 | tail -3`

- [ ] **Step 2: Extend `DawnConfig`**

Edit `packages/core/src/types.ts`. Add to the existing imports:

```ts
import type { PermissionMode } from "@dawn-ai/permissions"
```

Find the `DawnConfig` interface and extend:

```ts
export interface DawnConfig {
  readonly appDir?: string
  readonly backends?: {
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
  readonly permissions?: {
    readonly mode?: PermissionMode
    readonly allow?: Readonly<Record<string, readonly string[]>>
    readonly deny?: Readonly<Record<string, readonly string[]>>
  }
}
```

- [ ] **Step 3: Extend `CapabilityMarkerContext`**

Edit `packages/core/src/capabilities/types.ts`. Add to imports:

```ts
import type { PermissionsStore } from "@dawn-ai/permissions"
```

Find `CapabilityMarkerContext` and extend:

```ts
export interface CapabilityMarkerContext {
  // ... existing fields
  readonly permissions?: PermissionsStore
}
```

- [ ] **Step 4: Verify**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core typecheck 2>&1 | tail -3
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core lint 2>&1 | tail -3
cd /Users/blove/repos/dawn && pnpm test 2>&1 | tail -8
```
Expect: clean, full repo still green.

- [ ] **Step 5: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/core/package.json packages/core/src/types.ts packages/core/src/capabilities/types.ts
git commit -m "feat(core): extend DawnConfig + CapabilityMarkerContext with permissions

Type-only edge to @dawn-ai/permissions. Workspace capability will read
context.permissions in a subsequent commit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Workspace capability gates through PermissionsStore

**Files:**
- Modify: `packages/core/src/capabilities/built-in/workspace.ts`
- Modify: `packages/core/test/capabilities/workspace.test.ts`
- Modify: `packages/core/package.json` (promote permissions from devDep to dep — runtime use)

- [ ] **Step 1: Promote permissions package to runtime dep**

Edit `packages/core/package.json`. Move `@dawn-ai/permissions` from `devDependencies` to `dependencies`. Run `pnpm install`.

- [ ] **Step 2: Add failing tests**

Append to `packages/core/test/capabilities/workspace.test.ts`:

```ts
import { createPermissionsStore } from "@dawn-ai/permissions"
import type { PermissionsStore } from "@dawn-ai/permissions"

describe("createWorkspaceMarker — permissions gating", () => {
  let routeDir: string
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-perm-cap-"))
    routeDir = appRoot
    mkdirSync(join(appRoot, "workspace"))
    process.chdir(appRoot)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function makeStore(mode: "interactive" | "non-interactive" | "bypass", config?: { allow?: Record<string, string[]>; deny?: Record<string, string[]> }): Promise<PermissionsStore> {
    const store = createPermissionsStore({
      appRoot,
      config: config
        ? { version: 1, allow: config.allow ?? {}, deny: config.deny ?? {} }
        : undefined,
      mode,
    })
    await store.load()
    return store
  }

  it("calls the backend normally when path matches allow", async () => {
    writeFileSync(join(appRoot, "workspace", "ok.txt"), "ok", "utf8")
    const permissions = await makeStore("non-interactive", {
      allow: { readFile: [join(appRoot, "workspace") + "/"] },
    })
    const contribution = await createWorkspaceMarker().load(routeDir, ctx({ permissions }))
    const readTool = contribution.tools!.find((t) => t.name === "readFile")!
    const result = await readTool.run(
      { path: "ok.txt" },
      { signal: new AbortController().signal },
    )
    expect(result).toBe("ok")
  })

  it("returns a deny error to the agent when path matches deny", async () => {
    writeFileSync(join(appRoot, "workspace", "blocked.txt"), "x", "utf8")
    const permissions = await makeStore("non-interactive", {
      deny: { readFile: [join(appRoot, "workspace") + "/blocked"] },
    })
    const contribution = await createWorkspaceMarker().load(routeDir, ctx({ permissions }))
    const readTool = contribution.tools!.find((t) => t.name === "readFile")!
    await expect(
      readTool.run({ path: "blocked.txt" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/permission denied/i)
  })

  it("in non-interactive mode, unknown commands hard-refuse", async () => {
    const permissions = await makeStore("non-interactive")
    const contribution = await createWorkspaceMarker().load(routeDir, ctx({ permissions }))
    const runBash = contribution.tools!.find((t) => t.name === "runBash")!
    await expect(
      runBash.run({ command: "ls" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/permission denied|fail-closed/i)
  })

  it("in bypass mode, every operation proceeds (path-jail disabled)", async () => {
    const permissions = await makeStore("bypass")
    const contribution = await createWorkspaceMarker().load(routeDir, ctx({ permissions }))
    const readTool = contribution.tools!.find((t) => t.name === "readFile")!
    // In bypass mode, reading outside the workspace should NOT raise "outside workspace"
    // (it might raise ENOENT instead because the file doesn't exist).
    await expect(
      readTool.run({ path: "../../etc/some-fake-file" }, { signal: new AbortController().signal }),
    ).rejects.not.toThrow(/outside workspace/i)
  })
})
```

(Note: this assumes `process.chdir` is already in the existing `workspace.test.ts` from sub-project 4 — verify by reading the file. Adjust the new tests to share the same setup.)

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core test -- workspace 2>&1 | tail -15
```
Expect: FAIL — capability ignores `context.permissions`.

- [ ] **Step 4: Update the capability**

Edit `packages/core/src/capabilities/built-in/workspace.ts`. Add imports:

```ts
import type { PermissionsStore } from "@dawn-ai/permissions"
```

Change `buildWorkspaceTools` signature to accept the optional store:

```ts
function buildWorkspaceTools(
  workspaceRoot: string,
  fs: FilesystemBackend,
  exec: ExecBackend,
  permissions: PermissionsStore | undefined,
): readonly OverridableTool[] { /* ... */ }
```

Add a helper for gating:

```ts
async function gate(
  permissions: PermissionsStore | undefined,
  tool: string,
  candidate: string,
): Promise<"allow" | "deny" | "unknown"> {
  if (!permissions) return "allow" // capability used without permissions context = legacy behavior, allow
  if (permissions.mode === "bypass") return "allow"
  return permissions.match(tool, candidate)
}
```

In each tool's `run`:

- For path tools (`readFile`/`writeFile`/`listDir`): resolve the path first, then check:
  - If the path is INSIDE the workspace: allow silently (the workspace is the trusted area; no need to gate every read of `workspace/notes.md`).
  - If the path is OUTSIDE the workspace OR if `permissions.mode === "bypass"`: skip the jail check; consult `gate()`. If `"deny"` → throw `Permission denied by user: ${path}`. If `"unknown"` AND mode === "interactive" → emit interrupt; AND mode === "non-interactive" → throw "Permission denied (fail-closed)". If `"allow"` → proceed.

```ts
// readFile (rewritten):
run: async (input, ctx) => {
  const { path } = READ_FILE_INPUT.parse(input)
  const absPath = resolve(workspaceRoot, path)
  const insideWorkspace =
    absPath === workspaceRoot || absPath.startsWith(workspaceRoot + sep)

  if (!insideWorkspace || permissions?.mode === "bypass") {
    // Consult permissions for the operation
    const decision = await gate(permissions, "readFile", absPath)
    if (decision === "deny") {
      throw new Error(`Permission denied by user: ${path}`)
    }
    if (decision === "unknown") {
      if (permissions?.mode === "non-interactive") {
        throw new Error(`Permission denied (fail-closed): ${path}`)
      }
      // interactive: emit LangGraph interrupt() — handled by helper (see Task 8)
      const result = await requestPermissionInterrupt({
        kind: "path",
        operation: "readFile",
        path: absPath,
        permissions,
      })
      if (result === "deny") {
        throw new Error(`Permission denied by user: ${path}`)
      }
      // "allow" — proceed
    }
  }

  return fs.readFile(absPath, backendContext(workspaceRoot, ctx.signal))
}
```

`requestPermissionInterrupt` is a helper imported from `@dawn-ai/langchain` — wait, that creates a core→langchain dep. Restructure: the helper lives in `@dawn-ai/permissions` and uses LangGraph's `interrupt()` directly (which is available via `import { interrupt } from "@langchain/langgraph"`). Add `@langchain/langgraph` to `@dawn-ai/permissions` as a peerDependency (or dependency).

Actually, simpler: have the workspace capability import `interrupt` from `@langchain/langgraph` directly (it's the LangGraph primitive). Add `@langchain/langgraph` to `@dawn-ai/core` as a peerDependency if not already present.

Verify: `cd /Users/blove/repos/dawn && grep "@langchain/langgraph" packages/core/package.json`

If not present: add to peerDependencies. If `@dawn-ai/core` shouldn't take a runtime dep on langgraph, do the interrupt logic in `@dawn-ai/langchain` and pass it via the resolver — but that's heavier. **For v1, accept the core→langgraph dep**.

```ts
import { interrupt } from "@langchain/langgraph"

async function requestPermissionInterrupt(args: {
  kind: "command" | "path"
  command?: string
  operation?: "readFile" | "writeFile" | "listDir"
  path?: string
  permissions: PermissionsStore | undefined
}): Promise<"allow" | "deny"> {
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command!)
      : suggestedPathPattern(args.path!)
  const payload = {
    interruptId,
    type: "permission-request" as const,
    kind: args.kind,
    detail:
      args.kind === "command"
        ? { command: args.command!, suggestedPattern }
        : { operation: args.operation!, path: args.path!, suggestedPattern },
  }
  // LangGraph's interrupt() pauses the graph and yields the payload on the stream.
  // The resume value comes back here when the resume endpoint fires.
  const decision = interrupt(payload) as "once" | "always" | "deny"
  if (decision === "deny") return "deny"
  if (decision === "always" && args.permissions) {
    const tool = args.kind === "command" ? "bash" : args.operation!
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return "allow"
}
```

Apply the same pattern to `writeFile`, `listDir`, and `runBash`. For `runBash`, EVERY command is gated (no inside/outside-workspace short-circuit):

```ts
// runBash (rewritten):
run: async (input, ctx) => {
  const { command } = RUN_BASH_INPUT.parse(input)
  const decision = await gate(permissions, "bash", command)
  if (decision === "deny") {
    throw new Error(`Permission denied by user: ${command}`)
  }
  if (decision === "unknown") {
    if (permissions?.mode === "non-interactive") {
      throw new Error(`Permission denied (fail-closed): ${command}`)
    }
    const result = await requestPermissionInterrupt({
      kind: "command",
      command,
      permissions,
    })
    if (result === "deny") {
      throw new Error(`Permission denied by user: ${command}`)
    }
  }
  return exec.runCommand({ command }, backendContext(workspaceRoot, ctx.signal))
}
```

Bypass mode for path-jail: the existing `pathJail()` call needs to be skipped when `permissions?.mode === "bypass"`. Wrap the jail call in a check OR remove the jail (since the gate handles the bypass case).

Actually the cleanest restructure: the capability no longer calls `pathJail()` at all — it resolves the path with `resolve(workspaceRoot, path)`, checks "is inside workspace?" itself, and gates if not (or if bypass). The "Path is outside workspace" error becomes part of the deny path for non-interactive mode.

- [ ] **Step 5: Pass permissions through `load()`**

In the `load()` of the marker:

```ts
load: async (_routeDir, context) => {
  const root = workspaceRoot()
  if (!existsSync(root)) return {}
  const fs = context.backends?.filesystem ?? localFilesystem()
  const exec = context.backends?.exec ?? localExec()
  const permissions = context.permissions
  // Warn on bypass mode
  if (permissions?.mode === "bypass") {
    console.warn(
      "[dawn:permissions] mode=bypass — path-jail disabled, all bash unrestricted. Do not use in production.",
    )
  }
  return { tools: buildWorkspaceTools(root, fs, exec, permissions) }
}
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/core test 2>&1 | tail -10
cd /Users/blove/repos/dawn && pnpm test 2>&1 | tail -10
cd /Users/blove/repos/dawn && pnpm build 2>&1 | tail -5
cd /Users/blove/repos/dawn && pnpm lint 2>&1 | tail -5
```
Expect: all green.

Note: the interrupt-flow tests (interactive mode → emits interrupt) cannot run in isolation because `interrupt()` is a LangGraph primitive that requires a live graph runtime. These tests should mock `interrupt()` to return a canned value, or be deferred to integration tests in `@dawn-ai/langchain`.

Pragmatic approach for THIS task: only test the non-interactive + bypass paths in unit tests; defer interactive-flow testing to Task 8's agent-adapter integration test.

- [ ] **Step 7: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/core/package.json \
        packages/core/src/capabilities/built-in/workspace.ts \
        packages/core/test/capabilities/workspace.test.ts
git commit -m "feat(core): workspace capability gates through PermissionsStore

Each of readFile/writeFile/listDir/runBash now consults the optional
PermissionsStore in CapabilityMarkerContext before invoking the
backend. Three modes:

- interactive: unknown ops emit LangGraph interrupt() and pause the run
- non-interactive: unknown ops hard-refuse (fail-closed)
- bypass: path-jail disabled, every op proceeds (warn on capability load)

Path-touching operations short-circuit (no gate) for paths INSIDE the
workspace. runBash gates every command regardless.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase C — Runtime: agent-adapter + resume endpoint

### Task 8: Propagate interrupt events through the SSE stream

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Create: `packages/langchain/test/agent-adapter-interrupt.test.ts`

- [ ] **Step 1: Inspect existing streamFromRunnable**

Read `packages/langchain/src/agent-adapter.ts` lines around `streamFromRunnable` and `streamEvents`. Note the case statements for `on_chat_model_stream`, `on_tool_start`, etc. The interrupt event from LangGraph v2 streamEvents has `event: "on_interrupt"` (verify by checking LangGraph 1.x docs or a quick smoke test).

If `on_interrupt` doesn't exist in LangGraph's stream events, LangGraph 1.x surfaces interrupts as a special return value from `graph.invoke()` rather than a stream event. In that case the propagation happens differently — at the graph-return level rather than mid-stream. Verify and adjust.

- [ ] **Step 2: Write a failing test**

Create `packages/langchain/test/agent-adapter-interrupt.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { streamAgent } from "../src/agent-adapter.js"

describe("streamAgent — interrupt propagation", () => {
  it("yields {type: 'interrupt', data: ...} when the graph emits a LangGraph interrupt", async () => {
    // Mock a graph that interrupts on its first tool call
    const mockGraph = {
      invoke: vi.fn(),
      streamEvents: async function* () {
        yield {
          event: "on_chain_start",
          name: "LangGraph",
          data: { input: {} },
        }
        // Simulate the LangGraph interrupt envelope shape
        yield {
          event: "on_interrupt",  // or whatever LangGraph v2 actually emits
          data: { value: { interruptId: "perm-x", type: "permission-request", kind: "command", detail: { command: "ls", suggestedPattern: "ls" } } },
        }
      },
    }

    const chunks: unknown[] = []
    for await (const c of streamAgent({
      entry: mockGraph,
      input: { messages: [{ role: "user", content: "x" }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(c)
    }

    const interruptChunk = chunks.find((c) => (c as { type: string }).type === "interrupt")
    expect(interruptChunk).toBeDefined()
  })
})
```

(Note: this test may need adjustment based on LangGraph's actual event shape. The implementer should investigate LangGraph 1.x's interrupt-related stream-events output before writing the assertion.)

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/langchain test -- agent-adapter-interrupt 2>&1 | tail -10
```
Expect: FAIL — `streamFromRunnable` does not currently emit `interrupt` chunks.

- [ ] **Step 4: Add the interrupt case**

In `streamFromRunnable`, add a new case in the for-await switch:

```ts
case "on_interrupt": {
  hasYielded = true
  yield {
    type: "interrupt" as const,
    data: (event.data as { value?: unknown }).value,
  }
  break
}
```

(If LangGraph emits interrupts via a different event name, use that.)

- [ ] **Step 5: Run + verify**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/langchain test 2>&1 | tail -10
```
Expect: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/blove/repos/dawn
git add packages/langchain/src/agent-adapter.ts packages/langchain/test/agent-adapter-interrupt.test.ts
git commit -m "feat(langchain): propagate LangGraph interrupt events to the SSE stream

When the graph emits an interrupt (via LangGraph's interrupt() primitive),
the agent-adapter yields a {type: 'interrupt', data: payload} chunk so
the SSE serializer can render it as 'event: interrupt' to clients.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Resume endpoint in the dev HTTP server

**Files:**
- Modify: `packages/cli/src/lib/dev/runtime-server.ts`
- Create: `packages/cli/test/resume-endpoint.test.ts`
- Possibly modify: `packages/cli/src/lib/runtime/execute-route.ts` (build PermissionsStore + thread it; also: maintain a per-thread "pending interrupt" map)

- [ ] **Step 1: Inspect the existing dev server**

Read `packages/cli/src/lib/dev/runtime-server.ts`. Note how `/runs/stream` is implemented. The new `/threads/:thread_id/resume` route follows the same pattern.

- [ ] **Step 2: Build the in-memory thread-state map**

In `runtime-server.ts` (or a new sibling file), maintain:

```ts
interface PendingInterrupt {
  interruptId: string
  // Resume function bound to the parked graph; called when resume arrives.
  resolve: (decision: "once" | "always" | "deny") => void
}

const pendingByThread = new Map<string, PendingInterrupt>()
```

When the agent emits an interrupt during a streamed run, the runtime registers the pending interrupt:

```ts
pendingByThread.set(threadId, { interruptId: payload.interruptId, resolve })
```

The `resolve` function is the callback that, when invoked, returns the decision to the LangGraph `interrupt()` call (via `Command({resume})`).

- [ ] **Step 3: Implement the resume route**

In the request dispatch of `runtime-server.ts`, add a match for `POST /threads/:thread_id/resume`:

```ts
if (request.method === "POST" && /^\/threads\/[^/]+\/resume$/.test(url.pathname)) {
  const threadId = url.pathname.split("/")[2]!
  const body = await readJsonBody(request)
  const { interrupt_id, decision } = body as { interrupt_id: string; decision: "once" | "always" | "deny" }

  const pending = pendingByThread.get(threadId)
  if (!pending) {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "no parked interrupt for thread" }))
    return
  }
  if (pending.interruptId !== interrupt_id) {
    response.writeHead(409, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "stale interrupt_id" }))
    return
  }
  pending.resolve(decision)
  pendingByThread.delete(threadId)
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ ok: true }))
  return
}
```

(Helper `readJsonBody` collects stdin into a buffer + parses; should exist already from the existing `/runs/stream` POST handling — reuse it.)

- [ ] **Step 4: Write endpoint tests**

Create `packages/cli/test/resume-endpoint.test.ts`. The test should:

1. Start the runtime server in isolation (find the existing test pattern in `dev-command.test.ts` or similar).
2. Pre-populate the `pendingByThread` map with a known thread + interrupt id.
3. POST a valid resume — expect 200, expect the resolve callback to fire with the right decision.
4. POST with stale `interrupt_id` — expect 409.
5. POST without a pending interrupt — expect 400.
6. Invalid JSON body — expect 400.

(Mirror the existing dev-server test scaffolding.)

- [ ] **Step 5: Run + verify**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-ai/cli test -- resume-endpoint 2>&1 | tail -10
cd /Users/blove/repos/dawn && pnpm test 2>&1 | tail -10
```
Expect: PASS.

- [ ] **Step 6: Wire PermissionsStore + interrupt-bridging into execute-route.ts**

In `packages/cli/src/lib/runtime/execute-route.ts`, after loading `dawn.config.ts`:

```ts
import { createPermissionsStore } from "@dawn-ai/permissions"

// ... existing config load logic
const permissionsConfig = loaded?.config.permissions
const envMode = process.env.DAWN_PERMISSIONS_MODE as
  | "interactive"
  | "non-interactive"
  | "bypass"
  | undefined
const mode = envMode ?? permissionsConfig?.mode ?? "interactive"

const permissionsStore = createPermissionsStore({
  appRoot,
  config: permissionsConfig
    ? {
        version: 1,
        allow: permissionsConfig.allow ?? {},
        deny: permissionsConfig.deny ?? {},
      }
    : undefined,
  mode,
})
await permissionsStore.load()

// Thread into capability context:
const applied = await applyCapabilities(registry, routeDir, {
  routeManifest,
  descriptor,
  descriptorRouteMap,
  ...(configBackends ? { backends: configBackends } : {}),
  permissions: permissionsStore,
})
```

The interrupt bridge — connecting `interrupt()` (in the capability) to the SSE stream + the `pendingByThread` map — requires that the streamed run's `interrupt` chunks (Task 8) get translated into `pendingByThread.set(...)` calls inside the SSE serializer. The serializer is in the same file region as the existing SSE event emitter. Add:

```ts
// in the stream chunk loop, for an "interrupt" chunk:
if (chunk.type === "interrupt") {
  pendingByThread.set(threadId, {
    interruptId: chunk.data.interruptId,
    resolve: (decision) => {
      // This callback resumes the parked LangGraph.
      // Implementation: re-invoke the graph with Command({resume: decision}).
      // The complexity here is connecting the resolve function back to the
      // LangGraph that's currently parked. Approach: when the graph emits
      // an interrupt, the `interrupt()` call resolves to whatever value is
      // passed in via Command({resume}) on the next invocation. So `resolve`
      // here needs to trigger a SECOND graph invocation with the resume value.
      //
      // For v1: simplest is to keep a Deferred<Decision> that the original
      // graph.invoke() awaits inside its tool's run(). When resolve fires,
      // it settles the Deferred, the tool's run() returns to LangGraph, and
      // the graph continues.
      //
      // This means the agent's run() function in the capability needs to
      // wrap interrupt() in a way that integrates with this Deferred pattern.
      // See implementer note below.
    },
  })
  // Forward the interrupt event to the SSE stream:
  yield { type: "interrupt", data: chunk.data }
}
```

**Implementer note:** the actual mechanism by which `resolve` translates into a LangGraph resume is the trickiest piece of this task. The LangGraph `interrupt()` primitive expects to be re-invoked via `Command({resume})` on the SAME graph instance with the SAME thread_id. The runtime server needs to keep the graph instance alive between the initial `streamEvents` and the resume call.

If this proves intractable for v1, the FALLBACK design is:
1. The initial run's stream ends when interrupt fires (return early).
2. The next call to `/runs/stream` with the same `thread_id` includes `{ resume_value: decision }` in the payload.
3. The runtime constructs the graph fresh, calls `graph.invoke(Command({resume: decision}), {configurable: {thread_id}})`, and resumes from the checkpoint.

This "fall-back" requires LangGraph's checkpointer to be enabled (it should be, for thread continuity). Verify that the existing /runs/stream payload supports this OR add a new field for it.

If the fall-back is too disruptive, mark this task as DONE_WITH_CONCERNS and document the limitation: "Resume mechanism functional for path-jail/bash interrupts in the same process; multi-process resume requires the future Agent Protocol implementation (sub-project 7)."

- [ ] **Step 7: Commit**

```bash
cd /Users/blove/repos/dawn
git add -A
git commit -m "$(cat <<'EOF'
feat(cli): resume endpoint + PermissionsStore wiring

Adds POST /threads/:thread_id/resume to the dev HTTP server. Maintains
an in-memory pendingByThread map of parked interrupts. The resume
handler validates the interrupt_id, invokes the resolver bound to the
parked graph, and returns 200.

execute-route.ts constructs the PermissionsStore from dawn.config.ts
+ DAWN_PERMISSIONS_MODE env var and threads it into the
CapabilityMarkerContext. The workspace capability reads it.

The interrupt-to-resume bridging is the trickiest piece; v1 uses a
Deferred-per-pending-interrupt pattern that requires the graph to stay
alive between the initial /runs/stream and the resume POST.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase D — Chat demo

### Task 10: Seed permissions in chat demo's dawn.config.ts

**Files:**
- Modify: `examples/chat/server/dawn.config.ts`

- [ ] **Step 1: Update the config**

Replace contents with:

```ts
export default {
  appDir: "src/app",
  permissions: {
    // Default mode (omit means "interactive")
    // Seed a few obviously-safe commands so prompt fatigue is reasonable on first run.
    allow: {
      bash: ["ls", "pwd", "cat", "echo", "head", "tail", "wc"],
    },
    // Block obviously-destructive patterns even when interactive.
    deny: {
      bash: ["rm -rf", "sudo", "chmod 777"],
    },
  },
}
```

- [ ] **Step 2: Verify the example builds**

```bash
cd /Users/blove/repos/dawn/examples/chat/server && pnpm build 2>&1 | tail -5
```
Expect: `4 route(s) compiled`.

- [ ] **Step 3: Commit**

```bash
cd /Users/blove/repos/dawn
git add examples/chat/server/dawn.config.ts
git commit -m "feat(examples/chat): seed permissions allow/deny in dawn.config.ts

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: Chat-web inline permission panel + resume proxy

**Files:**
- Create: `examples/chat/web/app/api/permission-resume/route.ts`
- Modify: `examples/chat/web/app/page.tsx`

- [ ] **Step 1: Write the resume proxy**

Create `examples/chat/web/app/api/permission-resume/route.ts`:

```ts
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest): Promise<Response> {
  const serverUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
  const body = (await req.json()) as {
    threadId: string
    interruptId: string
    decision: "once" | "always" | "deny"
  }

  const upstream = await fetch(`${serverUrl}/threads/${encodeURIComponent(body.threadId)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      interrupt_id: body.interruptId,
      decision: body.decision,
    }),
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  })
}
```

- [ ] **Step 2: Add the inline panel to page.tsx**

Edit `examples/chat/web/app/page.tsx`. Add state for pending interrupt + handlers; render an inline panel when present:

```tsx
const [pendingInterrupt, setPendingInterrupt] = useState<{
  interruptId: string
  kind: "command" | "path"
  detail: any  // shape from SSE
} | null>(null)

// Inside the SSE read loop, parse "event: interrupt" lines:
// Detection: lines.match(/^event: interrupt$/) then read the following "data: ..." line.
// Parse the JSON, setPendingInterrupt(parsedData).

async function resolveInterrupt(decision: "once" | "always" | "deny") {
  if (!pendingInterrupt || !threadId) return
  await fetch("/api/permission-resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      interruptId: pendingInterrupt.interruptId,
      decision,
    }),
  })
  setPendingInterrupt(null)
}

// Render — above the event log, when pendingInterrupt is non-null:
{pendingInterrupt && (
  <div style={{ /* inline panel styling */ }}>
    <strong>⚠️ Permission request</strong>
    <p>
      The agent wants to {pendingInterrupt.kind === "command" ? "run command:" : `${pendingInterrupt.detail.operation}:`}
    </p>
    <code style={{ display: "block", background: "#f0f0f0", padding: "0.5rem" }}>
      {pendingInterrupt.kind === "command" ? pendingInterrupt.detail.command : pendingInterrupt.detail.path}
    </code>
    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
      <button onClick={() => resolveInterrupt("once")}>Allow once</button>
      <button onClick={() => resolveInterrupt("always")}>
        Allow always for `{pendingInterrupt.detail.suggestedPattern}`
      </button>
      <button onClick={() => resolveInterrupt("deny")}>Deny</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: Verify**

```bash
cd /Users/blove/repos/dawn && pnpm --filter @dawn-example/chat-web typecheck 2>&1 | tail -5
cd /Users/blove/repos/dawn && pnpm --filter @dawn-example/chat-web build 2>&1 | tail -5
```
Expect: clean typecheck + build.

- [ ] **Step 4: Commit**

```bash
cd /Users/blove/repos/dawn
git add examples/chat/web/
git commit -m "feat(examples/chat-web): inline permission panel + resume proxy

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase E — Smoke + PR

### Task 12: Manual Chrome MCP smoke

**Files:** none modified.

- [ ] **Step 1: Start both dev servers**

```bash
cd /Users/blove/repos/dawn/examples/chat/server && OPENAI_API_KEY="$(grep OPENAI_API_KEY /Users/blove/repos/dawn/.env | cut -d= -f2-)" pnpm dev &
cd /Users/blove/repos/dawn/examples/chat/web && pnpm dev &
```

Wait for both ("Dawn dev ready" + "Ready in Nms").

- [ ] **Step 2: Drive `/chat` with a prompt that triggers bash gating**

Navigate Chrome MCP to `http://localhost:3000`, ensure `/chat` is selected, send: `Run `ls -la` in the workspace.`

Expected behavior:
- An `event: interrupt` envelope arrives on the SSE stream.
- The inline panel renders: "The agent wants to run command: `ls -la`", with three buttons.
- The "Allow always" button labels with the suggested pattern (`ls -la` → first two tokens, so `ls -la`).
- Clicking "Allow once" sends the resume; the SSE log resumes streaming; the agent's tool call completes.
- Send the SAME prompt again → another interrupt fires (Once didn't persist).
- Re-send and click "Allow always for `ls -la`" → SSE log resumes; verify `.dawn/permissions.json` now has `allow.bash: ["ls -la"]`.
- Re-send a THIRD time → no interrupt; runs silently.

- [ ] **Step 3: Trigger a denied command**

Prompt: `Run `rm -rf /tmp/` in the workspace.`

Expected: NO interrupt fires (config.deny has `rm -rf`). The tool returns the deny error; agent responds something like "I cannot run that command, it's blocked."

- [ ] **Step 4: Trigger a path-outside-workspace prompt**

Prompt: `Read /etc/hostname please.`

Expected: interrupt fires with `{kind: "path", operation: "readFile", path: "/etc/hostname", suggestedPattern: "/etc/"}`. Click "Deny". The tool returns the deny error; agent acknowledges.

- [ ] **Step 5: Switch to bypass mode + verify**

Edit `examples/chat/server/dawn.config.ts` to set `permissions: { mode: "bypass" }`. Restart the chat-server. Re-run: `Read /etc/hostname please.`

Expected: NO interrupt. The tool actually reads `/etc/hostname` and returns its contents. (The path-jail is disabled.)

Restore `dawn.config.ts` to interactive mode before continuing.

- [ ] **Step 6: Kill dev servers**

```bash
pkill -f "dawn.*dev"
pkill -f "next dev -p 3000"
```

- [ ] **Step 7: If any step failed**

Debug. Likely candidates:
- The interrupt envelope isn't appearing on the SSE stream → check Task 8's propagation.
- The resume endpoint returns 200 but the run doesn't resume → check the Deferred/Command-resume mechanism from Task 9.
- `.dawn/permissions.json` doesn't get written on "always" → check the PermissionsStore.addAllow path.

Iterate until smoke is clean. No move to Task 13 until all 5 substeps succeed.

---

### Task 13: Update phase memory + open PR

**Files:**
- Modify: `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md`

- [ ] **Step 1: Update phase status memory**

Edit `project_phase_status.md`. Find the section for sub-project 4 (recently shipped) and ADD a new entry beneath it for 4.5:

```
4.5. ✅ **HITL permissions** — shipped in [PR #TBD](https://github.com/cacheplane/0/pull/TBD).
Three modes (interactive default / non-interactive / bypass) in
dawn.config.ts. Path-jail escapes + every first-occurrence bash command
trigger an interrupt prompt with three approval scopes (Once /
Always-for-pattern / Deny). Smart-default pattern inference (first 2
tokens for commands, parent dir for paths). Persisted decisions live
in .dawn/permissions.json (project-local, gitignored, auto-appended to
.gitignore). New @dawn-ai/permissions package ships types + pattern-
matching + PermissionsStore. SSE envelope shape is Agent-Protocol-
compatible.
```

Also bump the top summary if applicable.

- [ ] **Step 2: Push the branch + open the PR**

```bash
cd /Users/blove/repos/dawn
git push -u origin claude/phase3-permissions
gh pr create --title "feat: phase 3 — HITL permissions (sub-project 4.5)" --body "$(cat <<'EOF'
## Summary

Sub-project 4.5 of the Dawn opinionated agent harness. Builds on
sub-project 4 (workspace capability, PR #170): replaces the hard-refuse-
on-path-jail-escape with an interrupt prompt; adds the same gating to
runBash. Three modes: interactive (default), non-interactive
(production / CI), bypass (explicit trust). Persisted "always"
decisions live in `.dawn/permissions.json` (project-local, gitignored).

Spec: `docs/superpowers/specs/2026-05-21-phase3-permissions-design.md`
Plan: `docs/superpowers/plans/2026-05-21-phase3-permissions.md`

## Changes

- New `@dawn-ai/permissions` package: types + pattern-matching + suggested-pattern + PermissionsStore.
- Workspace capability gates every tool's run() through PermissionsStore.
  - readFile/writeFile/listDir: gate only when path is outside the workspace.
  - runBash: gate every command on first occurrence.
  - bypass mode disables the path-jail entirely.
- DawnConfig + CapabilityMarkerContext extend with permissions/PermissionsStore.
- Dev HTTP server adds POST /threads/:thread_id/resume.
- Agent-adapter propagates LangGraph interrupt() as `event: interrupt` SSE envelopes.
- Chat demo seeds permissions in dawn.config.ts; web client renders inline permission panel.

## Test plan

- [x] Unit tests across @dawn-ai/permissions (suggested-pattern, matching, store)
- [x] Workspace capability tests covering interactive/non-interactive/bypass paths
- [x] Resume endpoint tests
- [x] Agent-adapter interrupt propagation test
- [x] Manual Chrome MCP smoke (5 scenarios)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Update memory with the real PR number**

After PR URL prints, replace `#TBD` with the real number in the memory note.

- [ ] **Step 4: Enable auto-merge**

```bash
gh pr merge --squash --delete-branch --auto
```

Wait for validate-green.

---

## Self-review notes

- **Spec coverage:** Every section maps to a task. Architecture (T1–T7). Modes (T6, T7). Persistence (T5). SSE envelope (T8). Resume endpoint (T9). Web client UX (T11). Config seeding (T10). Smoke (T12).
- **Known sharp edge in T9:** the interrupt-to-resume bridging mechanism is the most uncertain piece — depends on LangGraph 1.x checkpointer behavior and how `interrupt()` interacts with `streamEvents()`. The plan documents a fallback if the in-process Deferred pattern doesn't work cleanly. The implementer may need to investigate LangGraph 1.x's actual interrupt semantics empirically before locking in the design.
- **Placeholder scan:** clean. The `LangGraph interrupt event name` (`on_interrupt` vs other) is flagged as something to verify, not a placeholder.
- **Type consistency:** `PermissionMode`, `PermissionDecision`, `PermissionsFile`, `PermissionsStore` consistent throughout. The capability's `gate()` helper signature stable. The SSE envelope payload shape stable across the spec + plan.
