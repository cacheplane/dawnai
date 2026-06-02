import { existsSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import { suggestedCommandPattern, suggestedPathPattern } from "@dawn-ai/permissions"
import type { BackendContext, ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import { localExec, localFilesystem } from "@dawn-ai/workspace"
import { interrupt } from "@langchain/langgraph"
import { z } from "zod"

import type { CapabilityMarker, DawnToolDefinition } from "../types.js"

const WORKSPACE_DIRNAME = "workspace"

/**
 * Resolve the workspace root to a cwd-relative path. This matches the
 * AGENTS.md capability's resolution (process.cwd() + "workspace") so
 * the agent's memory and workspace tools point at the same directory.
 */
function workspaceRoot(): string {
  return join(process.cwd(), WORKSPACE_DIRNAME)
}

const READ_FILE_INPUT = z.object({ path: z.string().min(1) })
const WRITE_FILE_INPUT = z.object({ path: z.string().min(1), content: z.string() })
const LIST_DIR_INPUT = z.object({ path: z.string().default(".") })
const RUN_BASH_INPUT = z.object({ command: z.string().min(1) })

function backendContext(workspaceRoot: string, signal: AbortSignal): BackendContext {
  return { signal, workspaceRoot }
}

type GateResult = { allowed: true } | { allowed: false; reason: string }

async function gatePathOp(
  permissions: PermissionsStore | undefined,
  operation: "readFile" | "writeFile" | "listDir",
  absPath: string,
  workspaceRoot: string,
): Promise<GateResult> {
  // If permissions store is absent, allow (legacy behavior — capability used without permissions context).
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const insideWorkspace = absPath === workspaceRoot || absPath.startsWith(workspaceRoot + sep)

  // Inside workspace: always allow silently.
  if (insideWorkspace) return { allowed: true }

  // Outside workspace: consult the store.
  const decision = permissions.match(operation, absPath)
  if (decision === "allow") return { allowed: true }
  if (decision === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${absPath}` }
  }
  // decision === "unknown"
  if (permissions.mode === "non-interactive") {
    return { allowed: false, reason: `Permission denied (fail-closed): ${absPath}` }
  }
  // Interactive: emit LangGraph interrupt and await user decision.
  const result = await emitPermissionInterrupt({
    kind: "path",
    operation,
    path: absPath,
    permissions,
  })
  if (result === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${absPath}` }
  }
  return { allowed: true }
}

async function gateBashOp(
  permissions: PermissionsStore | undefined,
  command: string,
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const decision = permissions.match("bash", command)
  if (decision === "allow") return { allowed: true }
  if (decision === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${command}` }
  }
  if (permissions.mode === "non-interactive") {
    return { allowed: false, reason: `Permission denied (fail-closed): ${command}` }
  }
  const result = await emitPermissionInterrupt({
    kind: "command",
    command,
    permissions,
  })
  if (result === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${command}` }
  }
  return { allowed: true }
}

interface InterruptArgs {
  kind: "command" | "path"
  command?: string
  operation?: "readFile" | "writeFile" | "listDir"
  path?: string
  permissions: PermissionsStore
}

async function emitPermissionInterrupt(args: InterruptArgs): Promise<"allow" | "deny"> {
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command ?? "")
      : suggestedPathPattern(args.path ?? "")
  const payload = {
    interruptId,
    type: "permission-request" as const,
    kind: args.kind,
    detail:
      args.kind === "command"
        ? { command: args.command ?? "", suggestedPattern }
        : {
            operation: args.operation ?? "readFile",
            path: args.path ?? "",
            suggestedPattern,
          },
  }
  const decision = interrupt(payload) as "once" | "always" | "deny"
  if (decision === "deny") return "deny"
  if (decision === "always") {
    const tool = args.kind === "command" ? "bash" : (args.operation ?? "readFile")
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return "allow"
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
      const content = await fs.readFile(absPath, bctx)
      const rel = relative(workspaceRoot, absPath)
      if ((rel === "tool-outputs" || rel.startsWith(`tool-outputs${sep}`)) && fs.touchFile) {
        try {
          await fs.touchFile(absPath, bctx)
        } catch {
          /* touch is best-effort; never fail a read because of it */
        }
      }
      return content
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
    detect: async (_routeDir, _context) => existsSync(workspaceRoot()),
    load: async (_routeDir, context) => {
      const root = workspaceRoot()
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
