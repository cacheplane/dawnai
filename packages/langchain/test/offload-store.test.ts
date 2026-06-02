import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localFilesystem } from "@dawn-ai/workspace"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { OffloadStore } from "../src/offload/offload-store.js"

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
})
