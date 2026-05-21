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
