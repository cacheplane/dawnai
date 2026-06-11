import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { localFilesystem } from "@dawn-ai/workspace"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createWorkspaceFs } from "../../src/capabilities/workspace-fs.js"

describe("createWorkspaceFs", () => {
  let root: string
  let workspaceRoot: string
  const signal = new AbortController().signal

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dawn-wsfs-"))
    workspaceRoot = join(root, "workspace")
    mkdirSync(workspaceRoot, { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function make(backend = localFilesystem()) {
    return createWorkspaceFs({
      workspaceRoot,
      backend,
      permissions: undefined,
      signal,
      interruptCapable: false,
    })
  }

  it("resolves relative paths against the workspace root", async () => {
    writeFileSync(join(workspaceRoot, "notes.md"), "hello", "utf8")
    const fs = make()
    expect(await fs.readFile("notes.md")).toBe("hello")
  })

  it("round-trips writeFile/readFile and listDir", async () => {
    const fs = make()
    const res = await fs.writeFile("reports/out.md", "data")
    expect(res.bytesWritten).toBe(4)
    expect(await fs.readFile("reports/out.md")).toBe("data")
    expect([...(await fs.listDir("reports"))]).toEqual(["out.md"])
    expect([...(await fs.listDir())]).toContain("reports")
  })

  it("reads binary files as Uint8Array", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(join(workspaceRoot, "img.png"), bytes)
    const fs = make()
    const out = await fs.readBinaryFile("img.png")
    expect(out).toBeInstanceOf(Uint8Array)
    expect([...out]).toEqual([...bytes])
  })

  it("throws a descriptive error when the backend lacks readBinaryFile", async () => {
    const textOnly = {
      readFile: async () => "x",
      writeFile: async () => ({ bytesWritten: 1 }),
      listDir: async () => [],
    }
    const fs = createWorkspaceFs({
      workspaceRoot,
      backend: textOnly,
      permissions: undefined,
      signal,
      interruptCapable: false,
    })
    await expect(fs.readBinaryFile("img.png")).rejects.toThrow(
      /does not support binary reads \(readBinaryFile\)/,
    )
  })

  it("allows everything silently when no permissions store is provided", async () => {
    const outside = join(root, "outside.txt")
    writeFileSync(outside, "secret", "utf8")
    const fs = make()
    expect(await fs.readFile(outside)).toBe("secret")
  })

  it("forwards maxBytes to the backend", async () => {
    writeFileSync(join(workspaceRoot, "big.txt"), "x".repeat(100), "utf8")
    const fs = createWorkspaceFs({
      workspaceRoot,
      backend: localFilesystem({ maxFileBytes: 10 }),
      permissions: undefined,
      signal,
      interruptCapable: false,
    })
    await expect(fs.readFile("big.txt")).rejects.toThrow(/too large/)
    expect(await fs.readFile("big.txt", { maxBytes: 1000 })).toBe("x".repeat(100))
  })
})

describe("createWorkspaceFs permission gating", () => {
  let root: string
  let workspaceRoot: string
  let outsideDir: string
  let outsideFile: string
  const signal = new AbortController().signal

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dawn-wsfs-gate-"))
    workspaceRoot = join(root, "workspace")
    mkdirSync(workspaceRoot, { recursive: true })
    outsideDir = join(root, "shared")
    mkdirSync(outsideDir, { recursive: true })
    outsideFile = join(outsideDir, "outside.txt")
    writeFileSync(outsideFile, "secret", "utf8")
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeGated(permissions: Parameters<typeof createWorkspaceFs>[0]["permissions"]) {
    return createWorkspaceFs({
      workspaceRoot,
      backend: localFilesystem(),
      permissions,
      signal,
      interruptCapable: false,
    })
  }

  it("fails closed for outside paths with a non-interactive store", async () => {
    const permissions = createPermissionsStore({
      appRoot: root,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    const fs = makeGated(permissions)
    await expect(fs.readFile(outsideFile)).rejects.toThrow(/fail-closed/)
  })

  it("allows outside reads when a config allow rule matches the path", async () => {
    // Prefix-match pattern shaped like suggestedPathPattern: parent dir + "/"
    const permissions = createPermissionsStore({
      appRoot: root,
      config: { version: 1, allow: { readFile: [`${outsideDir}/`] }, deny: {} },
      mode: "non-interactive",
    })
    await permissions.load()
    const fs = makeGated(permissions)
    expect(await fs.readFile(outsideFile)).toBe("secret")
  })

  it("rejects with allow-rule guidance when interactive but interrupts unavailable", async () => {
    const permissions = createPermissionsStore({
      appRoot: root,
      config: undefined,
      mode: "interactive",
    })
    await permissions.load()
    const fs = makeGated(permissions)
    await expect(fs.readFile(outsideFile)).rejects.toThrow(/allow rule/)
  })

  it("gates outside writes under the writeFile operation, not readFile", async () => {
    // Allow rule covers readFile only — a write to the same outside dir must still fail.
    const permissions = createPermissionsStore({
      appRoot: root,
      config: { version: 1, allow: { readFile: [`${outsideDir}/`] }, deny: {} },
      mode: "non-interactive",
    })
    await permissions.load()
    const fs = makeGated(permissions)
    await expect(fs.writeFile(join(outsideDir, "new.txt"), "data")).rejects.toThrow(/fail-closed/)
  })

  it("gates relative ../ traversal out of the workspace", async () => {
    const permissions = createPermissionsStore({
      appRoot: root,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    const fs = makeGated(permissions)
    await expect(fs.readFile(join("..", "shared", "outside.txt"))).rejects.toThrow(/fail-closed/)
  })

  it("does not treat a sibling dir sharing the workspace prefix as inside", async () => {
    const evil = `${workspaceRoot}-evil`
    mkdirSync(evil, { recursive: true })
    writeFileSync(join(evil, "x.txt"), "evil", "utf8")
    const permissions = createPermissionsStore({
      appRoot: root,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    const fs = makeGated(permissions)
    await expect(fs.readFile(join(evil, "x.txt"))).rejects.toThrow(/fail-closed/)
  })

  it("skips gating entirely for a bypass-mode store", async () => {
    const permissions = createPermissionsStore({
      appRoot: root,
      config: undefined,
      mode: "bypass",
    })
    await permissions.load()
    const fs = makeGated(permissions)
    expect(await fs.readFile(outsideFile)).toBe("secret")
  })
})
