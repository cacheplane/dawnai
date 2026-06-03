# Tool-Output Offloading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a tool returns an output larger than a configurable character threshold, write the full payload to `workspace/tool-outputs/` and replace the in-context `ToolMessage` content with a preview+pointer stub, bounding the directory with a size+TTL cap and LRU-by-access eviction.

**Architecture:** A pure `offloadToolOutput(content, ctx)` unit in `@dawn-ai/langchain` runs inside `convertToolToLangChain`'s `func` (after `unwrapToolResult`, before the `ToolMessage` is built, for both the plain and `{result,state}` paths) so large content never enters message state — no tool-call/result pairing hazard. Persistence + throttled garbage collection live in an `OffloadStore` wrapping the workspace `FilesystemBackend`. `execute-route.ts` constructs the offloader only when a workspace exists and threads it through the agent adapter. The workspace `readFile` bumps `mtime` on `tool-outputs/` paths so re-read outputs survive eviction.

**Tech Stack:** TypeScript, Zod, LangChain/LangGraph, `node:fs/promises`, vitest, biome. Packages: `@dawn-ai/core`, `@dawn-ai/workspace`, `@dawn-ai/langchain`, `@dawn-ai/cli`.

**Spec:** `docs/superpowers/specs/2026-05-29-phase3-tool-output-offloading-design.md`

**Constants/defaults:** `offloadThresholdChars=40_000`, `previewLines=10`, `maxBytes=268_435_456` (256MB), `ttlMs=10_800_000` (3h), `gcThrottleMs=10_000` (10s). Offload subdir: `tool-outputs/`. Filename: `<toolName>-<unixMs>-<6hex>.txt`.

---

## File map

**Modified — `@dawn-ai/core`:**
- `packages/core/src/types.ts` — add `toolOutput?` to `DawnConfig`.
- `packages/core/src/capabilities/built-in/workspace.ts` — `readFile` bumps `mtime` for `tool-outputs/` paths.

**Modified — `@dawn-ai/workspace`:**
- `packages/workspace/src/types.ts` — add optional `statFile?`, `removeFile?`, `touchFile?` to `FilesystemBackend`.
- `packages/workspace/src/local-filesystem.ts` — implement the three optional methods.

**New + modified — `@dawn-ai/langchain`:**
- `packages/langchain/src/offload/stub.ts` — `buildStub` (pure).
- `packages/langchain/src/offload/offload-store.ts` — `OffloadStore` + `runGc`.
- `packages/langchain/src/offload/offload-tool-output.ts` — `offloadToolOutput` (pure orchestration).
- `packages/langchain/src/tool-converter.ts` — optional `offload` param, applied in both return paths.
- `packages/langchain/src/agent-adapter.ts` — thread `offload` through options to `convertToolToLangChain`.
- `packages/langchain/src/index.ts` — export `OffloadStore`, `offloadToolOutput`, types.

**Modified — `@dawn-ai/cli`:**
- `packages/cli/src/lib/runtime/execute-route.ts` — build the offload callback when workspace exists; thread into the adapter.

**New tests:** `packages/langchain/test/offload-stub.test.ts`, `offload-store.test.ts`, `offload-tool-output.test.ts`, additions to `tool-converter.test.ts`; `packages/workspace/test/local-filesystem.test.ts` additions; integration in `packages/langchain/test/offload-integration.test.ts`.

---

## Task 1: `DawnConfig.toolOutput` config type

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Locate DawnConfig**

Run: `grep -n "interface DawnConfig" -A20 packages/core/src/types.ts`

- [ ] **Step 2: Add the field**

Inside the `DawnConfig` interface, add:

```ts
readonly toolOutput?: {
  /** Offload tool outputs whose serialized length exceeds this many characters. Default 40000. */
  readonly offloadThresholdChars?: number
  /** Number of leading lines kept in the in-context preview. Default 10. */
  readonly previewLines?: number
  /** Max total bytes retained under workspace/tool-outputs/. Default 268435456 (256MB). */
  readonly maxBytes?: number
  /** Delete offloaded files older than this many ms. Default 10800000 (3h). */
  readonly ttlMs?: number
  /** Minimum ms between GC scans. Default 10000 (10s). */
  readonly gcThrottleMs?: number
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @dawn-ai/core typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add toolOutput offloading config to DawnConfig"
```

---

## Task 2: Optional `statFile`/`removeFile`/`touchFile` on `FilesystemBackend`

**Context:** GC needs file sizes + mtimes + delete; LRU needs an mtime bump. Add these as **optional** methods so existing custom backends don't break; the default `localFilesystem` implements them.

**Files:**
- Modify: `packages/workspace/src/types.ts`
- Modify: `packages/workspace/src/local-filesystem.ts`
- Test: `packages/workspace/test/local-filesystem.test.ts`

- [ ] **Step 1: Write failing tests**

Read `packages/workspace/test/local-filesystem.test.ts` for its fixture style (temp dir + `localFilesystem()` + a `BackendContext`). Add:

