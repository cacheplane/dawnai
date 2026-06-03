import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localFilesystem } from "@dawn-ai/workspace"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { convertToolToLangChain, OffloadStore, offloadToolOutput } from "../src/index.js"

describe("tool-output offloading end-to-end", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dawn-offload-e2e-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("offloads a large tool result and the full payload is retrievable", async () => {
    const backend = localFilesystem()
    const signal = new AbortController().signal
    const store = new OffloadStore({
      backend,
      workspaceRoot: dir,
      signal,
      maxBytes: 10_000_000,
      ttlMs: 10_800_000,
      gcThrottleMs: 0,
    })
    const offload = (content: string, toolName: string) =>
      offloadToolOutput(content, { toolName, thresholdChars: 40_000, previewLines: 10, store })

    const big = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n")
    const tool = { name: "bigsearch", description: "", run: async () => ({ result: big }) }
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
      backend,
      workspaceRoot: dir,
      signal,
      maxBytes: 60_000,
      ttlMs: 10_800_000,
      gcThrottleMs: 0,
    })
    const a = await store.write("t", "a".repeat(50_000))
    await new Promise((r) => setTimeout(r, 5))
    await store.write("t", "b".repeat(50_000))
    await expect(backend.readFile(join(dir, a), { signal, workspaceRoot: dir })).rejects.toThrow()
  })
})
