# Canonical Chat Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `examples/chat/` — a two-package workspace example (Dawn route server + disposable Next.js smoke client) demonstrating the four foundational agent-harness tools (read/write/list/bash) end-to-end.

**Architecture:** `examples/chat/server` is a Dawn route at `src/app/chat/` with four tools in `tools/`, all path-jailed to `./workspace`. `examples/chat/web` is a minimal Next.js app whose `/api/chat` route proxies SSE from Dawn's `POST /runs/stream`. The server runs on a pinned port (3001) so the client can hardcode it.

**Tech Stack:** TypeScript, pnpm workspaces, Dawn SDK + CLI + langchain bridge, Next.js 15 (App Router), Node 22, Zod, OpenAI (`gpt-5-mini`).

**Spec:** [docs/superpowers/specs/2026-05-15-canonical-chat-example-design.md](../specs/2026-05-15-canonical-chat-example-design.md)

---

## Task 1: Workspace plumbing

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `examples/README.md`
- Create: `examples/chat/package.json`
- Create: `examples/chat/.gitignore`

- [ ] **Step 1: Add `examples/*/*` to pnpm workspace**

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - templates/*
  - examples/*/*
```

- [ ] **Step 2: Create `examples/README.md`**

```markdown
# Dawn examples

Canonical, runnable examples of Dawn applications. Each example is a folder containing one or more workspace packages.

| Example | What it shows |
|---|---|
| [chat](./chat) | Foundational agent-harness primitives (filesystem + bash) end-to-end, with a disposable smoke-test web client |