```ts
it("statFile returns size and mtimeMs", async () => {
  const fs = localFilesystem()
  const p = join(dir, "f.txt")
  await fs.writeFile(p, "hello", ctx)
  const s = await fs.statFile?.(p, ctx)
  expect(s?.size).toBe(5)
  expect(typeof s?.mtimeMs).toBe("number")
})

it("removeFile deletes a file", async () => {
  const fs = localFilesystem()
  const p = join(dir, "f.txt")
  await fs.writeFile(p, "x", ctx)
  await fs.removeFile?.(p, ctx)
  await expect(fs.readFile(p, ctx)).rejects.toThrow()
})

it("touchFile updates mtime to now", async () => {
  const fs = localFilesystem()
  const p = join(dir, "f.txt")
  await fs.writeFile(p, "x", ctx)
  const before = (await fs.statFile?.(p, ctx))?.mtimeMs ?? 0
  await new Promise((r) => setTimeout(r, 12))
  await fs.touchFile?.(p, ctx)
  const after = (await fs.statFile?.(p, ctx))?.mtimeMs ?? 0
  expect(after).toBeGreaterThan(before)
})
```

- [ ] **Step 2: Run (expect fail)**

Run: `pnpm --filter @dawn-ai/workspace test local-filesystem`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Extend the interface**

In `packages/workspace/src/types.ts`, add to `FilesystemBackend` (after `listDir`):

```ts
  /** Stat a file. Optional — backends that omit it disable offload GC. */
  statFile?(path: string, ctx: BackendContext): Promise<{ readonly size: number; readonly mtimeMs: number }>

  /** Delete a file. Optional — required for offload GC eviction. */
  removeFile?(path: string, ctx: BackendContext): Promise<void>

  /** Bump a file's mtime to now (LRU-by-access). Optional. */
  touchFile?(path: string, ctx: BackendContext): Promise<void>
```

- [ ] **Step 4: Implement in localFilesystem**

In `packages/workspace/src/local-filesystem.ts`, update the import and add the methods to the returned object:

```ts
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
```

```ts
    async statFile(path: string, _ctx: BackendContext) {
      const s = await stat(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    },
    async removeFile(path: string, _ctx: BackendContext) {
      await rm(path, { force: true })
    },
    async touchFile(path: string, _ctx: BackendContext) {
      const now = new Date()
      await utimes(path, now, now)
    },
```

- [ ] **Step 5: Run (expect pass)**

Run: `pnpm --filter @dawn-ai/workspace test local-filesystem`
Expected: PASS.

- [ ] **Step 6: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/workspace lint && pnpm --filter @dawn-ai/workspace typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace/src/types.ts packages/workspace/src/local-filesystem.ts packages/workspace/test/local-filesystem.test.ts
git commit -m "feat(workspace): optional statFile/removeFile/touchFile on FilesystemBackend"
```

---

## Task 3: `buildStub` (pure preview+pointer builder)

**Files:**
- Create: `packages/langchain/src/offload/stub.ts`
- Test: `packages/langchain/test/offload-stub.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest"
import { buildStub } from "../src/offload/stub.js"

describe("buildStub", () => {
  it("includes char count, path, threshold, and N preview lines", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const stub = buildStub({
      content,
      relPath: "tool-outputs/search-1-a.txt",
      previewLines: 10,
      thresholdChars: 40000,
    })
    expect(stub).toContain(`${content.length} chars`)
    expect(stub).toContain("40,000")
    expect(stub).toContain("tool-outputs/search-1-a.txt")
    expect(stub).toContain("line 1")
    expect(stub).toContain("line 10")
    expect(stub).not.toContain("line 11")
    expect(stub).toContain("readFile")
  })

  it("shows all lines when content has fewer than previewLines", () => {
    const stub = buildStub({ content: "only one line", relPath: "tool-outputs/x.txt", previewLines: 10, thresholdChars: 40000 })
    expect(stub).toContain("only one line")
  })
})
```

- [ ] **Step 2: Run (expect fail)**

Run: `pnpm --filter @dawn-ai/langchain test offload-stub`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/langchain/src/offload/stub.ts
export interface BuildStubArgs {
  readonly content: string
  readonly relPath: string
  readonly previewLines: number
  readonly thresholdChars: number
}

export function buildStub(args: BuildStubArgs): string {
  const lines = args.content.split("\n").slice(0, args.previewLines)
  const preview = lines.join("\n")
  const chars = args.content.length.toLocaleString("en-US")
  const threshold = args.thresholdChars.toLocaleString("en-US")
  return [
    `[Tool output offloaded — ${chars} chars exceeded the ${threshold}-char limit.`,
    `Full output saved to: ${args.relPath}`,
    `Preview (first ${args.previewLines} lines):`,
    preview,
    `Read the full output with the readFile tool at the path above.]`,
  ].join("\n")
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test offload-stub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/offload/stub.ts packages/langchain/test/offload-stub.test.ts
git commit -m "feat(langchain): buildStub preview+pointer builder for offloading"
```

