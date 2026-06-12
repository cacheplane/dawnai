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

interface InterruptArgs {
  kind: "command" | "path"
  command?: string
  operation?: PathOperation
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
