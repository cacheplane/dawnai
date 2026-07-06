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

/** Best-effort display preview of a tool call's args. Never matched or persisted. */
function buildArgsPreview(input: unknown): string {
  try {
    const s = JSON.stringify(input)
    return s === undefined ? String(input) : s.length > 500 ? `${s.slice(0, 500)}…` : s
  } catch {
    return String(input)
  }
}

/**
 * Wrap a tool so each call passes gateToolOp first (tools.approve). A blocked
 * call returns the denial reason AS THE TOOL RESULT — deliberately a different
 * contract from the workspace gates (which throw from inside their own run):
 * a returned denial flows through the normal on_tool_end path, so stream
 * consumers and streamTransformers see a regular tool result and the model can
 * adapt, without touching error-retry handling. Generic over the tool shape so
 * DiscoveredToolDefinition (cli) and DawnToolDefinition (core) both survive
 * wrapping with their extra fields (filePath, schema, scope, …) intact.
 * The generic constraint means run's return type must accept a string (both
 * planned call sites declare `Promise<unknown> | unknown`).
 *
 * Interrupt-capable contexts only: on an "unknown" decision in interactive
 * mode the gate calls LangGraph's `interrupt()`, which throws a raw error
 * outside a running graph. All Dawn call sites wrap agent-route tools (always
 * in-graph); if you call this from outside a graph, pre-approve via
 * `permissions.allow.tool` or use non-interactive mode instead.
 */
export function wrapToolWithApproval<
  C,
  T extends {
    readonly name: string
    readonly run: (input: unknown, context: C) => Promise<unknown> | unknown
  },
>(tool: T, permissions: PermissionsStore): T {
  return {
    ...tool,
    run: async (input: unknown, context: C) => {
      const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input))
      if (!gate.allowed) return gate.reason
      return tool.run(input, context)
    },
  }
}

// Discriminated union: each kind's required fields are enforced at the call
// site, so a `kind: "tool"` call without toolName is a compile error rather
// than a silently blank interrupt payload.
type InterruptArgs =
  | { kind: "command"; command: string; permissions: PermissionsStore }
  | { kind: "path"; operation: PathOperation; path: string; permissions: PermissionsStore }
  | { kind: "tool"; toolName: string; argsPreview: string; permissions: PermissionsStore }

async function emitPermissionInterrupt(args: InterruptArgs): Promise<"allow" | "deny"> {
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command)
      : args.kind === "tool"
        ? args.toolName
        : suggestedPathPattern(args.path)
  const payload = {
    interruptId,
    type: "permission-request" as const,
    kind: args.kind,
    detail:
      args.kind === "command"
        ? { command: args.command, suggestedPattern }
        : args.kind === "tool"
          ? { toolName: args.toolName, argsPreview: args.argsPreview, suggestedPattern }
          : {
              operation: args.operation,
              path: args.path,
              suggestedPattern,
            },
  }
  const decision = interrupt(payload) as "once" | "always" | "deny"
  if (decision === "deny") return "deny"
  if (decision === "always") {
    const tool = args.kind === "command" ? "bash" : args.kind === "tool" ? "tool" : args.operation
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return "allow"
}