---

## Task 4: `OffloadStore` + `runGc` (persistence + throttled eviction)

**Context:** Wraps a `FilesystemBackend` + workspace root + cap config. `write(toolName, content)` writes a uniquely-named file under `tool-outputs/`, then runs throttled GC. `runGc` lists the dir, deletes TTL-expired files, then deletes oldest-by-mtime until under `maxBytes`.

**Files:**
- Create: `packages/langchain/src/offload/offload-store.ts`
- Test: `packages/langchain/test/offload-store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { localFilesystem } from "@dawn-ai/workspace"
import { OffloadStore } from "../src/offload/offload-store.js"

describe("OffloadStore", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-offload-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function store(overrides = {}) {
    return new OffloadStore({
      backend: localFilesystem(),
      workspaceRoot: dir,
      signal: new AbortController().signal,
      maxBytes: 1000,
      ttlMs: 10_800_000,
      gcThrottleMs: 0,
      ...overrides,
    })
  }

  it("write persists full content and returns a tool-outputs/ relative path", async () => {
    const s = store()
    const rel = await s.write("search", "FULL CONTENT")
    expect(rel.startsWith("tool-outputs/")).toBe(true)
    const abs = join(dir, rel)
    const back = await localFilesystem().readFile(abs, { signal: new AbortController().signal, workspaceRoot: dir })
    expect(back).toBe("FULL CONTENT")
  })

  it("evicts oldest files once total size exceeds maxBytes", async () => {
    const s = store({ maxBytes: 30, gcThrottleMs: 0 })
    const a = await s.write("t", "a".repeat(20))
    await new Promise((r) => setTimeout(r, 5))
    const b = await s.write("t", "b".repeat(20)) // total 40 > 30 → evict oldest (a)
    const ctx = { signal: new AbortController().signal, workspaceRoot: dir }
    await expect(localFilesystem().readFile(join(dir, a), ctx)).rejects.toThrow()
    expect(await localFilesystem().readFile(join(dir, b), ctx)).toBe("b".repeat(20))
  })

  it("evicts files older than ttlMs", async () => {
    const s = store({ maxBytes: 10_000, ttlMs: 1 })
    const a = await s.write("t", "old")
    await new Promise((r) => setTimeout(r, 10))
    await s.write("t", "new") // triggers GC; a is now >1ms old
    const ctx = { signal: new AbortController().signal, workspaceRoot: dir }
    await expect(localFilesystem().readFile(join(dir, a), ctx)).rejects.toThrow()
  })

  it("throttles GC scans within gcThrottleMs", async () => {
    const s = store({ maxBytes: 10, gcThrottleMs: 60_000 })
    const a = await s.write("t", "a".repeat(20))
    const b = await s.write("t", "b".repeat(20)) // would evict a, but throttled
    const ctx = { signal: new AbortController().signal, workspaceRoot: dir }
    expect(await localFilesystem().readFile(join(dir, a), ctx)).toBe("a".repeat(20))
    expect(await localFilesystem().readFile(join(dir, b), ctx)).toBe("b".repeat(20))
  })
})
```

- [ ] **Step 2: Run (expect fail)**

Run: `pnpm --filter @dawn-ai/langchain test offload-store`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/langchain/src/offload/offload-store.ts
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import type { FilesystemBackend } from "@dawn-ai/workspace"

const SUBDIR = "tool-outputs"

export interface OffloadStoreOptions {
  readonly backend: FilesystemBackend
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  readonly maxBytes: number
  readonly ttlMs: number
  readonly gcThrottleMs: number
  /** Injectable clock for tests. Defaults to Date.now. */
  readonly now?: () => number
}

export class OffloadStore {
  private lastGcAt = 0
  constructor(private readonly opts: OffloadStoreOptions) {}

  private get ctx() {
    return { signal: this.opts.signal, workspaceRoot: this.opts.workspaceRoot }
  }
  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** Persist full content; returns the workspace-relative path. Runs throttled GC. */
  async write(toolName: string, content: string): Promise<string> {
    const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_")
    const fileName = `${safeName}-${this.now()}-${randomBytes(3).toString("hex")}.txt`
    const relPath = `${SUBDIR}/${fileName}`
    const absPath = join(this.opts.workspaceRoot, relPath)
    await this.opts.backend.writeFile(absPath, content, this.ctx)
    await this.maybeGc()
    return relPath
  }

