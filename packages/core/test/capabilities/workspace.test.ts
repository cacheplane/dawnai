import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkspaceMarker } from "../../src/capabilities/built-in/workspace.js"
import type { CapabilityMarkerContext, DawnToolDefinition } from "../../src/capabilities/types.js"

const originalCwd = process.cwd()

function emptyManifest() {
  return { appRoot: "/app", routes: [] }
}

function ctx(
  appRoot: string,
  extras: Partial<CapabilityMarkerContext> = {},
): CapabilityMarkerContext {
  return {
    routeManifest: emptyManifest(),
    descriptor: undefined,
    appRoot,
    ...extras,
  }
}

function findTool(
  tools: ReadonlyArray<DawnToolDefinition> | undefined,
  name: string,
): DawnToolDefinition {
  const tool = (tools ?? []).find((t) => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

describe("createWorkspaceMarker — detect", () => {
  let appRoot: string
  let routeDir: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-workspace-cap-"))
    routeDir = join(appRoot, "route")
    mkdirSync(routeDir)
    process.chdir(appRoot)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("returns false when no workspace/ directory exists at appRoot", async () => {
    const detected = await createWorkspaceMarker().detect(routeDir, ctx(appRoot))
    expect(detected).toBe(false)
  })

  it("returns true when workspace/ exists at appRoot", async () => {
    mkdirSync(join(appRoot, "workspace"))
    const detected = await createWorkspaceMarker().detect(routeDir, ctx(appRoot))
    expect(detected).toBe(true)
  })
})

describe("createWorkspaceMarker — load", () => {
  let appRoot: string
  let routeDir: string
  let workspaceDir: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-workspace-cap-"))
    routeDir = join(appRoot, "route")
    mkdirSync(routeDir)
    workspaceDir = join(appRoot, "workspace")
    mkdirSync(workspaceDir)
    process.chdir(appRoot)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("contributes exactly four tools when workspace/ exists", async () => {
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot))
    const names = (contribution.tools ?? []).map((t) => t.name).sort()
    expect(names).toEqual(["listDir", "readFile", "runBash", "writeFile"])
  })

  it("contributes no tools when workspace/ is absent", async () => {
    rmSync(workspaceDir, { recursive: true })
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot))
    expect(contribution.tools).toBeUndefined()
  })

  it("readFile tool calls the configured backend with an absolute path inside the jail", async () => {
    writeFileSync(join(workspaceDir, "hello.txt"), "hi", "utf8")
    const fakeBackend = {
      readFile: vi.fn().mockResolvedValue("hi"),
      writeFile: vi.fn(),
      listDir: vi.fn(),
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx(appRoot, { backends: { filesystem: fakeBackend } }),
    )
    const readTool = findTool(contribution.tools, "readFile")
    const result = await readTool.run(
      { path: "hello.txt" },
      { signal: new AbortController().signal },
    )
    expect(result).toBe("hi")
    expect(fakeBackend.readFile).toHaveBeenCalledOnce()
    const firstCall = fakeBackend.readFile.mock.calls[0]
    if (!firstCall) throw new Error("readFile was not called")
    expect(firstCall[0]).toBe(join(appRoot, "workspace", "hello.txt"))
  })

  it("rejects path-jail escapes when permissions store is present (non-interactive mode)", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot, { permissions }))
    const readTool = findTool(contribution.tools, "readFile")
    await expect(
      readTool.run({ path: "../../etc/passwd" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/permission denied/i)
  })

  it("in bypass mode, every operation proceeds (path-jail disabled)", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "bypass",
    })
    await permissions.load()
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot, { permissions }))
    const readTool = findTool(contribution.tools, "readFile")
    // The file doesn't exist outside the workspace, so we expect ENOENT, NOT "outside workspace"
    await expect(
      readTool.run({ path: "../../etc/some-fake-file" }, { signal: new AbortController().signal }),
    ).rejects.not.toThrow(/outside workspace|permission denied/i)
  })

  it("in non-interactive mode, unknown bash commands hard-refuse", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot, { permissions }))
    const runBash = findTool(contribution.tools, "runBash")
    await expect(
      runBash.run({ command: "ls" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/permission denied|fail-closed/i)
  })

  it("config-seeded allow lets a bash command through in non-interactive mode", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { bash: ["echo"] }, deny: {} },
      mode: "non-interactive",
    })
    await permissions.load()
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot, { permissions }))
    const runBash = findTool(contribution.tools, "runBash")
    const result = await runBash.run(
      { command: "echo hi" },
      { signal: new AbortController().signal },
    )
    expect((result as { stdout: string }).stdout.trim()).toBe("hi")
  })

  it("uses the default local backends when none configured", async () => {
    writeFileSync(join(workspaceDir, "ok.txt"), "ok", "utf8")
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot))
    const readTool = findTool(contribution.tools, "readFile")
    const result = await readTool.run({ path: "ok.txt" }, { signal: new AbortController().signal })
    expect(result).toBe("ok")
  })

  it("runBash tool calls the configured exec backend", async () => {
    const fakeExec = {
      runCommand: vi.fn().mockResolvedValue({ stdout: "world", stderr: "", exitCode: 0 }),
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx(appRoot, { backends: { exec: fakeExec } }),
    )
    const runBash = findTool(contribution.tools, "runBash")
    const result = await runBash.run(
      { command: "echo world" },
      { signal: new AbortController().signal },
    )
    expect(result).toMatchObject({ stdout: "world", exitCode: 0 })
    expect(fakeExec.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo world" }),
      expect.any(Object),
    )
  })

  it("marks all four tools as overridable", async () => {
    const contribution = await createWorkspaceMarker().load(routeDir, ctx(appRoot))
    for (const t of contribution.tools ?? []) {
      expect((t as unknown as { overridable?: boolean }).overridable).toBe(true)
    }
  })

  it("readFile bumps mtime via touchFile when reading a tool-outputs/ path", async () => {
    const touched: string[] = []
    const fakeBackend = {
      readFile: async () => "data",
      writeFile: async () => ({ bytesWritten: 4 }),
      listDir: async () => [],
      touchFile: async (p: string) => {
        touched.push(p)
      },
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx(appRoot, { backends: { filesystem: fakeBackend } }),
    )
    const readTool = findTool(contribution.tools, "readFile")
    await readTool.run({ path: "tool-outputs/x.txt" }, { signal: new AbortController().signal })
    expect(touched).toHaveLength(1)
    expect(touched[0]).toMatch(/tool-outputs[/\\]x\.txt$/)
  })

  it("readFile does NOT call touchFile for normal (non-tool-outputs) file reads", async () => {
    const touched: string[] = []
    const fakeBackend = {
      readFile: async () => "hello",
      writeFile: async () => ({ bytesWritten: 5 }),
      listDir: async () => [],
      touchFile: async (p: string) => {
        touched.push(p)
      },
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx(appRoot, { backends: { filesystem: fakeBackend } }),
    )
    const readTool = findTool(contribution.tools, "readFile")
    await readTool.run({ path: "notes.md" }, { signal: new AbortController().signal })
    expect(touched).toHaveLength(0)
  })

  it("readFile passes maxBytes:Infinity when reading a tool-outputs/ path (uncapped)", async () => {
    const receivedOpts: Array<{ maxBytes?: number } | undefined> = []
    const fakeBackend = {
      readFile: async (_p: string, _c: unknown, opts?: { maxBytes?: number }) => {
        receivedOpts.push(opts)
        return "big content"
      },
      writeFile: async () => ({ bytesWritten: 0 }),
      listDir: async () => [],
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx(appRoot, { backends: { filesystem: fakeBackend } }),
    )
    const readTool = findTool(contribution.tools, "readFile")
    const result = await readTool.run(
      { path: "tool-outputs/output.txt" },
      { signal: new AbortController().signal },
    )
    expect(result).toBe("big content")
    expect(receivedOpts).toHaveLength(1)
    expect(receivedOpts[0]?.maxBytes).toBe(Number.POSITIVE_INFINITY)
  })

  it("readFile with real localFilesystem reads a >256KB tool-outputs/ file successfully", async () => {
    const { localFilesystem } = await import("@dawn-ai/workspace")
    // Use a tiny cap (10 bytes) to prove the override kicks in
    const tinyFs = localFilesystem({ maxFileBytes: 10 })
    const outputsDir = join(workspaceDir, "tool-outputs")
    mkdirSync(outputsDir, { recursive: true })
    const bigContent = "x".repeat(300 * 1024) // 300 KiB — way over 10-byte cap
    writeFileSync(join(outputsDir, "result.txt"), bigContent, "utf8")

    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx(appRoot, { backends: { filesystem: tinyFs } }),
    )
    const readTool = findTool(contribution.tools, "readFile")
    const result = await readTool.run(
      { path: "tool-outputs/result.txt" },
      { signal: new AbortController().signal },
    )
    expect(result).toBe(bigContent)
  })
})