These examples are pnpm workspace members. They consume Dawn via `workspace:*` and are typechecked in CI.
```

- [ ] **Step 3: Create `examples/chat/package.json` (top-level orchestrator)**

```json
{
  "name": "@dawn-example/chat",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "pnpm -r --parallel --filter ./server --filter ./web dev",
    "dev:server": "pnpm --filter ./server dev",
    "dev:web": "pnpm --filter ./web dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck"
  }
}
```

- [ ] **Step 4: Create `examples/chat/.gitignore`**

```
workspace/*
!workspace/AGENTS.md
.env
.env.local
.env.*.local
```

- [ ] **Step 5: Run `pnpm install` to register the new workspace glob**

Run: `pnpm install`
Expected: install succeeds, no new dependencies resolved yet (sub-packages don't exist), workspace updated.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml examples/README.md examples/chat/package.json examples/chat/.gitignore
git commit -m "feat(examples): scaffold examples/ workspace and chat orchestrator"
```

---

## Task 2: Server package skeleton

**Files:**
- Create: `examples/chat/server/package.json`
- Create: `examples/chat/server/tsconfig.json`
- Create: `examples/chat/server/dawn.config.ts`
- Create: `examples/chat/server/.env.example`
- Create: `examples/chat/server/.gitignore`

- [ ] **Step 1: Create `examples/chat/server/package.json`**

```json
{
  "name": "@dawn-example/chat-server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "dawn dev --port 3001",
    "build": "dawn build",
    "typecheck": "tsc -p . --noEmit",
    "check": "dawn check"
  },
  "dependencies": {
    "@dawn-ai/cli": "workspace:*",
    "@dawn-ai/core": "workspace:*",
    "@dawn-ai/langchain": "workspace:*",
    "@dawn-ai/sdk": "workspace:*",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@types/node": "25.6.0",
    "typescript": "6.0.2"
  }
}
```

- [ ] **Step 2: Create `examples/chat/server/tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@dawn-ai/config-typescript/node",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": [
    "dawn.config.ts",
    "src/**/*.ts",
    ".dawn/dawn.generated.d.ts"
  ]
}
```

- [ ] **Step 3: Create `examples/chat/server/dawn.config.ts`**

```ts
export default {}
```

- [ ] **Step 4: Create `examples/chat/server/.env.example`**

```
OPENAI_API_KEY=
```

- [ ] **Step 5: Create `examples/chat/server/.gitignore`**

```
.dawn/
node_modules/
dist/
.env
.env.local
```

- [ ] **Step 6: Run `pnpm install` to wire workspace deps**

Run: `pnpm install`
Expected: `@dawn-example/chat-server` resolves its `workspace:*` deps locally.

- [ ] **Step 7: Commit**

```bash
git add examples/chat/server
git commit -m "feat(examples/chat): server package skeleton"
```

---

## Task 3: Path-jail helper (with unit test)

This module is security-critical and pure logic — it gets a unit test even though the example otherwise has none.

**Files:**
- Create: `examples/chat/server/src/app/chat/workspace-path.ts`
- Create: `examples/chat/server/src/app/chat/workspace-path.test.ts`
- Modify: `examples/chat/server/package.json` (add `vitest` devDep + test script)

- [ ] **Step 1: Add vitest to server package**

Edit `examples/chat/server/package.json` `devDependencies`:

```json
"devDependencies": {
  "@dawn-ai/config-typescript": "workspace:*",
  "@types/node": "25.6.0",
  "typescript": "6.0.2",
  "vitest": "3.0.0"
}
```

Add to `scripts`:

```json
"test": "vitest run"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`examples/chat/server/src/app/chat/workspace-path.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveWorkspacePath } from "./workspace-path.js"

describe("resolveWorkspacePath", () => {
  let root: string
  let workspace: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dawn-chat-"))
    workspace = join(root, "workspace")
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("resolves a simple relative path inside the workspace", () => {
    const resolved = resolveWorkspacePath(workspace, "notes.md")
    expect(resolved).toBe(join(workspace, "notes.md"))
  })

  it("resolves nested paths", () => {
    const resolved = resolveWorkspacePath(workspace, "a/b/c.txt")
    expect(resolved).toBe(join(workspace, "a/b/c.txt"))
  })

  it("treats '.' as the workspace root", () => {
    expect(resolveWorkspacePath(workspace, ".")).toBe(workspace)
  })

  it("rejects absolute paths", () => {
    expect(() => resolveWorkspacePath(workspace, "/etc/passwd")).toThrow(/absolute/i)
  })

  it("rejects paths that escape via ..", () => {
    expect(() => resolveWorkspacePath(workspace, "../escape.txt")).toThrow(/outside workspace/i)
  })

  it("rejects paths that escape after normalization", () => {
    expect(() => resolveWorkspacePath(workspace, "a/../../escape.txt")).toThrow(/outside workspace/i)
  })

  it("rejects symlinks that point outside the workspace", () => {
    const outside = join(root, "outside.txt")
    writeFileSync(outside, "secret")
    const link = join(workspace, "link.txt")
    symlinkSync(outside, link)
    expect(() => resolveWorkspacePath(workspace, "link.txt")).toThrow(/outside workspace/i)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @dawn-example/chat-server test`
Expected: FAIL — `resolveWorkspacePath` is not defined.

- [ ] **Step 4: Implement the helper**

`examples/chat/server/src/app/chat/workspace-path.ts`:

```ts
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { isAbsolute, normalize, relative, resolve } from "node:path"

/**
 * Resolve a user-supplied path against a workspace root, rejecting anything
 * that would escape the workspace.
 *
 * Rules:
 *  - Absolute paths are rejected outright.
 *  - The path is normalized; any `..` segment that escapes the workspace is rejected.
 *  - If the resolved path (or any ancestor) is a symlink, its real path must
 *    also be inside the workspace.
 *
 * The workspace directory is created if it does not exist.
 */
export function resolveWorkspacePath(workspaceRoot: string, userPath: string): string {
  if (!existsSync(workspaceRoot)) {
    mkdirSync(workspaceRoot, { recursive: true })
  }

  if (isAbsolute(userPath)) {
    throw new Error(`Path is absolute: ${userPath}`)
  }

  const normalized = normalize(userPath)
  const resolved = resolve(workspaceRoot, normalized)
  const rel = relative(workspaceRoot, resolved)
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside workspace: ${userPath}`)
  }

  // Symlink check: if any ancestor exists and resolves outside, reject.
  if (existsSync(resolved)) {
    const real = realpathSync(resolved)
    const realRel = relative(realpathSync(workspaceRoot), real)
    if (realRel.startsWith("..")) {
      throw new Error(`Path resolves outside workspace via symlink: ${userPath}`)
    }
  }

  return resolved
}