  private async maybeGc(): Promise<void> {
    const now = this.now()
    if (now - this.lastGcAt < this.opts.gcThrottleMs) return
    this.lastGcAt = now
    const { backend } = this.opts
    if (!backend.statFile || !backend.removeFile) return // GC unsupported by backend
    const dirAbs = join(this.opts.workspaceRoot, SUBDIR)

    let names: readonly string[]
    try {
      names = await backend.listDir(dirAbs, this.ctx)
    } catch {
      return // dir not created yet / unreadable
    }

    const entries: { abs: string; size: number; mtimeMs: number }[] = []
    for (const name of names) {
      const abs = join(dirAbs, name)
      try {
        const s = await backend.statFile(abs, this.ctx)
        entries.push({ abs, size: s.size, mtimeMs: s.mtimeMs })
      } catch {
        /* skip unstattable */
      }
    }

    // TTL pass
    const ttlCutoff = now - this.opts.ttlMs
    const survivors: typeof entries = []
    for (const e of entries) {
      if (e.mtimeMs < ttlCutoff) {
        await this.safeRemove(e.abs)
      } else {
        survivors.push(e)
      }
    }

    // Size pass: oldest-first until under maxBytes
    let total = survivors.reduce((sum, e) => sum + e.size, 0)
    if (total <= this.opts.maxBytes) return
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const e of survivors) {
      if (total <= this.opts.maxBytes) break
      await this.safeRemove(e.abs)
      total -= e.size
    }
  }

  private async safeRemove(abs: string): Promise<void> {
    try {
      await this.opts.backend.removeFile?.(abs, this.ctx)
    } catch {
      /* tolerate single-file delete failure */
    }
  }
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test offload-store`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain typecheck`
Expected: clean. (`@dawn-ai/workspace` must be a dependency of `@dawn-ai/langchain` — check `grep '"@dawn-ai/workspace"' packages/langchain/package.json`; if absent, add `"@dawn-ai/workspace": "workspace:*"` and `pnpm install`.)

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/offload/offload-store.ts packages/langchain/test/offload-store.test.ts packages/langchain/package.json pnpm-lock.yaml
git commit -m "feat(langchain): OffloadStore with throttled size+TTL GC"
```

(Only add package.json/lock if you changed them in Step 5.)

---

## Task 5: `offloadToolOutput` (pure orchestration)

**Files:**
- Create: `packages/langchain/src/offload/offload-tool-output.ts`
- Test: `packages/langchain/test/offload-tool-output.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, vi } from "vitest"
import { offloadToolOutput } from "../src/offload/offload-tool-output.js"

function fakeStore(rel = "tool-outputs/x-1-a.txt") {
  return { write: vi.fn(async () => rel) }
}

describe("offloadToolOutput", () => {
  const base = { toolName: "search", thresholdChars: 40_000, previewLines: 10 }

  it("returns content unchanged when under threshold", async () => {
    const store = fakeStore()
    const out = await offloadToolOutput("small", { ...base, store: store as never })
    expect(out).toBe("small")
    expect(store.write).not.toHaveBeenCalled()
  })

  it("writes and returns a stub when over threshold", async () => {
    const store = fakeStore("tool-outputs/search-1-a.txt")
    const big = "x".repeat(40_001)
    const out = await offloadToolOutput(big, { ...base, store: store as never })
    expect(store.write).toHaveBeenCalledWith("search", big)
    expect(out).toContain("Tool output offloaded")
    expect(out).toContain("tool-outputs/search-1-a.txt")
  })

  it("returns original content if the store write throws", async () => {
    const store = { write: vi.fn(async () => { throw new Error("disk full") }) }
    const big = "x".repeat(40_001)
    const out = await offloadToolOutput(big, { ...base, store: store as never })
    expect(out).toBe(big)
  })
})
```

- [ ] **Step 2: Run (expect fail)**

Run: `pnpm --filter @dawn-ai/langchain test offload-tool-output`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/langchain/src/offload/offload-tool-output.ts
import type { OffloadStore } from "./offload-store.js"
import { buildStub } from "./stub.js"

export interface OffloadToolOutputCtx {
  readonly toolName: string
  readonly thresholdChars: number
  readonly previewLines: number
  readonly store: Pick<OffloadStore, "write">
}

export async function offloadToolOutput(content: string, ctx: OffloadToolOutputCtx): Promise<string> {
  if (content.length <= ctx.thresholdChars) return content
  try {
    const relPath = await ctx.store.write(ctx.toolName, content)
    return buildStub({
      content,
      relPath,
      previewLines: ctx.previewLines,
      thresholdChars: ctx.thresholdChars,
    })
  } catch {
    // Never break a tool because offloading failed; keep the original content.
    return content
  }
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test offload-tool-output`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/offload/offload-tool-output.ts packages/langchain/test/offload-tool-output.test.ts
git commit -m "feat(langchain): offloadToolOutput orchestration with write-failure fallback"
```

---

## Task 6: Apply offload in `convertToolToLangChain` (both return paths)

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Test: `packages/langchain/test/tool-converter.test.ts`

- [ ] **Step 1: Write failing tests** (append to existing `tool-converter.test.ts`)

```ts
describe("convertToolToLangChain offloading", () => {
  it("replaces large plain-return content with a stub", async () => {
    const big = "x".repeat(50_000)
    const tool = { name: "dump", description: "", run: async () => big }
    const offload = async (content: string, toolName: string) =>
      content.length > 40_000 ? `STUB:${toolName}` : content
    const converted = convertToolToLangChain(tool, undefined, offload)
    const result = await converted.func({}, undefined as never, { signal: new AbortController().signal } as never)
    expect(result).toBe("STUB:dump")
  })

  it("replaces large {result,state} content with a stub in the ToolMessage", async () => {
    const big = "y".repeat(50_000)
    const tool = { name: "dump2", description: "", run: async () => ({ result: big, state: { k: 1 } }) }
    const offload = async (content: string) => (content.length > 40_000 ? "STUB2" : content)
    const converted = convertToolToLangChain(tool, undefined, offload)
    const result = await converted.func({}, undefined as never, { signal: new AbortController().signal } as never)
    const cmd = result as { update: { messages: Array<{ content: unknown }>; k?: number } }
    expect(cmd.update.messages[0]?.content).toBe("STUB2")
    expect(cmd.update.k).toBe(1)
  })

  it("is a pass-through when no offload callback is given", async () => {
    const big = "z".repeat(50_000)
    const tool = { name: "dump3", description: "", run: async () => big }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func({}, undefined as never, { signal: new AbortController().signal } as never)
    expect(result).toBe(big)
  })
})
```

- [ ] **Step 2: Run (expect fail)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: FAIL — `convertToolToLangChain` takes only 2 args; offload ignored.

- [ ] **Step 3: Implement**

In `packages/langchain/src/tool-converter.ts`, add a third parameter and apply it to `content` before building the message. Replace the signature + `func` body:

```ts
export type OffloadFn = (content: string, toolName: string) => Promise<string>

