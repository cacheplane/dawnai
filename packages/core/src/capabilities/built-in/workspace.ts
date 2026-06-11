import { existsSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { BackendContext, ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import { localExec, localFilesystem } from "@dawn-ai/workspace"
import { z } from "zod"

import { gateBashOp, gatePathOp } from "../permission-gate.js"
import type { CapabilityMarker, DawnToolDefinition } from "../types.js"

const WORKSPACE_DIRNAME = "workspace"

/**
 * Resolve the workspace root relative to the given app root. In production
 * (`dawn dev`) appRoot === process.cwd(), so this is a no-op change there.
 * In-process testing harnesses pass the explicit app root so capabilities
 * activate regardless of the test runner's working directory.
 */
function workspaceRoot(appRoot: string): string {
  return join(appRoot, WORKSPACE_DIRNAME)
}

const READ_FILE_INPUT = z.object({ path: z.string().min(1) })
const WRITE_FILE_INPUT = z.object({ path: z.string().min(1), content: z.string() })
const LIST_DIR_INPUT = z.object({ path: z.string().default(".") })
const RUN_BASH_INPUT = z.object({ command: z.string().min(1) })

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
  permissions: PermissionsStore | undefined,
): readonly OverridableTool[] {
  const readFile: OverridableTool = {
    name: "readFile",
    description: "Read a UTF-8 file from the workspace.",
    schema: READ_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path } = READ_FILE_INPUT.parse(input)
      const absPath = resolve(workspaceRoot, path)
      const gate = await gatePathOp(permissions, "readFile", absPath, workspaceRoot)
      if (!gate.allowed) {
        throw new Error(gate.reason)
      }
      const bctx = backendContext(workspaceRoot, ctx.signal)
      const rel = relative(workspaceRoot, absPath)
      // NOTE: must match SUBDIR ("tool-outputs") in @dawn-ai/langchain offload-store.ts
      const isToolOutput = rel === "tool-outputs" || rel.startsWith(`tool-outputs${sep}`)
      const data = await fs.readFile(
        absPath,
        bctx,
        isToolOutput ? { maxBytes: Number.POSITIVE_INFINITY } : undefined,
      )
      if (isToolOutput && fs.touchFile) {
        try {
          await fs.touchFile(absPath, bctx)
        } catch {
          /* touch is best-effort; never fail a read because of it */
        }
      }
      return data
    },
  }
  const writeFile: OverridableTool = {
    name: "writeFile",
    description: "Write a UTF-8 file inside the workspace.",
    schema: WRITE_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path, content } = WRITE_FILE_INPUT.parse(input)
      const absPath = resolve(workspaceRoot, path)
      const gate = await gatePathOp(permissions, "writeFile", absPath, workspaceRoot)
      if (!gate.allowed) {
        throw new Error(gate.reason)
      }
      const result = await fs.writeFile(absPath, content, backendContext(workspaceRoot, ctx.signal))
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
      const absPath = resolve(workspaceRoot, path)
      const gate = await gatePathOp(permissions, "listDir", absPath, workspaceRoot)
      if (!gate.allowed) {
        throw new Error(gate.reason)
      }
      const entries = await fs.listDir(absPath, backendContext(workspaceRoot, ctx.signal))
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
      const gate = await gateBashOp(permissions, command)
      if (!gate.allowed) {
        throw new Error(gate.reason)
      }
      return exec.runCommand({ command }, backendContext(workspaceRoot, ctx.signal))
    },
  }
  return [readFile, writeFile, listDir, runBash]
}

export function createWorkspaceMarker(): CapabilityMarker {
  return {
    name: "workspace",
    detect: async (_routeDir, context) => existsSync(workspaceRoot(context.appRoot)),
    load: async (_routeDir, context) => {
      const root = workspaceRoot(context.appRoot)
      if (!existsSync(root)) return {}
      const fs = context.backends?.filesystem ?? localFilesystem()
      const exec = context.backends?.exec ?? localExec()
      const permissions = context.permissions

      if (permissions?.mode === "bypass") {
        console.warn(
          "[dawn:permissions] mode=bypass — path-jail disabled, all bash unrestricted. Do not use in production.",
        )
      }

      return { tools: buildWorkspaceTools(root, fs, exec, permissions) }
    },
  }
}
