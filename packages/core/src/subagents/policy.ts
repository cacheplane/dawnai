import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DelegationContext } from "@dawn-ai/sdk"

import { gateSubagentOp } from "../capabilities/permission-gate.js"
import type { ResolvedSubagent } from "./types.js"

const CONSTRAINT_FAILED_REASON =
  "Subagent delegation constraint check failed. The subagent was not started."
const ABORTED_REASON = "Subagent delegation was cancelled."

export type GuardedSubagentResult<T> =
  | { readonly ok: true; readonly entry: ResolvedSubagent; readonly value: T }
  | {
      readonly ok: false
      readonly code: "DAWN_E3002" | "DAWN_E5003"
      readonly message: string
    }

export interface ResolveGuardedSubagentArgs<T> {
  readonly callId: string
  readonly input: string
  readonly name: string
  readonly registry: readonly ResolvedSubagent[]
  readonly runtime: Omit<DelegationContext, "subagentName" | "subagentRouteId">
  readonly permissions?: PermissionsStore
  readonly interruptCapable: boolean
  readonly resolve: (entry: ResolvedSubagent) => Promise<T>
}

function denied(reason: string): GuardedSubagentResult<never> {
  return { ok: false, code: "DAWN_E3002", message: `[DAWN_E3002] ${reason}` }
}

function unavailable(reason: string): GuardedSubagentResult<never> {
  return { ok: false, code: "DAWN_E5003", message: `[DAWN_E5003] ${reason}` }
}

type ApprovalVerdictValidation =
  | { readonly approved: true; readonly reason?: string }
  | { readonly approved: false; readonly detail: unknown }

function validateApprovalVerdict(verdict: unknown): ApprovalVerdictValidation {
  try {
    if (typeof verdict !== "object" || verdict === null) {
      return { approved: false, detail: verdict }
    }
    const prototype = Object.getPrototypeOf(verdict)
    if (prototype !== Object.prototype && prototype !== null) {
      return { approved: false, detail: verdict }
    }
    if (!Object.hasOwn(verdict, "approve")) return { approved: false, detail: verdict }
    if (Reflect.get(verdict, "approve") !== true) return { approved: false, detail: verdict }
    if (!Object.hasOwn(verdict, "reason")) return { approved: true }

    const reason = Reflect.get(verdict, "reason")
    return typeof reason === "string"
      ? { approved: true, reason }
      : { approved: false, detail: verdict }
  } catch (error) {
    return { approved: false, detail: error }
  }
}

function debugConstraintFailure(
  parentRouteId: string,
  subagentName: string,
  detail: unknown,
): void {
  if (process.env.DAWN_DEBUG_CONSTRAINTS !== "1") return
  try {
    console.warn(
      `[dawn:constraints] parent ${parentRouteId} subagent ${subagentName} constraint failed:`,
      detail,
    )
  } catch {
    // Diagnostics must never weaken the fail-closed policy boundary.
  }
}

async function gateApproval<T>(
  args: ResolveGuardedSubagentArgs<T>,
  entry: ResolvedSubagent,
  reason?: string,
): Promise<GuardedSubagentResult<never> | undefined> {
  const gate = await gateSubagentOp(
    args.permissions,
    {
      callId: args.callId,
      input: args.input,
      parentRouteId: args.runtime.parentRouteId,
      ...(reason !== undefined ? { reason } : {}),
      subagentName: entry.name,
      subagentRouteId: entry.routeId,
      ...(args.runtime.threadId !== undefined ? { threadId: args.runtime.threadId } : {}),
    },
    { interruptCapable: args.interruptCapable },
  )
  if (args.runtime.signal.aborted) return denied(ABORTED_REASON)
  if (!gate.allowed) return denied(gate.reason)
  return undefined
}

export async function resolveGuardedSubagent<T>(
  args: ResolveGuardedSubagentArgs<T>,
): Promise<GuardedSubagentResult<T>> {
  if (args.runtime.signal.aborted) return denied(ABORTED_REASON)

  const entry = args.registry.find((candidate) => candidate.name === args.name)
  if (!entry) return unavailable(`No subagent named '${args.name}' is available.`)

  if (entry.rule.action === "deny") {
    return denied(entry.rule.reason ?? `Delegation to subagent '${entry.name}' is denied.`)
  }

  if (entry.rule.action === "approve") {
    const blocked = await gateApproval(args, entry, entry.rule.reason)
    if (blocked) return blocked
  }

  if (entry.rule.action === "constrain") {
    const context: DelegationContext = {
      parentRouteId: args.runtime.parentRouteId,
      subagentName: entry.name,
      subagentRouteId: entry.routeId,
      signal: args.runtime.signal,
      ...(args.runtime.threadId !== undefined ? { threadId: args.runtime.threadId } : {}),
      ...(args.runtime.params !== undefined ? { params: args.runtime.params } : {}),
    }
    let verdict: unknown
    try {
      verdict = await entry.rule.predicate({ input: args.input }, context)
    } catch (error) {
      debugConstraintFailure(args.runtime.parentRouteId, entry.name, error)
      return denied(CONSTRAINT_FAILED_REASON)
    }
    if (args.runtime.signal.aborted) return denied(ABORTED_REASON)

    if (verdict === true) {
      // Continue to resolution below.
    } else if (typeof verdict === "string") {
      return denied(verdict)
    } else {
      const approval = validateApprovalVerdict(verdict)
      if (approval.approved) {
        const blocked = await gateApproval(args, entry, approval.reason)
        if (blocked) return blocked
      } else {
        debugConstraintFailure(args.runtime.parentRouteId, entry.name, approval.detail)
        return denied(CONSTRAINT_FAILED_REASON)
      }
    }
  }

  if (args.runtime.signal.aborted) return denied(ABORTED_REASON)

  try {
    const value = await args.resolve(entry)
    return { ok: true, entry, value }
  } catch {
    return unavailable(`Subagent '${entry.name}' could not be started.`)
  }
}