export function convertToolToLangChain(
  tool: DawnToolDefinition,
  middlewareContext?: Readonly<Record<string, unknown>>,
  offload?: OffloadFn,
): DynamicStructuredTool {
  const schema = toZodSchema(tool.schema)

  return new DynamicStructuredTool({
    name: tool.name,
    description: tool.description ?? "",
    schema,
    func: async (input, _runManager, config) => {
      const signal = config?.signal ?? new AbortController().signal
      const rawResult = await tool.run(input, {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
      })
      const { content, stateUpdates } = unwrapToolResult(rawResult)
      const finalContent = offload ? await offload(content, tool.name) : content

      if (stateUpdates) {
        const toolCallId = extractToolCallId(config)
        return new Command({
          update: {
            ...stateUpdates,
            messages: [
              new ToolMessage({ content: finalContent, tool_call_id: toolCallId, name: tool.name }),
            ],
          },
        })
      }

      return finalContent
    },
  })
}
```

Note: `unwrapToolResult` returns a string `content`; `offload` operates on that string in both branches.

- [ ] **Step 4: Run (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test tool-converter`
Expected: PASS (new + all existing converter tests).

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/langchain lint && pnpm --filter @dawn-ai/langchain typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts
git commit -m "feat(langchain): apply offload callback in convertToolToLangChain (both paths)"
```

---

## Task 7: Thread `offload` through the agent adapter

**Context:** `convertToolToLangChain` is called at `agent-adapter.ts:87` and `:400`. The adapter's options must carry an optional `offload` and pass it through both call sites.

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/src/index.ts`

- [ ] **Step 1: Inspect the call sites + options type**

Run: `grep -n "convertToolToLangChain\|middlewareContext\|interface.*Options\|offload" packages/langchain/src/agent-adapter.ts`
Read the two call sites (≈ lines 87 and 400) and the options interface(s) feeding them.

- [ ] **Step 2: Add `offload` to the adapter options**

Add `readonly offload?: OffloadFn` to the options interface(s) used by the two call sites (import `OffloadFn` from `./tool-converter.js`). Pass it as the 3rd arg at both call sites:

```ts
// line ~87
const langchainTools = tools.map((tool) => convertToolToLangChain(tool, middlewareContext, options.offload))
// line ~400
convertToolToLangChain(tool, options.middlewareContext, options.offload),
```

(Match the exact local variable names at each site — one uses `middlewareContext`, the other `options.middlewareContext`.)

- [ ] **Step 3: Export offload surface from the package**

In `packages/langchain/src/index.ts`, add:

```ts
export { OffloadStore } from "./offload/offload-store.js"
export type { OffloadStoreOptions } from "./offload/offload-store.js"
export { offloadToolOutput } from "./offload/offload-tool-output.js"
export type { OffloadToolOutputCtx } from "./offload/offload-tool-output.js"
export { buildStub } from "./offload/stub.js"
export type { OffloadFn } from "./tool-converter.js"
```

- [ ] **Step 4: Typecheck + existing tests**

Run: `pnpm --filter @dawn-ai/langchain typecheck && pnpm --filter @dawn-ai/langchain test`
Expected: clean + green (offload is optional, so existing adapter behavior is unchanged).

- [ ] **Step 5: Lint**

Run: `pnpm --filter @dawn-ai/langchain lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/src/index.ts
git commit -m "feat(langchain): thread offload callback through agent adapter + exports"
```

---

