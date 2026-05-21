import { existsSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { z } from "zod"

import { localExec, localFilesystem } from "@dawn-ai/workspace"
import type { BackendContext, ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"

import type { CapabilityMarker, DawnToolDefinition } from "../types.js"

const WORKSPACE_DIRNAME = "workspace"

const READ_FILE_INPUT = z.object({ path: z.string().min(1) })
const WRITE_FILE_INPUT = z.object({ path: z.string().min(1), content: z.string() })
const LIST_DIR_INPUT = z.object({ path: z.string().default(".") })
const RUN_BASH_INPUT = z.object({ command: z.string().min(1) })

function pathJail(userPath: string, workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot, userPath)
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(`Path is outside workspace: ${userPath}`)
  }
  return resolved
}

function backendContext(workspaceRoot: string, signal: AbortSignal): BackendContext {
  return { signal, workspaceRoot }
}

interface OverridableTool extends DawnToolDefinition {
  readonly overridable: true
}

function buildWorkspaceTools(
  workspaceRoot: string,
  fs: FilesystemBackend,
  exec: ExecBackend,
): readonly OverridableTool[] {
  const readFile: OverridableTool = {
    name: "readFile",
    description: "Read a UTF-8 file from the workspace.",
    schema: READ_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path } = READ_FILE_INPUT.parse(input)
      const safe = pathJail(path, workspaceRoot)
      return fs.readFile(safe, backendContext(workspaceRoot, ctx.signal))
    },
  }
  const writeFile: OverridableTool = {
    name: "writeFile",
    description: "Write a UTF-8 file inside the workspace.",
    schema: WRITE_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path, content } = WRITE_FILE_INPUT.parse(input)
      const safe = pathJail(path, workspaceRoot)
      const result = await fs.writeFile(safe, content, backendContext(workspaceRoot, ctx.signal))
      return `wrote ${result.bytesWritten} bytes to ${path}`
    },
  }
  const listDir: OverridableTool = {
    name: "listDir",
    description: "List entries in a workspace directory.",
    schema: LIST_DIR_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path } = LIST_DIR_INPUT.parse(input)
      const safe = pathJail(path, workspaceRoot)
      const entries = await fs.listDir(safe, backendContext(workspaceRoot, ctx.signal))
      return [...entries]
    },
  }
  const runBash: OverridableTool = {
    name: "runBash",
    description: "Run a shell command inside the workspace.",
    schema: RUN_BASH_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { command } = RUN_BASH_INPUT.parse(input)
      return exec.runCommand({ command }, backendContext(workspaceRoot, ctx.signal))
    },
  }
  return [readFile, writeFile, listDir, runBash]
}

export function createWorkspaceMarker(): CapabilityMarker {
  return {
    name: "workspace",
    detect: async (routeDir, _context) => existsSync(join(routeDir, WORKSPACE_DIRNAME)),
    load: async (routeDir, context) => {
      const workspaceRoot = join(routeDir, WORKSPACE_DIRNAME)
      if (!existsSync(workspaceRoot)) return {}
      const fs = context.backends?.filesystem ?? localFilesystem()
      const exec = context.backends?.exec ?? localExec()
      return { tools: buildWorkspaceTools(workspaceRoot, fs, exec) }
    },
  }
}
