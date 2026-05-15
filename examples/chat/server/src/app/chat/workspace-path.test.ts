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