## Task 8: Construct the offloader in `execute-route` when a workspace exists

**Context:** `execute-route.ts` already loads `dawn.config.ts` (`loaded.config`), has `configBackends` (line ~398), and imports `FilesystemBackend` from `@dawn-ai/workspace`. The workspace capability uses `join(process.cwd(), "workspace")` as the root and `configBackends?.filesystem ?? localFilesystem()`. Build an `OffloadStore` + `offload` callback under the same conditions and pass it into the adapter options.

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route.ts`

- [ ] **Step 1: Inspect the wiring**

Run: `grep -n "process.cwd\|workspace\|configBackends\|streamAgent\|executeAgent\|localFilesystem\|loaded.config\|middlewareContext" packages/cli/src/lib/runtime/execute-route.ts`
Identify (a) how the workspace root is computed / where its existence is checked, (b) where the agent adapter (`streamAgent`/`executeAgent`) options object is built.

- [ ] **Step 2: Add imports**

```ts
import { existsSync } from "node:fs"
import { join } from "node:path"
import { localFilesystem } from "@dawn-ai/workspace"
import { OffloadStore, type OffloadFn } from "@dawn-ai/langchain"
```

(Some may already be imported — don't duplicate.)

- [ ] **Step 3: Build the offload callback**

After `dawn.config` is loaded and `configBackends` is known, add:

```ts
function buildOffload(
  config: { toolOutput?: Record<string, number | undefined> } | undefined,
  filesystem: FilesystemBackend | undefined,
  signal: AbortSignal,
): OffloadFn | undefined {
  const workspaceRoot = join(process.cwd(), "workspace")
  if (!existsSync(workspaceRoot)) return undefined
  const t = config?.toolOutput ?? {}
  const store = new OffloadStore({
    backend: filesystem ?? localFilesystem(),
    workspaceRoot,
    signal,
    maxBytes: t.maxBytes ?? 268_435_456,
    ttlMs: t.ttlMs ?? 10_800_000,
    gcThrottleMs: t.gcThrottleMs ?? 10_000,
  })
  const thresholdChars = t.offloadThresholdChars ?? 40_000
  const previewLines = t.previewLines ?? 10
  return (content, toolName) =>
    import("@dawn-ai/langchain").then(({ offloadToolOutput }) =>
      offloadToolOutput(content, { toolName, thresholdChars, previewLines, store }),
    )
}
```

Prefer a static import of `offloadToolOutput` at top-of-file rather than the dynamic `import()` above if it doesn't create a cycle; the dynamic form is shown only as a cycle-safe fallback. Use the static import:

```ts
import { OffloadStore, offloadToolOutput, type OffloadFn } from "@dawn-ai/langchain"
// ...
  return (content, toolName) =>
    offloadToolOutput(content, { toolName, thresholdChars, previewLines, store })
```

- [ ] **Step 4: Wire it into the adapter options**

At the site(s) where the `streamAgent`/`executeAgent` options object is constructed, compute the callback once (reusing the request's `AbortSignal` — the same one already threaded as `options.signal`) and spread it in:

```ts
const offload = buildOffload(loaded.config, configBackends?.filesystem, signal)
// ...in the options object:
  ...(offload ? { offload } : {}),