/**
 * Resolve the workspace root for the example. Lives at `<cwd>/workspace`.
 */
export function workspaceRoot(): string {
  return resolve(process.cwd(), "workspace")
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dawn-example/chat-server test`
Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add examples/chat/server/src examples/chat/server/package.json
git commit -m "feat(examples/chat): path-jail helper for workspace tools"
```

---

## Task 4: `list-dir` tool

**Files:**
- Create: `examples/chat/server/src/app/chat/tools/list-dir.ts`

- [ ] **Step 1: Implement the tool**

```ts
import { readdirSync, statSync } from "node:fs"
import { resolveWorkspacePath, workspaceRoot } from "../workspace-path.js"

/**
 * List the entries in a directory inside the workspace.
 * Pass "." to list the workspace root. Subdirectories are suffixed with "/".
 */
export default async (input: { readonly path: string }): Promise<string[]> => {
  const dir = resolveWorkspacePath(workspaceRoot(), input.path)
  const entries = readdirSync(dir)
  entries.sort()
  return entries.map((name) => {
    const isDir = statSync(`${dir}/${name}`).isDirectory()
    return isDir ? `${name}/` : name
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dawn-example/chat-server typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add examples/chat/server/src/app/chat/tools/list-dir.ts
git commit -m "feat(examples/chat): list-dir tool"
```

---

## Task 5: `read-file` tool

**Files:**
- Create: `examples/chat/server/src/app/chat/tools/read-file.ts`

- [ ] **Step 1: Implement the tool**

```ts
import { readFileSync, statSync } from "node:fs"
import { resolveWorkspacePath, workspaceRoot } from "../workspace-path.js"

const MAX_BYTES = 256 * 1024

/**
 * Read a UTF-8 text file from the workspace. Rejects files larger than 256 KiB.
 */
export default async (input: { readonly path: string }): Promise<string> => {
  const file = resolveWorkspacePath(workspaceRoot(), input.path)
  const size = statSync(file).size
  if (size > MAX_BYTES) {
    throw new Error(`File too large: ${size} bytes (limit ${MAX_BYTES})`)
  }
  return readFileSync(file, "utf8")
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dawn-example/chat-server typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add examples/chat/server/src/app/chat/tools/read-file.ts
git commit -m "feat(examples/chat): read-file tool"
```

---

## Task 6: `write-file` tool

**Files:**
- Create: `examples/chat/server/src/app/chat/tools/write-file.ts`

- [ ] **Step 1: Implement the tool**

```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { resolveWorkspacePath, workspaceRoot } from "../workspace-path.js"

/**
 * Write a UTF-8 text file to the workspace. Overwrites existing files.
 * Creates parent directories as needed. Returns a one-line summary.
 */
export default async (
  input: { readonly path: string; readonly content: string },
): Promise<string> => {
  const file = resolveWorkspacePath(workspaceRoot(), input.path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, input.content, "utf8")
  const bytes = Buffer.byteLength(input.content, "utf8")
  return `wrote ${bytes} bytes to ${input.path}`
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dawn-example/chat-server typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add examples/chat/server/src/app/chat/tools/write-file.ts
git commit -m "feat(examples/chat): write-file tool"
```

---

## Task 7: `run-bash` tool

**Files:**
- Create: `examples/chat/server/src/app/chat/tools/run-bash.ts`

- [ ] **Step 1: Implement the tool**

```ts
import { spawn } from "node:child_process"
import { workspaceRoot } from "../workspace-path.js"

const MAX_TIMEOUT_SECONDS = 120

/**
 * Run a bash command in the workspace directory. Captures stdout and stderr,
 * enforces a hard timeout, and returns the combined output with an exit-code
 * footer. NOT a sandbox — do not run untrusted commands.
 */
export default async (
  input: { readonly command: string; readonly timeoutSeconds: number },
): Promise<string> => {
  const timeout = Math.min(Math.max(1, input.timeoutSeconds), MAX_TIMEOUT_SECONDS)
  const cwd = workspaceRoot()

  return new Promise((resolveResult) => {
    const child = spawn("bash", ["-c", input.command], { cwd })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      output += `\n[killed: exceeded ${timeout}s timeout]`
    }, timeout * 1000)

    child.on("close", (code) => {
      clearTimeout(timer)
      resolveResult(`${output}\n[exit ${code ?? "?"}]`)
    })
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dawn-example/chat-server typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add examples/chat/server/src/app/chat/tools/run-bash.ts
git commit -m "feat(examples/chat): run-bash tool"
```

---

## Task 8: Route, state, system prompt, seed AGENTS.md

**Files:**
- Create: `examples/chat/server/src/app/chat/system-prompt.ts`
- Create: `examples/chat/server/src/app/chat/state.ts`
- Create: `examples/chat/server/src/app/chat/index.ts`
- Create: `examples/chat/server/workspace/AGENTS.md`

- [ ] **Step 1: Create the system prompt**

`examples/chat/server/src/app/chat/system-prompt.ts`:

```ts
export const HARNESS_SYSTEM_PROMPT = `You are a coding agent demonstrating Dawn's foundational harness primitives.

You operate in a sandboxed \`workspace/\` directory. You have four tools:

- \`list-dir({ path })\` — list directory contents. Pass "." for the workspace root.
- \`read-file({ path })\` — read a UTF-8 text file (max 256 KiB).
- \`write-file({ path, content })\` — create or overwrite a text file.
- \`run-bash({ command, timeoutSeconds })\` — run a shell command in the workspace. Use \`timeoutSeconds: 30\` unless the task clearly needs longer (max 120).

Memory convention: at the start of every task, run \`list-dir({ path: "." })\`. If \`AGENTS.md\` exists, read it with \`read-file({ path: "AGENTS.md" })\` before doing anything else. When you complete meaningful work, update \`AGENTS.md\` so future-you remembers what mattered.

Keep replies short. Prefer doing over narrating. When you finish a task, summarize what changed in one or two sentences.`
```

- [ ] **Step 2: Create state schema**

`examples/chat/server/src/app/chat/state.ts`:

```ts
import { z } from "zod"
export default z.object({})
```

- [ ] **Step 3: Create the route**

`examples/chat/server/src/app/chat/index.ts`:

```ts
import { agent } from "@dawn-ai/sdk"
import { HARNESS_SYSTEM_PROMPT } from "./system-prompt.js"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: HARNESS_SYSTEM_PROMPT,
})
```

- [ ] **Step 4: Seed AGENTS.md**

`examples/chat/server/workspace/AGENTS.md`:

```markdown
# Workspace memory

