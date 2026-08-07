import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FilesystemBackend } from "@dawn-ai/workspace"
import { localFilesystem } from "@dawn-ai/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildOffloadFileName, OffloadStore } from "../src/offload/offload-store.js"

describe("OffloadStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dawn-offload-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
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
    const back = await localFilesystem().readFile(join(dir, rel), {
      signal: new AbortController().signal,
      workspaceRoot: dir,
    })
    expect(back).toBe("FULL CONTENT")
  })
  it("evicts oldest files once total size exceeds maxBytes", async () => {
    const s = store({ maxBytes: 30, gcThrottleMs: 0 })
    const a = await s.write("t", "a".repeat(20))
    await new Promise((r) => setTimeout(r, 5))
    const b = await s.write("t", "b".repeat(20))
    const c = { signal: new AbortController().signal, workspaceRoot: dir }
    await expect(localFilesystem().readFile(join(dir, a), c)).rejects.toThrow()
    expect(await localFilesystem().readFile(join(dir, b), c)).toBe("b".repeat(20))
  })
  it("evicts files older than ttlMs", async () => {
    const s = store({ maxBytes: 10_000, ttlMs: 1 })
    const a = await s.write("t", "old")
    await new Promise((r) => setTimeout(r, 10))
    await s.write("t", "new")
    const c = { signal: new AbortController().signal, workspaceRoot: dir }
    await expect(localFilesystem().readFile(join(dir, a), c)).rejects.toThrow()
  })
  it("throttles GC scans within gcThrottleMs", async () => {
    const s = store({ maxBytes: 10, gcThrottleMs: 60_000 })
    const a = await s.write("t", "a".repeat(20))
    const b = await s.write("t", "b".repeat(20))
    const c = { signal: new AbortController().signal, workspaceRoot: dir }
    expect(await localFilesystem().readFile(join(dir, a), c)).toBe("a".repeat(20))
    expect(await localFilesystem().readFile(join(dir, b), c)).toBe("b".repeat(20))
  })
  it("uses a live operation signal with an abort-aware backend", async () => {
    const preparedSignal = new AbortController().signal
    const live = new AbortController()
    live.abort()
    const writeFile = vi.fn(async (_path, content, ctx) => {
      ctx.signal.throwIfAborted()
      return { bytesWritten: content.length }
    })
    const backend: FilesystemBackend = {
      listDir: async () => [],
      readFile: async () => "",
      realPath: async (path) => path,
      writeFile,
    }
    const s = store({ backend, signal: preparedSignal })

    await expect(s.write("search", "FULL CONTENT", undefined, live.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "FULL CONTENT",
      expect.objectContaining({ signal: live.signal }),
    )
  })
})

describe("buildOffloadFileName", () => {
  it("uses toolName-toolCallId when a tool_call_id is present", () => {
    expect(buildOffloadFileName("readFile", "x".repeat(100), "call_abc123")).toBe(
      "readFile-call_abc123.txt",
    )
  })

  it("falls back to a content hash when tool_call_id is absent", () => {
    const a = buildOffloadFileName("generateReport", "hello world", undefined)
    const b = buildOffloadFileName("generateReport", "hello world", "")
    expect(a).toMatch(/^generateReport-[0-9a-f]{16}\.txt$/)
    expect(b).toBe(a)
  })

  it("derives the fallback filename from a sha256 of the content (value-pinned)", () => {
    // The filename reaches persisted artifacts (the on-disk tool-outputs/ file and
    // the path string embedded in checkpointed tool messages), so the exact value —
    // not just its shape — is the contract. Computed here with node:crypto so an
    // implementation swap is a visible diff rather than an invisible one.
    const expected = createHash("sha256").update("hello world").digest("hex").slice(0, 16)
    expect(buildOffloadFileName("generateReport", "hello world", undefined)).toBe(
      `generateReport-${expected}.txt`,
    )
  })

  it("is stable for identical content and distinct for different content", () => {
    const a = buildOffloadFileName("t", "same", undefined)
    const b = buildOffloadFileName("t", "same", undefined)
    const c = buildOffloadFileName("t", "different", undefined)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("sanitizes unsafe characters in toolName and toolCallId", () => {
    expect(buildOffloadFileName("we/ir d", "y".repeat(50), "id/with space")).toBe(
      "we_ir_d-id_with_space.txt",
    )
  })
})
