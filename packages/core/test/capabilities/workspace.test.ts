import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkspaceMarker } from "../../src/capabilities/built-in/workspace.js"
import type {
  CapabilityMarkerContext,
  DawnToolDefinition,
} from "../../src/capabilities/types.js"

function emptyManifest() {
  return { appRoot: "/app", routes: [] }
}

function ctx(extras: Partial<CapabilityMarkerContext> = {}): CapabilityMarkerContext {
  return {
    routeManifest: emptyManifest(),
    descriptor: undefined,
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
  let routeDir: string
  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-workspace-cap-"))
  })
  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("returns false when no workspace/ directory exists", async () => {
    const detected = await createWorkspaceMarker().detect(routeDir, ctx())
    expect(detected).toBe(false)
  })

  it("returns true when workspace/ exists", async () => {
    mkdirSync(join(routeDir, "workspace"))
    const detected = await createWorkspaceMarker().detect(routeDir, ctx())
    expect(detected).toBe(true)
  })
})

describe("createWorkspaceMarker — load", () => {
  let routeDir: string
  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-workspace-cap-"))
    mkdirSync(join(routeDir, "workspace"))
  })
  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("contributes exactly four tools when workspace/ exists", async () => {
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    const names = (contribution.tools ?? []).map((t) => t.name).sort()
    expect(names).toEqual(["listDir", "readFile", "runBash", "writeFile"])
  })

  it("contributes no tools when workspace/ is absent", async () => {
    rmSync(join(routeDir, "workspace"), { recursive: true })
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    expect(contribution.tools).toBeUndefined()
  })

  it("readFile tool calls the configured backend with an absolute path inside the jail", async () => {
    writeFileSync(join(routeDir, "workspace", "hello.txt"), "hi", "utf8")
    const fakeBackend = {
      readFile: vi.fn().mockResolvedValue("hi"),
      writeFile: vi.fn(),
      listDir: vi.fn(),
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx({ backends: { filesystem: fakeBackend } }),
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
    expect(firstCall[0]).toBe(join(routeDir, "workspace", "hello.txt"))
  })

  it("rejects path-jail escapes with a clear error", async () => {
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    const readTool = findTool(contribution.tools, "readFile")
    await expect(
      readTool.run({ path: "../../etc/passwd" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/outside workspace/i)
  })

  it("uses the default local backends when none configured", async () => {
    writeFileSync(join(routeDir, "workspace", "ok.txt"), "ok", "utf8")
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    const readTool = findTool(contribution.tools, "readFile")
    const result = await readTool.run(
      { path: "ok.txt" },
      { signal: new AbortController().signal },
    )
    expect(result).toBe("ok")
  })

  it("runBash tool calls the configured exec backend", async () => {
    const fakeExec = {
      runCommand: vi.fn().mockResolvedValue({ stdout: "world", stderr: "", exitCode: 0 }),
    }
    const contribution = await createWorkspaceMarker().load(
      routeDir,
      ctx({ backends: { exec: fakeExec } }),
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
    const contribution = await createWorkspaceMarker().load(routeDir, ctx())
    for (const t of contribution.tools ?? []) {
      expect((t as unknown as { overridable?: boolean }).overridable).toBe(true)
    }
  })
})