This file is the persistent memory for this chat session. It survives across turns and threads.

When you start a task, read this file first. When you finish meaningful work, append a short note here so the next session knows what you learned or built.

(Replace this seed text once you have something worth recording.)
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @dawn-example/chat-server typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add examples/chat/server/src/app/chat/index.ts \
        examples/chat/server/src/app/chat/state.ts \
        examples/chat/server/src/app/chat/system-prompt.ts \
        examples/chat/server/workspace/AGENTS.md
git commit -m "feat(examples/chat): route, system prompt, seed AGENTS.md"
```

---

## Task 9: Smoke-test the server end-to-end

Verify the server actually boots and responds. This requires an `OPENAI_API_KEY`. If unavailable in the implementation environment, skip the LLM-touching step and only verify `/healthz`.

**Files:** none (verification only)

- [ ] **Step 1: Build Dawn workspace packages**

Run: `pnpm build`
Expected: all packages build successfully (the example consumes `dist/` from sibling packages).

- [ ] **Step 2: Run `dawn check` to verify route discovery**

Run: `pnpm --filter @dawn-example/chat-server check`
Expected: reports the `/chat` route with four tools (`list-dir`, `read-file`, `write-file`, `run-bash`), no errors.

- [ ] **Step 3: Start the dev server in the background**

Run: `pnpm --filter @dawn-example/chat-server dev`
(Use a background terminal or `run_in_background`.)
Expected: prints something like `Dawn dev server ready on http://127.0.0.1:3001`.