```

Use whatever `signal` variable is already in scope for the run; if none, use `new AbortController().signal`.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint`
Expected: clean. (`@dawn-ai/workspace` is already a dep of cli — it's imported at line 30. Confirm `@dawn-ai/langchain` exports `OffloadStore`/`offloadToolOutput`/`OffloadFn` from Task 7.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/execute-route.ts
git commit -m "feat(cli): wire tool-output offloader when a workspace exists"
```

---

## Task 9: LRU mtime-bump in the workspace `readFile`

**Context:** `packages/core/src/capabilities/built-in/workspace.ts` defines the `readFile` tool. When the resolved read path is under `tool-outputs/`, bump its mtime via the backend's `touchFile` (if available) so re-read outputs survive eviction. Never touch user files.

**Files:**
- Modify: `packages/core/src/capabilities/built-in/workspace.ts`
- Test: `packages/core/test/` (workspace capability test — locate it)

- [ ] **Step 1: Locate the readFile tool + its backend access**

Run: `grep -n "readFile\|touchFile\|backend\|workspaceRoot\|tool-outputs\|resolve" packages/core/src/capabilities/built-in/workspace.ts`
Read the `readFile` tool's `run` to see how it resolves the absolute path and how it calls `backend.readFile`.

- [ ] **Step 2: Write failing test**

Find the workspace capability test (e.g. `grep -rln "createWorkspaceMarker\|readFile" packages/core/test`). Add a test that: builds the workspace tools with a backend whose `touchFile` is a spy; calls `readFile` on a path under `tool-outputs/`; asserts `touchFile` was called. And a second: reads a normal file (e.g. `notes.md`) and asserts `touchFile` was NOT called.

```ts
it("bumps mtime when reading a tool-outputs/ file", async () => {
  const touched: string[] = []
  const backend = {
    readFile: async () => "data",
    writeFile: async () => ({ bytesWritten: 4 }),
    listDir: async () => [],
    touchFile: async (p: string) => { touched.push(p) },
  }
  // build workspace tools with this backend + a workspaceRoot, invoke readFile({ path: "tool-outputs/x.txt" })
  // assert touched has one entry ending in tool-outputs/x.txt
})

it("does not bump mtime for normal file reads", async () => {
  // same setup, readFile({ path: "notes.md" }) → touched is empty
})
```

Adapt the harness to however the test file constructs workspace tools (match existing patterns).

- [ ] **Step 3: Run (expect fail)**

Run: `pnpm --filter @dawn-ai/core test workspace`
Expected: FAIL — no touch happens.

- [ ] **Step 4: Implement the conditional touch**

In the `readFile` tool's `run`, after resolving the absolute path and before/after the `backend.readFile` call, add:

```ts
// LRU-by-access: keep recently-read offloaded outputs alive against GC.
const rel = relative(workspaceRoot, absPath)
if ((rel === "tool-outputs" || rel.startsWith(`tool-outputs${sep}`)) && backend.touchFile) {
  try {
    await backend.touchFile(absPath, ctx)
  } catch {
    /* touch is best-effort */
  }
}
```

Import `relative` and `sep` from `node:path` if not present. Use the same `absPath`/`ctx`/`workspaceRoot` names the existing code uses (adjust to match).

- [ ] **Step 5: Run (expect pass)**

Run: `pnpm --filter @dawn-ai/core test workspace`
Expected: PASS.

- [ ] **Step 6: Lint + typecheck**

Run: `pnpm --filter @dawn-ai/core lint && pnpm --filter @dawn-ai/core typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/capabilities/built-in/workspace.ts packages/core/test
git commit -m "feat(core): LRU mtime-bump on reading tool-outputs/ files"
```

---

## Task 10: End-to-end integration test

**Files:**
- Create: `packages/langchain/test/offload-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { localFilesystem } from "@dawn-ai/workspace"
import { convertToolToLangChain, OffloadStore, offloadToolOutput } from "../src/index.js"

describe("tool-output offloading end-to-end", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dawn-offload-e2e-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("offloads a large tool result and the full payload is retrievable", async () => {
    const backend = localFilesystem()
    const signal = new AbortController().signal
    const store = new OffloadStore({
      backend, workspaceRoot: dir, signal,
      maxBytes: 10_000_000, ttlMs: 10_800_000, gcThrottleMs: 0,
    })
    const offload = (content: string, toolName: string) =>
      offloadToolOutput(content, { toolName, thresholdChars: 40_000, previewLines: 10, store })

    const big = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n") // > 40k chars
    const tool = { name: "bigsearch", description: "", run: async () => big }
    const converted = convertToolToLangChain(tool, undefined, offload)

    const result = (await converted.func({}, undefined as never, { signal } as never)) as string
    expect(result).toContain("Tool output offloaded")
    const m = result.match(/tool-outputs\/[^\s\]]+/)
    expect(m).not.toBeNull()
    const rel = m?.[0] ?? ""
    const full = await backend.readFile(join(dir, rel), { signal, workspaceRoot: dir })
    expect(full).toBe(big)
  })

  it("GC evicts the oldest offloaded file once the size cap is crossed", async () => {
    const backend = localFilesystem()
    const signal = new AbortController().signal
    const store = new OffloadStore({
      backend, workspaceRoot: dir, signal,
      maxBytes: 60_000, ttlMs: 10_800_000, gcThrottleMs: 0,
    })
    const a = await store.write("t", "a".repeat(50_000))
    await new Promise((r) => setTimeout(r, 5))
    await store.write("t", "b".repeat(50_000)) // 100k > 60k cap → evict a
    await expect(backend.readFile(join(dir, a), { signal, workspaceRoot: dir })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run (expect pass)**

Run: `pnpm --filter @dawn-ai/langchain test offload-integration`
Expected: PASS.

- [ ] **Step 3: Full build + lint + typecheck + test across touched packages**

```bash
pnpm --filter @dawn-ai/core --filter @dawn-ai/workspace --filter @dawn-ai/langchain --filter @dawn-ai/cli build
pnpm lint && pnpm typecheck && pnpm test
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/langchain/test/offload-integration.test.ts
git commit -m "test(langchain): end-to-end tool-output offloading + GC eviction"
```

---

## Task 11: Changeset, memory, PR

**Files:**
- Create: `.changeset/phase3-tool-output-offloading.md`
- Modify: phase status memory

- [ ] **Step 1: Write the changeset**

```md
---
"@dawn-ai/core": minor
"@dawn-ai/workspace": minor
"@dawn-ai/langchain": minor
"@dawn-ai/cli": minor
---

Add tool-output offloading. When a tool returns output larger than `toolOutput.offloadThresholdChars` (default 40,000), the full payload is written to `workspace/tool-outputs/` and the in-context ToolMessage is replaced with a preview+pointer stub; the agent retrieves the full content with the existing `readFile` tool. Active automatically when a workspace exists. The directory is bounded by a size + TTL cap (defaults 256MB / 3h) with throttled evict-on-write and LRU-by-access eviction (readFile bumps mtime for tool-outputs/ files). Large content never enters message state, so there is no tool-call/result pairing hazard. Configurable via `dawn.config.ts` `toolOutput`.
```

- [ ] **Step 2: Verify the changeset check**

Run: `BASE_REF=origin/main HEAD_REF=feat/phase3-tool-output-offloading node scripts/check-changesets.mjs`
Expected: "Changesets check passed".

- [ ] **Step 3: Push + open PR**

```bash
git add .changeset/phase3-tool-output-offloading.md
git commit -m "chore: changeset for tool-output offloading"
git push -u origin feat/phase3-tool-output-offloading
gh pr create --title "feat: phase3 sub-project 6a — tool-output offloading" --body "$(cat <<'EOF'
## Summary
- Large tool outputs (> 40k chars, configurable) are offloaded to workspace/tool-outputs/ with a preview+pointer stub; retrieved via the existing readFile tool. Mirrors deepagents.
- Intercepts at tool-result creation, so the large payload never enters message state (no tool-call/result pairing hazard).
- Directory bounded by size+TTL cap (256MB / 3h) with throttled evict-on-write + LRU-by-access (readFile bumps mtime). Every harness we researched leaks; this cap puts Dawn ahead.
- Active automatically when a workspace exists; no-op otherwise. Configurable via dawn.config.ts toolOutput.

Conversation summarization (6b) is deferred to its own spec.

## Test plan
- [x] Unit: buildStub, OffloadStore (+GC: size/TTL/throttle), offloadToolOutput (incl. write-failure fallback)
- [x] Unit: convertToolToLangChain offload in both return paths; pass-through without callback
- [x] Unit: workspace FilesystemBackend statFile/removeFile/touchFile; readFile mtime-bump only for tool-outputs/
- [x] Integration: large result offloaded + full payload retrievable; GC evicts oldest at cap
- [x] Full build + lint + typecheck + test green

Spec: docs/superpowers/specs/2026-05-29-phase3-tool-output-offloading-design.md
Plan: docs/superpowers/plans/2026-05-29-phase3-tool-output-offloading.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Update phase memory**

Edit `/Users/blove/.claude/projects/-Users-blove-repos-dawn/memory/project_phase_status.md`: mark sub-project 6a ✅ with the PR link; note 6b (summarization) remains deferred; update the header count.

---

## Self-Review

**Spec coverage:**
- Intercept at tool-result creation, both paths → Task 6. ✓
- `offloadToolOutput` pure unit + write-failure fallback → Task 5. ✓
- Storage to workspace/tool-outputs/ + stub format + readFile retrieval → Tasks 3 (stub), 4 (store.write), 6 (applied). ✓
- Activation only when workspace exists; no-op otherwise → Task 8 (`existsSync` guard) + Task 6 (pass-through without callback). ✓
- Character threshold + config (`toolOutput`) → Task 1 (type) + Tasks 5/8 (defaults 40000/10). ✓
- Cap: size + TTL, throttled evict-on-write, oldest-by-mtime → Task 4. ✓
- LRU-by-access (readFile touches mtime for tool-outputs/) → Task 9. ✓
- Backend additions (statFile/removeFile/touchFile, optional) → Task 2. ✓
- Edge cases: under-threshold pass-through (Task 5), no workspace (Task 8), write failure (Task 5), single-file delete failure (Task 4 `safeRemove`). ✓
- Testing (unit per unit + integration) → Tasks 2,3,4,5,6,9 (unit), 10 (integration). ✓
- Out-of-scope (6b, structured evicted error, token thresholds) → not implemented. ✓

**Placeholder scan:** No TBD/TODO. Tasks 7/8/9 instruct the implementer to `grep`/read exact call sites before editing (because line numbers drift across the multi-actor repo) — each gives the exact command and what to do with the result; this is deliberate discovery, not a placeholder. Task 8 shows both a dynamic-import fallback and the preferred static import, with explicit guidance to use the static form unless it cycles.

**Type consistency:** `OffloadStore` constructor options identical in Tasks 4, 8, 10. `OffloadFn = (content, toolName) => Promise<string>` consistent across Tasks 6, 7, 8. `offloadToolOutput(content, {toolName, thresholdChars, previewLines, store})` identical in Tasks 5, 8, 10. `store.write(toolName, content) → relPath` consistent in Tasks 4, 5, 10. Backend optional methods `statFile`/`removeFile`/`touchFile` defined in Task 2, consumed in Tasks 4 (GC) and 9 (touch). Config keys (`offloadThresholdChars`, `previewLines`, `maxBytes`, `ttlMs`, `gcThrottleMs`) identical in Tasks 1, 8, 11.
