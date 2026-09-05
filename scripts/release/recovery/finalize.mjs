// Dormant orchestration. All reads and effects share one guarded writer invocation.
import { createHash } from "node:crypto"
import { renderRecoveryFinalMetadata, renderRecoveryReleaseBody } from "./metadata.mjs"
import { withRecoveryPayloadReuse } from "./payload-reuse.mjs"
import { canonicalRecoveryBytes, parseRecovery, snapshotRecoveryData } from "./schema.mjs"
import { createRecoveryWriter } from "./writer.mjs"

const FINALIZATION = "recovery-v2-finalization.json"
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
function requestData(request) {
  request = snapshotRecoveryData(request, 16384)
  if (Object.keys(request).sort().join(" ") !== "candidate expectedControllerSha intentPath")
    throw new TypeError("Exact recovery finalization request required")
  return request
}
function common(request, current) {
  return { ...request, expectedBodySha256: hash(current.facts.release.body) }
}

export async function finalizeRecoveryCandidate(request, config, dependencies) {
  return withRecoveryPayloadReuse(dependencies, (scoped) =>
    finalizeRecoveryCandidateInInvocation(request, config, scoped),
  )
}
async function finalizeRecoveryCandidateInInvocation(request, config, dependencies) {
  request = requestData(request)
  const writer = createRecoveryWriter(config, dependencies)
  let current = await writer.inspectRecoveryCandidate(request)
  if (current.terminal) return current
  if (!current.facts.finalization) {
    if (current.phase !== "AUDIT_VERIFIED")
      throw new Error("Successful independent audit required before finalization")
    const facts = current.facts
    const delimiter = "\n\n<!-- DAWN_RELEASE_CONTROLLER_MARKER\n"
    const start = facts.release.body.indexOf(delimiter)
    const body = facts.release.body.slice(0, start)
    if (
      start < 0 ||
      renderRecoveryReleaseBody({ marker: facts.marker, body }) !== facts.release.body
    )
      throw new Error("Canonical semantic release metadata required before finalization")
    const receipt = parseRecovery({
      schemaVersion: 2,
      kind: "recovery-finalization",
      candidate: request.candidate,
      policySha256: facts.policySha256,
      adoption: facts.adoption.ref,
      verificationSet: facts.verification.ref,
      audit: facts.audit.resultRef,
      assets: facts.assets,
      metadata: {
        title: facts.release.name,
        body,
        markerRevision: facts.marker.revision + 1,
      },
    })
    await writer.uploadRecoveryAsset({
      ...common(request, current),
      name: FINALIZATION,
      contentBase64: canonicalRecoveryBytes(receipt).toString("base64"),
    })
    // Re-read the fixed asset and its complete chain before rendering its persisted ID.
    current = await writer.inspectRecoveryCandidate(request)
  }
  const finalization = current.facts.finalization
  const rendered = renderRecoveryFinalMetadata(finalization.receipt, finalization.ref)
  return writer.updateRecoveryDraft({ ...common(request, current), ...rendered })
}

export async function publishRecoveryCandidate(request, config, dependencies) {
  return withRecoveryPayloadReuse(dependencies, (scoped) =>
    publishRecoveryCandidateInInvocation(request, config, scoped),
  )
}
async function publishRecoveryCandidateInInvocation(request, config, dependencies) {
  request = requestData(request)
  const writer = createRecoveryWriter(config, dependencies)
  const current = await writer.inspectRecoveryCandidate(request)
  if (current.terminal) return current
  return writer.publishRecoveryDraft(common(request, current))
}