- [ ] **Step 4: Verify `/healthz`**

Run: `curl -s http://127.0.0.1:3001/healthz`
Expected: `{"status":"ready"}` (or similar).

- [ ] **Step 5: (If `OPENAI_API_KEY` set) Invoke the route**

Run:
```bash
curl -s -X POST http://127.0.0.1:3001/runs/wait \
  -H "content-type: application/json" \
  -d '{
    "assistant_id": "/chat#agent",
    "input": { "messages": [{ "role": "user", "content": "list the workspace" }] },
    "metadata": { "dawn": { "mode": "agent", "route_id": "/chat", "route_path": "src/app/chat/index.ts" } }
  }'
```
Expected: JSON response containing a tool call to `list-dir` and a final assistant message naming `AGENTS.md`.

- [ ] **Step 6: Stop the dev server**

Kill the background process.

If any step fails, debug and fix before proceeding. Do not commit anything in this task — it is verification only.

---

## Task 10: Web package skeleton

**Files:**
- Create: `examples/chat/web/package.json`
- Create: `examples/chat/web/tsconfig.json`
- Create: `examples/chat/web/next.config.mjs`
- Create: `examples/chat/web/.env.example`
- Create: `examples/chat/web/.gitignore`
- Create: `examples/chat/web/next-env.d.ts`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "@dawn-example/chat-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "typecheck": "tsc -p . --noEmit"
  },
  "dependencies": {
    "next": "15.0.3",
    "react": "19.0.0",
    "react-dom": "19.0.0"
  },
  "devDependencies": {
    "@dawn-ai/config-typescript": "workspace:*",
    "@types/node": "25.6.0",
    "@types/react": "19.0.0",
    "@types/react-dom": "19.0.0",
    "typescript": "6.0.2"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowJs": false,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `web/next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {}
export default nextConfig
```

- [ ] **Step 4: Create `web/.env.example`**

```
DAWN_SERVER_URL=http://127.0.0.1:3001
```

- [ ] **Step 5: Create `web/.gitignore`**

```
node_modules/
.next/
.env
.env.local
.env.*.local
next-env.d.ts
```

- [ ] **Step 6: Create `web/next-env.d.ts`**

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

- [ ] **Step 7: Install**

Run: `pnpm install`
Expected: Next.js and React resolve.

- [ ] **Step 8: Commit**

```bash
git add examples/chat/web
git commit -m "feat(examples/chat): web package skeleton"
```

---

## Task 11: SSE proxy API route

**Files:**
- Create: `examples/chat/web/app/api/chat/route.ts`

- [ ] **Step 1: Implement the proxy**

```ts
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest): Promise<Response> {
  const serverUrl = process.env.DAWN_SERVER_URL ?? "http://127.0.0.1:3001"
  const body = (await req.json()) as {
    threadId: string
    message: string
  }

  const upstream = await fetch(`${serverUrl}/runs/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assistant_id: "/chat#agent",
      input: {
        messages: [{ role: "user", content: body.message }],
      },
      metadata: {
        dawn: {
          mode: "agent",
          route_id: "/chat",
          route_path: "src/app/chat/index.ts",
          thread_id: body.threadId,
        },
      },
    }),
  })

  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream error: ${upstream.status}`, { status: 502 })
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dawn-example/chat-web typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add examples/chat/web/app/api/chat/route.ts
git commit -m "feat(examples/chat): SSE proxy from web to Dawn dev server"
```

---

## Task 12: Smoke-test page UI

**Files:**
- Create: `examples/chat/web/app/layout.tsx`
- Create: `examples/chat/web/app/page.tsx`

- [ ] **Step 1: Create the layout**

```tsx
// examples/chat/web/app/layout.tsx
import type { ReactNode } from "react"

export const metadata = { title: "Dawn chat — smoke test" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        {children}
      </body>
    </html>
  )
}
```

- [ ] **Step 2: Create the page**

`examples/chat/web/app/page.tsx`:

```tsx
"use client"

