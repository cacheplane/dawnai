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

  it("statFile returns size and mtimeMs", async () => {
    const fs = localFilesystem()
    const p = join(root, "f.txt")
    await fs.writeFile(p, "hello", ctx(root))
    const s = await fs.statFile?.(p, ctx(root))
    expect(s?.size).toBe(5)
    expect(typeof s?.mtimeMs).toBe("number")
  })

  it("removeFile deletes a file", async () => {
    const fs = localFilesystem()
    const p = join(root, "f.txt")
    await fs.writeFile(p, "x", ctx(root))
    await fs.removeFile?.(p, ctx(root))
    await expect(fs.readFile(p, ctx(root))).rejects.toThrow()
  })

  it("touchFile updates mtime to now", async () => {
    const fs = localFilesystem()
    const p = join(root, "f.txt")
    await fs.writeFile(p, "x", ctx(root))
    const before = (await fs.statFile?.(p, ctx(root)))?.mtimeMs ?? 0
    await new Promise((r) => setTimeout(r, 12))
    await fs.touchFile?.(p, ctx(root))
    const after = (await fs.statFile?.(p, ctx(root)))?.mtimeMs ?? 0
    expect(after).toBeGreaterThan(before)
  })

  it("mkdir creates a directory recursively", async () => {
    const fs = localFilesystem()
    const nested = join(root, "a", "b", "c")
    await fs.mkdir?.(nested, ctx(root))
    // writing into it should now succeed
    await fs.writeFile(join(nested, "f.txt"), "x", ctx(root))
    expect(await fs.readFile(join(nested, "f.txt"), ctx(root))).toBe("x")
  })

  it("readFile honors a per-call maxBytes override", async () => {
    const fs = localFilesystem({ maxFileBytes: 10 })
    const p = join(root, "big.txt")
    await fs.writeFile(p, "x".repeat(100), ctx(root))
    await expect(fs.readFile(p, ctx(root))).rejects.toThrow(/too large/)            // default cap rejects
    expect(await fs.readFile(p, ctx(root), { maxBytes: Number.POSITIVE_INFINITY })).toBe("x".repeat(100)) // override allows
  })
})
