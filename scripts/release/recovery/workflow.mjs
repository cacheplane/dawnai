import { planRecovery, verifyRecoveryObservedPhase } from "./model.mjs"
import { RECOVERY_LANES } from "./schema.mjs"
export const RECOVERY_WORKFLOW_NEEDS = Object.freeze({
  "recovery-admit": [],
  "recovery-adopt": ["recovery-admit"],
  ...Object.fromEntries(
    RECOVERY_LANES.map((lane) => [`recovery-${lane}`, ["recovery-admit", "recovery-adopt"]]),
  ),
  "recovery-evidence": [
    "recovery-admit",
    "recovery-adopt",
    ...RECOVERY_LANES.map((lane) => `recovery-${lane}`),
  ],
  "recovery-dispatch-audit": ["recovery-admit", "recovery-adopt", "recovery-evidence"],
  "recovery-audit-evidence": ["recovery-admit", "recovery-adopt", "recovery-dispatch-audit"],
  "recovery-finalize": ["recovery-admit", "recovery-adopt", "recovery-audit-evidence"],
  "recovery-publish": ["recovery-admit", "recovery-adopt", "recovery-finalize"],
})
export function planRecoveryWorkflow(observed) {
  if (!observed.facts || observed.outcome === "blocked" || observed.errors?.length)
    throw new Error("Fresh verified recovery observation required")
  const result = {
    smoke: false,
    evidence: false,
    dispatch: false,
    audit: false,
    finalize: false,
    publish: false,
  }
  if (observed.phase === "COMPLETE") {
    if (planRecovery(observed.facts).outcome !== "complete")
      throw new Error("Verified completion required")
    return result
  }
  if (observed.phase !== "NPM_COMPLETE") verifyRecoveryObservedPhase(observed.facts)
  if (observed.facts.finalization) return { ...result, finalize: true, publish: true }
  const phases = [
    "NPM_COMPLETE",
    "RECOVERY_ADOPTED",
    "VERIFICATION_COMPLETE",
    "AUDIT_PENDING",
    "AUDIT_VERIFIED",
  ]
  const index = phases.indexOf(observed.phase)
  if (index < 0) throw new Error("Unsupported observed recovery phase")
  return {
    smoke: index <= 1 && !observed.facts.verification,
    evidence: index <= 1,
    dispatch: index <= 3,
    audit: index <= 3,
    finalize: true,
    publish: true,
  }
}
export function recoveryWorkflowCondition(job) {
  const base =
    "always() && needs.recovery-admit.result == 'success' && needs.recovery-adopt.result == 'success'"
  if (job === "recovery-admit")
    return "github.ref == 'refs/heads/main' && inputs.expected_controller_sha == github.sha"
  if (job === "recovery-adopt") return "always() && needs.recovery-admit.result == 'success'"
  if (RECOVERY_LANES.some((lane) => job === `recovery-${lane}`))
    return `${base} && needs.recovery-admit.outputs.smoke == 'true'`
  if (job === "recovery-evidence")
    return `${base} && needs.recovery-admit.outputs.evidence == 'true' && (needs.recovery-admit.outputs.smoke == 'false' || (${RECOVERY_LANES.map((lane) => `needs.recovery-${lane}.result == 'success'`).join(" && ")}))`
  const stage = {
    "recovery-dispatch-audit": ["dispatch", "evidence", "recovery-evidence"],
    "recovery-audit-evidence": ["audit", "dispatch", "recovery-dispatch-audit"],
    "recovery-finalize": ["finalize", "audit", "recovery-audit-evidence"],
    "recovery-publish": ["publish", "finalize", "recovery-finalize"],
  }[job]
  if (!stage) throw new Error("Unknown recovery workflow job")
  return `${base} && needs.recovery-admit.outputs.${stage[0]} == 'true' && (needs.recovery-admit.outputs.${stage[1]} == 'false' || needs.${stage[2]}.result == 'success')`
}
export function validateRecoveryNeeds(needs) {
  if (
    !needs ||
    typeof needs !== "object" ||
    Array.isArray(needs) ||
    Object.keys(needs).sort().join(" ") !== Object.keys(RECOVERY_WORKFLOW_NEEDS).sort().join(" ")
  )
    return false
  return Object.entries(needs).every(
    ([job, value]) =>
      value &&
      [
        "success",
        ...(["recovery-admit", "recovery-adopt"].includes(job) ? [] : ["skipped"]),
      ].includes(value.result),
  )
}
