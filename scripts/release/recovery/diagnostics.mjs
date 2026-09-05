import { auditHasFailed } from "./audit-proof.mjs"
import { renderRecoveryFinalMetadata } from "./metadata.mjs"
import { planRecoveryWorkflow } from "./workflow.mjs"

// Keep bounded boundary detail without transport bodies, stacks, or credential values.
export function recoveryFailureDetail(error, environment = {}) {
  try {
    let value = typeof error?.message === "string" ? error.message : "Operation failed"
    value = value.slice(0, 8192).replace(/\S+$/u, (match) => (value.length > 8192 ? "" : match))
    for (const [key, secret] of Object.entries(environment))
      if (
        /TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE_KEY/iu.test(key) &&
        typeof secret === "string" &&
        secret.length > 0
      )
        value = value.split(secret).join("[redacted]")
    value = Array.from(value, (character) =>
      character.codePointAt(0) < 32 ||
      (character.codePointAt(0) >= 127 && character.codePointAt(0) <= 159)
        ? " "
        : character,
    )
      .join("")
      .replace(/https?:\/\/\S+/gu, "[URL redacted]")
      .replace(/bearer\s+\S+/giu, "Bearer [redacted]")
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]+)\b/gu,
        "[redacted]",
      )
      .replace(
        /(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,
        "[redacted]",
      )
      .replace(/\s+/gu, " ")
      .trim()
    // HTTP/registry response payloads are not useful boundary diagnostics.
    if (/[{}<>]/u.test(value)) return "Operation failed; untrusted response detail omitted"
    return value.slice(0, 512) || "Operation failed"
  } catch {
    return "Operation failed; unsafe diagnostic omitted"
  }
}

// A current observation proves selected evidence, never the sequence of past writes.
export function recoveryDiagnosticContext(request, result) {
  const context = {
    requestedCandidate: request?.candidate ?? null,
    controllerSha: request?.expectedControllerSha ?? null,
    intentPath: request?.intentPath ?? null,
    startingDurablePhase: null,
    endingDurablePhase: null,
    completedMutations: null,
    historyStatus: "unavailable",
    historyExplanation:
      "Starting phase and mutation telemetry are unavailable to this diagnostic; workflow results are not evidence of completed mutations.",
    observationStatus:
      result?.outcome === "blocked" || result?.status === "blocked" ? "blocked" : "unavailable",
    selectedReceiptLocations: null,
    nextAction: "inspect",
  }
  if (
    result?.kind === "recovery-inspection" &&
    result.originalPayload?.legacyPhase === "NPM_COMPLETE"
  ) {
    context.observationStatus = "original-payload-verified"
    context.endingDurablePhase = "NPM_COMPLETE"
    context.intentPath = result.reservation?.intentPath ?? context.intentPath
    context.nextAction = result.status === "unreserved" ? "review-adoption-proposal" : "inspect"
    return context
  }
  if (!result?.facts || result.outcome === "blocked") return context
  try {
    const plan = planRecoveryWorkflow(result)
    context.observationStatus = "verified"
    context.endingDurablePhase = result.phase
    const facts = result.facts
    context.selectedReceiptLocations = [
      ["adoption", facts.adoption?.ref],
      ["verification-set", facts.verification?.ref],
      ["audit-intent", facts.audit?.intentRef],
      ["audit-dispatch", facts.audit?.dispatchRef],
      ["audit-result", facts.audit?.resultRef],
      ["finalization", facts.finalization?.ref],
    ]
      .filter(([, ref]) => ref)
      .map(([role, ref]) => ({
        role,
        ...ref,
        releaseId: facts.candidate.releaseId,
        url: `https://api.github.com/repos/${facts.candidate.repository}/releases/assets/${ref.id}`,
      }))
    const finalMetadata = facts.finalization
      ? renderRecoveryFinalMetadata(facts.finalization.receipt, facts.finalization.ref)
      : null
    context.nextAction =
      result.phase === "COMPLETE"
        ? "report"
        : facts.finalization
          ? result.phase === "PUBLICATION_READY" &&
            facts.release?.name === finalMetadata.title &&
            facts.release?.body === finalMetadata.body
            ? "publish"
            : "finalize"
          : result.phase === "NPM_COMPLETE"
            ? "adopt"
            : plan.smoke
              ? "smoke"
              : plan.evidence
                ? "reconcile-verification"
                : result.phase === "VERIFICATION_COMPLETE" ||
                    (result.phase === "AUDIT_PENDING" && auditHasFailed(facts))
                  ? "dispatch-audit"
                  : plan.audit
                    ? "reconcile-audit"
                    : "finalize"
  } catch {
    context.observationStatus = "blocked"
    context.endingDurablePhase = null
    context.selectedReceiptLocations = null
    context.nextAction = "inspect"
  }
  return context
}
