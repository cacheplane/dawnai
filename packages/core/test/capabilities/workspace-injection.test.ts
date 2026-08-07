import type { ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import { describe, expect, it, vi } from "vitest"

import { createWorkspaceMarker } from "../../src/capabilities/built-in/workspace.js"
import type { CapabilityMarkerContext, DawnToolDefinition } from "../../src/capabilities/types.js"

/**
 * No `markerFs` and an explicit `workspaceRoot` — the edge/sandbox shape, where
 * nothing may touch the host disk. `load` must still contribute the tools; the
 * backend resolution happens when a tool RUNS.
 */
function ctx(extras: Partial<CapabilityMarkerContext> = {}): CapabilityMarkerContext {
  return {
    routeManifest: { appRoot: "/app", routes: [] },
    descriptor: undefined,
    appRoot: "/app",
    workspaceRoot: "/workspace",
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

function fakeFilesystem(): FilesystemBackend & { readonly readFile: ReturnType<typeof vi.fn> } {
  return {
    readFile: vi.fn().mockResolvedValue("injected"),
    writeFile: vi.fn().mockResolvedValue({ bytesWritten: 0 }),
    listDir: vi.fn().mockResolvedValue([]),
    realPath: async (p: string) => p,
  }
}

function fakeExec(): ExecBackend & { readonly runCommand: ReturnType<typeof vi.fn> } {
  return {
    runCommand: vi.fn().mockResolvedValue({ stdout: "ran", stderr: "", exitCode: 0 }),
  }
}

const signal = () => ({ signal: new AbortController().signal })

describe("workspace marker — backend injection", () => {
  it("throws a named error when no filesystem backend is available", async () => {
    const contribution = await createWorkspaceMarker().load("/route", ctx())
    await expect(
      findTool(contribution.tools, "readFile").run({ path: "notes.txt" }, signal()),
    ).rejects.toThrow(
      /workspace filesystem backend: no instance provided and this runtime has no filesystem fallback/i,
    )
  })

  it("throws a named error when no exec backend is available", async () => {
    const contribution = await createWorkspaceMarker().load("/route", ctx())
    await expect(
      findTool(contribution.tools, "runBash").run({ command: "echo hi" }, signal()),
    ).rejects.toThrow(
      /workspace exec backend: no instance provided and this runtime has no exec fallback/i,
    )
  })

  it("still contributes all four tools with neither backends nor factories", async () => {
    const contribution = await createWorkspaceMarker().load("/route", ctx())
    expect((contribution.tools ?? []).map((t) => t.name).sort()).toEqual([
      "listDir",
      "readFile",
      "runBash",
      "writeFile",
    ])
  })

  it("uses an injected filesystem factory, calling it once per contribution", async () => {
    const backend = fakeFilesystem()
    const filesystem = vi.fn(() => backend)
    const contribution = await createWorkspaceMarker().load(
      "/route",
      ctx({ backendFactories: { filesystem } }),
    )
    expect(filesystem).not.toHaveBeenCalled()

    const readFile = findTool(contribution.tools, "readFile")
    expect(await readFile.run({ path: "notes.txt" }, signal())).toBe("injected")
    expect(await readFile.run({ path: "notes.txt" }, signal())).toBe("injected")

    expect(filesystem).toHaveBeenCalledTimes(1)
    expect(backend.readFile.mock.calls[0]?.[0]).toBe("/workspace/notes.txt")
  })

  it("uses an injected exec factory", async () => {
    const backend = fakeExec()
    const exec = vi.fn(() => backend)
    const contribution = await createWorkspaceMarker().load(
      "/route",
      ctx({ backendFactories: { exec } }),
    )
    const result = await findTool(contribution.tools, "runBash").run(
      { command: "echo hi" },
      signal(),
    )
    expect(result).toMatchObject({ stdout: "ran", exitCode: 0 })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(backend.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo hi" }),
      expect.objectContaining({ workspaceRoot: "/workspace" }),
    )
  })

  it("prefers an already-constructed context.backends instance over the factory", async () => {
    const instance = fakeFilesystem()
    const unused = fakeFilesystem()
    const filesystem = vi.fn(() => unused)
    const contribution = await createWorkspaceMarker().load(
      "/route",
      ctx({ backends: { filesystem: instance }, backendFactories: { filesystem } }),
    )
    await findTool(contribution.tools, "readFile").run({ path: "notes.txt" }, signal())
    expect(filesystem).not.toHaveBeenCalled()
    expect(instance.readFile).toHaveBeenCalledOnce()
  })

  it("prefers an already-constructed exec instance over the exec factory", async () => {
    const instance = fakeExec()
    const exec = vi.fn(() => fakeExec())
    const contribution = await createWorkspaceMarker().load(
      "/route",
      ctx({ backends: { exec: instance }, backendFactories: { exec } }),
    )
    await findTool(contribution.tools, "runBash").run({ command: "echo hi" }, signal())
    expect(exec).not.toHaveBeenCalled()
    expect(instance.runCommand).toHaveBeenCalledOnce()
  })
})
