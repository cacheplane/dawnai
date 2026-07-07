import { sep } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import {
  suggestedCommandPattern,
  suggestedMemoryPattern,
  suggestedPathPattern,
} from "@dawn-ai/permissions"
import type { ConstraintContext, ConstraintPredicate } from "@dawn-ai/sdk"
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

export interface MemorySupersedeDetail {
  readonly namespace: string
  readonly identity: string
  readonly oldId: string
  readonly oldContent: string
  readonly newContent: string
}

/**
 * Memory supersede gate (memory.writes: "ask"). Prompts ONLY when the agent
 * contradicts an existing active memory — ADDs and idempotent UPDATEs never
 * reach this gate. Persisted decisions live under the reserved "memory" key
 * as workspace+route namespace prefixes; candidates are matched with a "|"
 * terminator so sibling routes cannot prefix-collide.
 *
 * DELIBERATE DIVERGENCE from gateToolOp: on "unknown" with no interactive
 * human (non-interactive mode), this gate ALLOWS the supersede — ask is a
 * supervision affordance, not a security boundary; headless it behaves
 * exactly as writes:"auto". Explicit deny rules are still honored headless.
 * Only called from inside the memory capability's remember tool, which only
 * exists on agent routes (in-graph), so interrupt() is safe here.
 */
export async function gateMemorySupersede(
  permissions: PermissionsStore | undefined,
  detail: MemorySupersedeDetail,
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const decision = permissions.match("memory", `${detail.namespace}|`)
  if (decision === "allow") return { allowed: true }
  if (decision === "deny") {
    return { allowed: false, reason: `approval denied for this route's memory overwrites` }
  }
  // unknown + headless → allow through (ask ≡ auto without a human).
  if (permissions.mode === "non-interactive") return { allowed: true }

  const result = await emitPermissionInterrupt({
    kind: "memory",
    ...detail,
    permissions,
  })
  if (result === "deny") {
    return { allowed: false, reason: `approval denied` }
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
 * On an "unknown" decision in interactive mode the gate calls LangGraph's
 * `interrupt()`, which throws a raw error outside a running graph. Dawn's own
 * call sites wrap agent-route tools (always in-graph); out-of-graph callers
 * should pass `interruptCapable: false` to fail closed with actionable
 * guidance instead (mirrors gatePathOp's option).
 */
export function wrapToolWithApproval<
  C,
  T extends {
    readonly name: string
    readonly run: (input: unknown, context: C) => Promise<unknown> | unknown
  },
>(tool: T, permissions: PermissionsStore, opts?: { readonly interruptCapable?: boolean }): T {
  return {
    ...tool,
    run: async (input: unknown, context: C) => {
      const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input), opts)
      if (!gate.allowed) return gate.reason
      return tool.run(input, context)
    },
  }
}

const CONSTRAINT_FAILED_REASON =
  "Blocked: the tool's argument constraint check failed (the policy predicate threw). Not run."

/**
 * Wrap a tool so each call is first evaluated by an argument-constraint predicate
 * (tools.constrain). The predicate returns `true` (allow), a string (deny — the
 * string is returned as the tool result, matching wrapToolWithApproval's
 * return-not-throw contract), or `{ approve: true }` (escalate to the HITL gate
 * via gateToolOp). A predicate that THROWS fails closed (deny) — a broken policy
 * never silently allows. Per-call identity (signal/threadId/params) is read from
 * the LIVE run context, never closed over, so the wrapper is safe inside the
 * per-descriptor-cached agent. `routeId` and `predicate` are stable per descriptor
 * and closed over.
 */
export function wrapToolWithConstraint<
  C extends {
    readonly signal: AbortSignal
    readonly threadId?: string
    readonly params?: Readonly<Record<string, string>>
  },
  T extends {
    readonly name: string
    readonly run: (input: unknown, context: C) => Promise<unknown> | unknown
  },
>(
  tool: T,
  predicate: ConstraintPredicate,
  permissions: PermissionsStore | undefined,
  routeId: string,
): T {
  return {
    ...tool,
    run: async (input: unknown, context: C) => {
      const ctx: ConstraintContext = {
        toolName: tool.name,
        routeId,
        signal: context.signal,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        ...(context.params ? { params: context.params } : {}),
      }
      let verdict: Awaited<ReturnType<ConstraintPredicate>>
      try {
        verdict = await predicate(input, ctx)
      } catch {
        return CONSTRAINT_FAILED_REASON
      }
      if (verdict === true) return tool.run(input, context)
      if (typeof verdict === "string") return verdict
      // verdict is { approve: true, reason? } — escalate to the HITL gate.
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
  | {
      kind: "memory"
      namespace: string
      identity: string
      oldId: string
      oldContent: string
      newContent: string
      permissions: PermissionsStore
    }

async function emitPermissionInterrupt(args: InterruptArgs): Promise<"allow" | "deny"> {
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command)
      : args.kind === "tool"
        ? args.toolName
        : args.kind === "memory"
          ? suggestedMemoryPattern(args.namespace)
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
          : args.kind === "memory"
            ? {
                namespace: args.namespace,
                identity: args.identity,
                oldId: args.oldId,
                oldContent: args.oldContent,
                newContent: args.newContent,
                suggestedPattern,
              }
            : { operation: args.operation, path: args.path, suggestedPattern },
  }
  const decision = interrupt(payload) as "once" | "always" | "deny"
  if (decision === "deny") return "deny"
  if (decision === "always") {
    const tool =
      args.kind === "command"
        ? "bash"
        : args.kind === "tool"
          ? "tool"
          : args.kind === "memory"
            ? "memory"
            : args.operation
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return "allow"
}
