import { sep } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import { suggestedCommandPattern, suggestedPathPattern } from "@dawn-ai/permissions"
import { interrupt } from "@langchain/langgraph"

export type PathOperation = "readFile" | "writeFile" | "listDir"

export type GateResult = { allowed: true } | { allowed: false; reason: string }

export async function gatePathOp(
  permissions: PermissionsStore | undefined,
  operation: PathOperation,
  absPath: string,
  workspaceRoot: string,
  opts?: { readonly interruptCapable?: boolean },
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
  if (opts?.interruptCapable === false) {
    return {
      allowed: false,
      reason:
        `Permission denied: ${absPath} is outside the workspace and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "${operation}" to the permissions config in dawn.config.ts.`,
    }
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

export async function gateBashOp(
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

/**
 * Generic per-tool approval gate (tools.approve). Name-level: the decision
 * covers the tool name; argsPreview is display-only. Persisted decisions live
 * under the reserved "tool" key in .dawn/permissions.json (exact-name match —
 * see @dawn-ai/permissions pattern-matching).
 */
export async function gateToolOp(
  permissions: PermissionsStore | undefined,
  toolName: string,
  argsPreview: string,
  opts?: { readonly interruptCapable?: boolean },
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const decision = permissions.match("tool", toolName)
  if (decision === "allow") return { allowed: true }
  if (decision === "deny") {
    return { allowed: false, reason: `Permission denied by user: tool ${toolName}` }
  }
  if (permissions.mode === "non-interactive") {
    return { allowed: false, reason: `Permission denied (fail-closed): tool ${toolName}` }
  }
  if (opts?.interruptCapable === false) {
    return {
      allowed: false,
      reason:
        `Permission denied: tool "${toolName}" requires approval and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "tool" to the permissions config in dawn.config.ts.`,
    }
  }
  const result = await emitPermissionInterrupt({
    kind: "tool",
    toolName,
    argsPreview,
    permissions,
  })
  if (result === "deny") {
    return { allowed: false, reason: `Permission denied by user: tool ${toolName}` }
  }
  return { allowed: true }
}

interface InterruptArgs {
  kind: "command" | "path" | "tool"
  command?: string
  operation?: PathOperation
  path?: string
  toolName?: string
  argsPreview?: string
  permissions: PermissionsStore
}

async function emitPermissionInterrupt(args: InterruptArgs): Promise<"allow" | "deny"> {
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command ?? "")
      : args.kind === "tool"
        ? (args.toolName ?? "")
        : suggestedPathPattern(args.path ?? "")
  const payload = {
    interruptId,
    type: "permission-request" as const,
    kind: args.kind,
    detail:
      args.kind === "command"
        ? { command: args.command ?? "", suggestedPattern }
        : args.kind === "tool"
          ? { toolName: args.toolName ?? "", argsPreview: args.argsPreview ?? "", suggestedPattern }
          : {
              operation: args.operation ?? "readFile",
              path: args.path ?? "",
              suggestedPattern,
            },
  }
  const decision = interrupt(payload) as "once" | "always" | "deny"
  if (decision === "deny") return "deny"
  if (decision === "always") {
    const tool =
      args.kind === "command"
        ? "bash"
        : args.kind === "tool"
          ? "tool"
          : (args.operation ?? "readFile")
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return "allow"
}
