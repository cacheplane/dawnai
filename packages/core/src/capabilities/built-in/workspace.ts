// `relative`/`resolve`/`sep` still come from node:path: they implement the
// tool-outputs containment predicate below, which shares the path-jail
// semantics of workspace-fs.ts/permission-gate.ts and moves to the pure
// helpers together with them (an absolute second operand must WIN, so a
// join-shaped swap here would be a jail escape).
import { relative, resolve, sep } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import { pureJoin } from "@dawn-ai/sdk/pure"
import type { BackendContext, ExecBackend, FilesystemBackend } from "@dawn-ai/workspace"
import { z } from "zod"

import { gateBashOp } from "../permission-gate.js"
import type { CapabilityMarker, DawnToolDefinition } from "../types.js"
import { createWorkspaceFs } from "../workspace-fs.js"

const WORKSPACE_DIRNAME = "workspace"

/**
 * Resolve the workspace root relative to the given app root. In production
 * (`dawn dev`) appRoot === process.cwd(), so this is a no-op change there.
 * In-process testing harnesses pass the explicit app root so capabilities
 * activate regardless of the test runner's working directory.
 */
function workspaceRoot(appRoot: string): string {
  return pureJoin(appRoot, WORKSPACE_DIRNAME)
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

/**
 * Backend resolution, deferred to the first tool invocation that needs it:
 * an already-constructed instance wins, then the runtime's factory, then a
 * loud failure. Deferring keeps `load` working on runtimes that contribute the
 * tools but never call them, and keeps the failure attached to the operation
 * that actually needed a backend.
 */
function backendResolver<T>(
  instance: T | undefined,
  factory: (() => T) | undefined,
  what: string,
): () => T {
  let resolved: T | undefined = instance
  return () => {
    if (resolved === undefined) {
      if (!factory) {
        throw new Error(
          `workspace ${what} backend: no instance provided and this runtime has no ${what} fallback — pass one via context.backendFactories (see the edge deployment docs).`,
        )
      }
      resolved = factory()
    }
    return resolved
  }
}

function buildWorkspaceTools(
  workspaceRoot: string,
  resolveFs: () => FilesystemBackend,
  resolveExec: () => ExecBackend,
  permissions: PermissionsStore | undefined,
): readonly OverridableTool[] {
  // Agent tools run inside the graph, so the handle may surface the
  // interactive LangGraph permission interrupt.
  function handleFor(signal: AbortSignal) {
    return createWorkspaceFs({
      workspaceRoot,
      backend: resolveFs(),
      permissions,
      signal,
      interruptCapable: true,
    })
  }
  const readFile: OverridableTool = {
    name: "readFile",
    description: "Read a UTF-8 file from the workspace.",
    schema: READ_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path } = READ_FILE_INPUT.parse(input)
      const handle = handleFor(ctx.signal)
      const absPath = resolve(workspaceRoot, path)
      const rel = relative(workspaceRoot, absPath)
      // NOTE: must match SUBDIR ("tool-outputs") in @dawn-ai/langchain offload-store.ts
      const isToolOutput = rel === "tool-outputs" || rel.startsWith(`tool-outputs${sep}`)
      const data = await handle.readFile(
        path,
        isToolOutput ? { maxBytes: Number.POSITIVE_INFINITY } : undefined,
      )
      const fs = resolveFs()
      if (isToolOutput && fs.touchFile) {
        try {
          await fs.touchFile(absPath, backendContext(workspaceRoot, ctx.signal))
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
      const result = await handleFor(ctx.signal).writeFile(path, content)
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
      return [...(await handleFor(ctx.signal).listDir(path))]
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
      return resolveExec().runCommand({ command }, backendContext(workspaceRoot, ctx.signal))
    },
  }
  return [readFile, writeFile, listDir, runBash]
}

export function createWorkspaceMarker(): CapabilityMarker {
  return {
    name: "workspace",
    detect: async (_routeDir, context) =>
      context.workspaceRoot !== undefined ||
      (context.markerFs?.existsSync(workspaceRoot(context.appRoot)) ?? false),
    load: async (_routeDir, context) => {
      const root = context.workspaceRoot ?? workspaceRoot(context.appRoot)
      if (context.workspaceRoot === undefined && !(context.markerFs?.existsSync(root) ?? false))
        return {}
      const resolveFs = backendResolver(
        context.backends?.filesystem,
        context.backendFactories?.filesystem,
        "filesystem",
      )
      const resolveExec = backendResolver(
        context.backends?.exec,
        context.backendFactories?.exec,
        "exec",
      )
      const permissions = context.permissions

      if (permissions?.mode === "bypass") {
        console.warn(
          "[dawn:permissions] mode=bypass — path-jail disabled, all bash unrestricted. Do not use in production.",
        )
      }

      return { tools: buildWorkspaceTools(root, resolveFs, resolveExec, permissions) }
    },
  }
}