import { useState } from "react"

function newThreadId(): string {
  return `t-${Math.random().toString(36).slice(2, 10)}`
}

export default function Page() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [events, setEvents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  async function send() {
    const tid = threadId ?? newThreadId()
    if (!threadId) setThreadId(tid)

    setBusy(true)
    setEvents((e) => [...e, `▶ user: ${input}`])
    const msg = input
    setInput("")

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: tid, message: msg }),
    })

    if (!res.body) {
      setEvents((e) => [...e, `✖ error: no response body`])
      setBusy(false)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim()) setEvents((e) => [...e, line])
      }
    }
    if (buf.trim()) setEvents((e) => [...e, buf])
    setEvents((e) => [...e, "■ done"])
    setBusy(false)
  }

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Dawn chat — smoke test</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Disposable. Streams raw SSE events from <code>/api/chat</code>. See <code>README.md</code> for context.
      </p>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={4}
        placeholder="Ask the agent to list the workspace, write a file, run a command…"
        style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", padding: "0.5rem" }}
        disabled={busy}
      />
      <button
        onClick={send}
        disabled={busy || input.trim().length === 0}
        style={{ marginTop: "0.5rem", padding: "0.5rem 1rem" }}
      >
        {busy ? "Streaming…" : "Send"}
      </button>
      <pre
        data-testid="event-log"
        style={{
          marginTop: "1rem",
          padding: "0.75rem",
          background: "#111",
          color: "#eee",
          minHeight: 200,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {events.length === 0 ? "(no events yet)" : events.join("\n")}
      </pre>
    </main>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @dawn-example/chat-web typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add examples/chat/web/app/layout.tsx examples/chat/web/app/page.tsx
git commit -m "feat(examples/chat): smoke-test page UI"
```

---

## Task 13: End-to-end browser verification

Verify the full pipe works in a real browser using the Claude-in-Chrome MCP. Requires `OPENAI_API_KEY` to be set in `examples/chat/server/.env`.

**Files:** none (verification only)

- [ ] **Step 1: Confirm `.env` is present**

Run: `test -f examples/chat/server/.env && echo OK`
Expected: prints `OK`. If not, copy `.env.example` and ask the user to paste a key before continuing.

- [ ] **Step 2: Start the server in the background**

Run: `pnpm --filter @dawn-example/chat-server dev` (background).
Expected: server ready on port 3001.

- [ ] **Step 3: Start the web app in the background**

Run: `pnpm --filter @dawn-example/chat-web dev` (background).
Expected: Next dev server ready on port 3000.

- [ ] **Step 4: Open the page in Chrome**

Use the `mcp__Claude_in_Chrome__navigate` tool to open `http://localhost:3000`.
Expected: page renders, "Dawn chat — smoke test" heading visible, textarea + Send button.

- [ ] **Step 5: Send a probe message**

Use `mcp__Claude_in_Chrome__form_input` (or `javascript_tool`) to enter `"list the workspace, read AGENTS.md, then update it with a note saying 'verified by claude-in-chrome'"` into the textarea, then click "Send".

- [ ] **Step 6: Wait for stream to complete**

Use `mcp__Claude_in_Chrome__find` to wait for the `■ done` line to appear in the `pre[data-testid=event-log]` element. Max wait 90 seconds.
Expected: event log shows tool_call lines for `list-dir`, `read-file`, `write-file`, and a final assistant message.

- [ ] **Step 7: Verify the side-effect**

Run: `cat examples/chat/server/workspace/AGENTS.md`
Expected: the file contains the new note from step 5.

- [ ] **Step 8: Capture a screenshot for the PR**

Use `mcp__Claude_in_Chrome__javascript_tool` to scroll to the top, then take a screenshot via the chrome MCP. Save the image somewhere convenient (e.g., `docs/superpowers/specs/2026-05-15-canonical-chat-example.png`) if it'll be referenced in the PR.

- [ ] **Step 9: Stop both servers**

Kill the background processes.

If verification fails at any step, debug and fix before proceeding. Do not commit anything in this task unless step 8 produces an artifact you want in the PR.

---

## Task 14: READMEs

**Files:**
- Create: `examples/chat/README.md`
- Create: `examples/chat/web/README.md`

- [ ] **Step 1: Top-level chat README**

`examples/chat/README.md`:

```markdown
# Chat — canonical Dawn harness example

> **v1 status:** foundational harness primitives only (filesystem + bash).
> Subagents, planning state, sandbox isolation, auto-summarization, and skills
> are deferred — see "Deferred" below.

## What this shows

- Dawn route discovery and the `tools/` convention
- Filesystem tools (read/write/list) + bash, path-jailed to `./workspace`
- `AGENTS.md` memory convention (manual in v1)
- End-to-end streaming from a Next.js client over SSE

## Quickstart

```bash
cp server/.env.example server/.env   # add OPENAI_API_KEY
cp web/.env.example web/.env.local
pnpm install
pnpm dev
# open http://localhost:3000
```

## Layout

```
examples/chat/
├── server/                 # @dawn-example/chat-server (Dawn route + tools)
│   └── src/app/chat/
│       ├── index.ts        # agent({ model, systemPrompt })
│       ├── state.ts
│       ├── system-prompt.ts
│       ├── workspace-path.ts
│       └── tools/          # list-dir, read-file, write-file, run-bash
└── web/                    # @dawn-example/chat-web (Next.js smoke client)
    └── app/
        ├── page.tsx        # textarea + Send + raw event log
        └── api/chat/route.ts   # SSE proxy
```

## Security caveats

**`run-bash` executes shell commands on your machine with `cwd: workspace/` and a timeout.
This is NOT a sandbox.** Network calls, package installs, file ops outside `workspace/` via
shell expansion — all possible. Do not point untrusted users at this example.

## Deferred (Dawn phase-3 preview)

These v1 deferrals are the explicit forcing function for Dawn's opinionated harness work:

- Subagent delegation (`task`-style tool) — needs first-class subagent declarations
- Planning state (`write_todos`) — needs build-time agent middleware + state channel composition
- `AGENTS.md` auto-injection — same
- Skills (`skills/` dir + `SKILL.md` loader) — mirror of the `tools/` convention
- Real sandbox isolation for `run-bash` — needs pluggable execution backends
- Tool-output offloading and context summarization — needs lifecycle hooks
- Nested-object tool inputs (e.g., `edit_file({ edits: [{ old, new }] })`) — typegen extension
- Polished web UI — wait for harness primitives to stabilize
```

- [ ] **Step 2: Web disposability README**

`examples/chat/web/README.md`:

```markdown
# Chat — web smoke client

This client exists to prove the server pipe end-to-end. It is **not** the production UI.

Expect this directory to be replaced once Dawn's harness primitives stabilize (subagents,
planning state, skills, sandbox backends). Until then: textarea, Send button, raw SSE event log.

If you want a richer view of what the agent is doing, `ls`, `tail -F`, or `watch` the
`examples/chat/server/workspace/` directory in another terminal.
```

- [ ] **Step 3: Commit**

```bash
git add examples/chat/README.md examples/chat/web/README.md
git commit -m "docs(examples/chat): READMEs with quickstart, caveats, deferred list"
```

---

## Task 15: Changeset

The repo requires a changeset for user-facing changes. Examples are not published packages, but a changeset documents intent and keeps `scripts/check-changesets.mjs` happy.

**Files:**
- Create: `.changeset/canonical-chat-example.md`

- [ ] **Step 1: Inspect existing changesets for format**

Run: `ls .changeset && head -5 .changeset/*.md | head -40`
Expected: see the existing frontmatter shape (package names + bump levels).

- [ ] **Step 2: Create the changeset**

Because the example packages are `private: true` and not in any bump matrix, the file should mark no published-package bumps. Use the format the existing changesets use; typical shape:

```markdown
---
---

Add `examples/chat`: canonical end-to-end demo of Dawn's foundational agent-harness tools (filesystem + bash) with a disposable Next.js smoke client. Sets the pattern for future `examples/*` and serves as the forcing function for the phase-3 opinionated harness work.
```

If `scripts/check-changesets.mjs` rejects an empty bump block, omit the changeset and instead ensure the PR title starts with `feat(examples):` so the changesets job treats it as non-bumping. (Check `scripts/check-changesets.mjs` for the exact rule.)

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for examples/chat"
```

---

## Task 16: Push branch and open PR

- [ ] **Step 1: Push the branch**

Run: `git push -u origin claude/keen-nightingale-44b28b`

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(examples): canonical chat harness demo" --body "$(cat <<'EOF'
## Summary
- Adds \`examples/chat/\` — a two-package workspace (Dawn route server + disposable Next.js smoke client) demonstrating the foundational agent-harness primitives end-to-end
- Server exposes four tools (\`list-dir\`, \`read-file\`, \`write-file\`, \`run-bash\`), all path-jailed to a per-example \`workspace/\` directory
- Web client is intentionally minimal: textarea + Send + raw SSE event log; designed to be replaced once Dawn's harness primitives stabilize

## Why
This is Dawn's first canonical example and the forcing function for phase-3 (opinionated harness). The README's "Deferred" section maps 1:1 to the Dawn primitives we'll need to grow next: build-time agent middleware, first-class subagents, state-channel composition, pluggable filesystem/exec backends, skills convention.

## Spec & plan
- Spec: docs/superpowers/specs/2026-05-15-canonical-chat-example-design.md
- Plan: docs/superpowers/plans/2026-05-15-canonical-chat-example.md

## Test plan
- [x] \`pnpm install\` succeeds with the new \`examples/*/*\` workspace glob
- [x] \`pnpm --filter @dawn-example/chat-server typecheck\` passes
- [x] \`pnpm --filter @dawn-example/chat-server test\` passes (path-jail unit tests)
- [x] \`pnpm --filter @dawn-example/chat-web typecheck\` passes
- [x] \`pnpm --filter @dawn-example/chat-server check\` discovers the \`/chat\` route with all four tools
- [x] End-to-end browser verification: server + web running, send a message asking the agent to update AGENTS.md, confirm file is changed (verified via claude-in-chrome MCP)

## Security caveats
\`run-bash\` is path-jailed + timeout-capped but **not sandboxed**. Documented prominently in the README; do not point untrusted prompts at this example.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Print the PR URL for the user**

The `gh pr create` command prints the URL; surface it in the final summary.

---

## Final checks

After all tasks complete, run these from the repo root to confirm nothing is broken in the wider monorepo:

- [ ] `pnpm install` — succeeds
- [ ] `pnpm typecheck` — passes (now includes `examples/chat/server` and `examples/chat/web`)
- [ ] `pnpm build` — passes
- [ ] `pnpm test` — passes (now includes the workspace-path unit tests)
- [ ] `pnpm lint` — passes

If lint fails on the new example files, follow the existing biome/eslint conventions used in `apps/web` and re-commit with a `style:` prefix.
