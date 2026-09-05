// Pure planning over independently verified facts. This module performs no I/O.
// `planned.after` is a prospective marker phase, only when persisted prerequisites
// already prove it. Effects have NOT occurred; run-result observed phases must be
// collected after execution. Collection plans retain the current durable phase.
// These facts are an adapter boundary, not an authorization parser for user JSON.
import { createHash } from "node:crypto"
import { RECOVERY_AUDIT_CHECKS } from "./audit-proof.mjs"
import {
  canonicalRecoveryBytes,
  metadataCheckName,
  parseRecovery,
  RECOVERY_LANES,
  RECOVERY_PHASES,
  recoveryDigest,
  snapshotRecoveryData,
} from "./schema.mjs"

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    )
  return value
}
function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}
function same(left, right, message) {
  requireThat(equal(left, right), message)
}
function inventoryHash(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(stable(value))}\n`)
    .digest("hex")
}
function sortedAssets(value) {
  return [...value].sort((a, b) =>
    a.assetName < b.assetName ? -1 : a.assetName > b.assetName ? 1 : 0,
  )
}
function wire(facts, value, kind) {
  return parseRecovery(value, { kind, candidate: facts.candidate })
}
function receipt(facts, value, reference, kind) {
  const parsed = wire(facts, value, kind)
  requireThat(
    reference && equal(Object.keys(reference).sort(), ["assetName", "id", "sha256", "size"]),
    "Persisted receipt reference required",
  )
  requireThat(
    /^recovery-v2-[A-Za-z0-9._@+-]+$/u.test(reference.assetName) &&
      /^[1-9][0-9]{0,31}$/u.test(reference.id),
    "Persisted receipt identity invalid",
  )
  same(reference.sha256, recoveryDigest(parsed), "Persisted receipt digest mismatch")
  same(
    reference.size,
    canonicalRecoveryBytes(parsed).length,
    "Persisted receipt byte size mismatch",
  )
  return parsed
}
function policy(facts, value) {
  same(value.policySha256, facts.policySha256, "Unknown or mismatching recovery policy")
}
function admitted(capability, executor, policySha256) {
  requireThat(
    capability &&
      equal(Object.keys(capability).sort(), [
        "admission",
        "controllerSha",
        "policySha256",
        "schemaVersion",
        "verifierClosureSha256",
        "workflow",
      ]),
    "Executor capability is unknown",
  )
  requireThat(
    capability.schemaVersion === 2 && capability.admission === "reviewed-main-ci",
    "Executor capability is unsupported",
  )
  same(capability.policySha256, policySha256, "Executor policy is not admitted")
  for (const field of ["controllerSha", "verifierClosureSha256", "workflow"])
    same(capability[field], executor[field], `Executor ${field} is not admitted`)
}
function registry(facts, evidence, expected) {
  requireThat(evidence?.conclusion === "success", "Complete matching npm evidence required")
  same(evidence.manifestSha256, facts.candidate.manifestSha256, "Registry manifest mismatch")
  requireThat(
    Array.isArray(expected) &&
      expected.length > 0 &&
      new Set(expected).size === expected.length &&
      equal([...expected].sort(), expected),
    "Verified manifest package inventory required",
  )
  same(
    evidence.packages.map((item) => item.name),
    expected,
    "Registry inventory differs from verified manifest",
  )
  for (const item of evidence.packages)
    requireThat(
      item.conclusion === "success" &&
        item.version === facts.candidate.version &&
        item.sourceSha === facts.candidate.candidateSha,
      "Registry candidate mismatch",
    )
}
function adoptionProof(facts) {
  const proof = facts.adoption
  requireThat(proof, "Persisted adoption proof required")
  const adoption = receipt(facts, proof.receipt, proof.ref, "recovery-adoption")
  policy(facts, adoption)
  admitted(proof.admission, adoption.executor, facts.policySha256)
  same(proof.archive, adoption.archive, "Legacy body archive was not verified")
  same(proof.baseAssets, adoption.baseAssets, "Original asset inventory changed")
  same(proof.npmEvidence, adoption.npmEvidence, "Registry proof differs from adoption")
  same(proof.manifestPackages, facts.manifestPackages, "Verified manifest inventory mismatch")
  registry(facts, proof.npmEvidence, facts.manifestPackages)
  return adoption
}
function legacyAuthority(facts) {
  requireThat(facts.legacy?.phase === "NPM_COMPLETE", "Only legacy NPM_COMPLETE can be adopted")
  same(facts.legacy.candidate, facts.candidate, "Legacy candidate mismatch")
  const authority = facts.authority
  requireThat(authority, "Reviewed adoption intent is missing")
  const intent = wire(facts, authority.intent, "recovery-adoption-intent")
  policy(facts, intent)
  same(
    intent.legacyBodySha256,
    facts.legacy.bodySha256,
    "Legacy body differs from reviewed snapshot",
  )
  same(authority.intentSha256, recoveryDigest(intent), "Authority intent digest mismatch")
  same(
    authority.reviewedControllerSha,
    facts.executor.controllerSha,
    "Authority controller mismatch",
  )
  same(
    intent.operations,
    ["adopt", "audit", "finalize", "publish", "verify"],
    "Required recovery operations are not authorized",
  )
  requireThat(
    facts.ownership?.fence === "verified-exclusive" &&
      facts.ownership.legacyWriters === "drained-and-rejected" &&
      facts.ownership.concurrencyGroup === "dawn-release-controller",
    "Exclusive legacy writer fence is unproven",
  )
  same(facts.ownership.candidate, facts.candidate, "Ownership candidate mismatch")
  same(facts.ownership.controllerSha, facts.executor.controllerSha, "Ownership executor mismatch")
  return intent
}
// Each map entry is an independently downloaded canonical UTF-8 receipt plus its
// persisted asset reference, keyed by the digest-qualified asset name.
function installationProof(facts, lane, retained, installations) {
  const subjects = new Map()
  for (const descriptor of lane.installations) {
    const observed = installations[descriptor.assetName]
    requireThat(
      observed && typeof observed.bytes === "string",
      "Independent installation bytes required",
    )
    const ref = retained.find((item) => item.assetName === descriptor.assetName)
    requireThat(ref, "Selected installation is not retained")
    same(observed.ref, ref, "Independent installation reference differs")
    same(ref.sha256, descriptor.sha256, "Installation descriptor digest differs")
    same(ref.size, descriptor.size, "Installation descriptor size differs")
    const value = receipt(facts, observed.bytes, ref, "recovery-installation")
    same(
      observed.bytes,
      canonicalRecoveryBytes(value).toString("utf8"),
      "Installation bytes are not canonical",
    )
    policy(facts, value)
    same(value.executor, lane.executor, "Installation executor differs")
    same(value.lane, lane.lane, "Installation lane differs")
    same(value.check, descriptor.check, "Installation checkpoint differs")
    same(value.resolutions.length, descriptor.count, "Installation resolution count differs")
    for (const item of value.resolutions) {
      same(
        item.subject,
        facts.manifestPackages.includes(item.name),
        "Installation subject classification differs from manifest",
      )
      if (!item.subject) continue
      const previous = subjects.get(item.name)
      requireThat(
        !previous || (previous.resolved === item.resolved && previous.integrity === item.integrity),
        "Subject identity changed between install snapshots",
      )
      if (!previous || item.installPath < previous.installPath) subjects.set(item.name, item)
    }
  }
  same(
    lane.resolutions,
    [...subjects.values()].sort((a, b) =>
      a.installPath < b.installPath ? -1 : a.installPath > b.installPath ? 1 : 0,
    ),
    "Lane subject summary differs from selected installations",
  )
}
export function requiredRecoveryDockerImages(lane) {
  return lane === "storage"
    ? ["pgvector/pgvector:pg16", "postgres:16"]
    : lane === "published-harness"
      ? ["node:22-slim"]
      : []
}
function verificationProof(facts) {
  const proof = facts.verification
  requireThat(proof, "Verification set is missing")
  const set = receipt(facts, proof.set, proof.ref, "recovery-verification-set")
  policy(facts, set)
  requireThat(set.conclusion === "success", "Five real passing lanes required")
  same(
    Object.keys(proof.lanes).sort(),
    RECOVERY_LANES,
    "Exactly five independently verified lane receipts required",
  )
  same(
    proof.provenance,
    set.provenance,
    "Independent API provenance differs from selected receipts",
  )
  requireThat(
    proof.installations &&
      typeof proof.installations === "object" &&
      !Array.isArray(proof.installations),
    "Independent installation proof map required",
  )
  const installationNames = Object.values(proof.lanes)
    .flatMap((lane) => lane.installations.map((item) => item.assetName))
    .sort()
  same(
    Object.keys(proof.installations).sort(),
    installationNames,
    "Exactly the selected independent installations required",
  )
  for (const selected of set.lanes) {
    const lane = receipt(facts, proof.lanes[selected.lane], selected.receipt, "recovery-lane")
    policy(facts, lane)
    same(lane.executor, selected.executor, "Lane executor identity mismatch")
    same(lane.lane, selected.lane, "Lane identity mismatch")
    requireThat(lane.conclusion === "success", "Failed lane cannot be adjudicated to success")
    installationProof(facts, lane, set.retainedReceipts, proof.installations)
    if (lane.lane === "metadata")
      requireThat(
        facts.manifestPackages.every((name) =>
          lane.checks.some(
            (check) =>
              check.name === metadataCheckName(`package:${name}`) && check.conclusion === "success",
          ),
        ),
        "Metadata per-manifest-package check missing",
      )
    same(
      lane.environment.dockerImages.map((image) => image.reference),
      requiredRecoveryDockerImages(lane.lane),
      "Lane Docker image inventory differs",
    )
  }
  return set
}
function dispatchProof(facts) {
  const proof = facts.audit
  requireThat(proof, "Independent audit dispatch evidence required")
  const intent = receipt(facts, proof.intent, proof.intentRef, "recovery-audit-intent")
  policy(facts, intent)
  same(intent.verificationSetSha256, facts.verification.ref.sha256, "Audit selected set mismatch")
  same(
    intent.expectedAuditorSha,
    intent.executor.controllerSha,
    "Expected auditor must pin the dispatching reviewed revision",
  )
  const adoption = facts.adoption.receipt
  const expectedAssets = sortedAssets([
    ...adoption.baseAssets,
    adoption.archive,
    ...adoption.retainedAttempts,
    facts.adoption.ref,
    ...facts.verification.set.lanes.map((item) => item.receipt),
    ...facts.verification.set.retainedReceipts,
    facts.verification.ref,
  ])
  same(intent.inventory, expectedAssets, "Audit inventory differs from accepted evidence selection")
  const dispatch = receipt(facts, proof.dispatch, proof.dispatchRef, "recovery-audit-dispatch")
  same(dispatch.intentSha256, proof.intentRef.sha256, "Dispatch intent digest mismatch")
  same(dispatch.requestId, intent.requestId, "Dispatch request correlation mismatch")
  same(dispatch.expectedAuditorSha, intent.expectedAuditorSha, "Dispatch expected auditor mismatch")
  same(dispatch.executor, intent.executor, "Dispatch executor correlation mismatch")
  requireThat(
    dispatch.runId !== facts.verification.set.executor.runId,
    "Auditor must use a separate verification run",
  )
  return { intent, dispatch }
}
function auditProof(facts) {
  const { intent, dispatch } = dispatchProof(facts)
  const proof = facts.audit
  const result = receipt(facts, proof.result, proof.resultRef, "recovery-audit-result")
  policy(facts, result)
  requireThat(result.conclusion === "success", "Independent audit failed")
  requireThat(
    RECOVERY_AUDIT_CHECKS.every((name) =>
      result.checks.some((check) => check.name === name && check.conclusion === "success"),
    ),
    "Mandatory audit checks missing",
  )
  same(result.requestId, intent.requestId, "Audit request mismatch")
  same(
    result.verificationSetSha256,
    intent.verificationSetSha256,
    "Audited verification set mismatch",
  )
  same(result.inventorySha256, inventoryHash(intent.inventory), "Audited asset inventory mismatch")
  same(result.executor.controllerSha, dispatch.expectedAuditorSha, "Unexpected auditor SHA")
  same(result.executor.runId, dispatch.runId, "Uncorrelated audit run")
  requireThat(
    result.executor.workflow !== dispatch.executor.workflow,
    "Independent audit workflow required",
  )
  same(result.executor, proof.observedExecutor, "Independent API audit executor mismatch")
  admitted(proof.admission, result.executor, facts.policySha256)
  return result
}
function finalProof(facts, proof, persisted = true) {
  adoptionProof(facts)
  verificationProof(facts)
  auditProof(facts)
  requireThat(proof, "Finalization asset is missing")
  const finalization = persisted
    ? receipt(facts, proof.receipt, proof.ref, "recovery-finalization")
    : wire(facts, proof.receipt, "recovery-finalization")
  if (persisted)
    requireThat(
      proof.ref.assetName === "recovery-v2-finalization.json",
      "Fixed finalization asset required",
    )
  policy(facts, finalization)
  same(finalization.adoption, facts.adoption.ref, "Final adoption selection mismatch")
  same(
    finalization.verificationSet,
    facts.verification.ref,
    "Final verification selection mismatch",
  )
  same(finalization.audit, facts.audit.resultRef, "Final audit selection mismatch")
  const expected = finalInventory(facts)
  same(finalization.assets, expected, "Final inventory includes unaudited or missing evidence")
  if (persisted)
    same(proof.inventory, finalization.assets, "Finalization asset inventory was not verified")
  return finalization
}
function finalInventory(facts) {
  return sortedAssets([
    ...facts.audit.intent.inventory,
    facts.audit.intentRef,
    facts.audit.dispatchRef,
    facts.audit.resultRef,
    ...(facts.auditBookkeeping ?? [])
      .map((e) => e.ref)
      .filter(
        (ref) =>
          ![facts.audit.intentRef, facts.audit.dispatchRef, facts.audit.resultRef].some(
            (selected) => selected.assetName === ref.assetName,
          ),
      ),
  ])
}
function freshProof(facts, finalization) {
  requireThat(facts.fresh, "Fresh publication observations missing")
  same(facts.fresh.candidate, facts.candidate, "Fresh candidate identity mismatch")
  same(
    facts.fresh.tag,
    {
      name: facts.candidate.tag,
      objectSha: facts.candidate.tagObjectSha,
      candidateSha: facts.candidate.candidateSha,
    },
    "Fresh annotated tag mismatch",
  )
  same(facts.fresh.registry, facts.adoption.npmEvidence, "Fresh registry verification mismatch")
  registry(facts, facts.fresh.registry, facts.manifestPackages)
  same(
    facts.fresh.assets,
    facts.finalization
      ? sortedAssets([...finalization.assets, facts.finalization.ref])
      : finalization.assets,
    "Fresh asset inventory mismatch",
  )
  requireThat(
    facts.fresh.immutableReleasePolicy === "enabled" && facts.fresh.ownership === "exclusive",
    "Immutable release policy and exclusive writer required",
  )
}
function markerProof(facts) {
  const marker = wire(facts, facts.marker, "recovery-marker")
  policy(facts, marker)
  same(marker.adoption, facts.adoption.ref, "Marker adoption selection mismatch")
  if (marker.verificationSet !== null)
    same(marker.verificationSet, facts.verification?.ref, "Marker verification selection mismatch")
  if (marker.audit !== null)
    same(
      marker.audit,
      marker.phase === "AUDIT_PENDING" ? facts.audit?.dispatchRef : facts.audit?.resultRef,
      "Marker audit selection mismatch",
    )
  if (marker.finalization !== null)
    same(marker.finalization, facts.finalization?.ref, "Marker finalization selection mismatch")
  return marker
}
function result(
  before,
  after,
  outcome,
  effects = [],
  errors = [],
  displayDrift = false,
  evidence = [],
) {
  const nextAction =
    outcome === "complete"
      ? "report"
      : errors.length
        ? "inspect"
        : effects.at(-1)?.operation === "write-marker"
          ? {
              RECOVERY_ADOPTED: "smoke",
              VERIFICATION_COMPLETE: "dispatch-audit",
              AUDIT_PENDING: "reconcile-audit",
              AUDIT_VERIFIED: "finalize",
              PUBLICATION_READY: "publish",
            }[after]
          : (effects.at(-1)?.operation ?? "reconcile-audit")
  return snapshotRecoveryData({
    before,
    after,
    outcome,
    effects,
    evidence,
    nextAction,
    errors,
    displayDrift,
  })
}
function planned(before, after, operation, target, evidence = []) {
  return result(before, after, "planned", [{ operation, target }], [], false, evidence)
}

export function planRecovery(input) {
  let before = "UNKNOWN"
  let published = false
  try {
    const facts = snapshotRecoveryData(input, 16 * 1024 * 1024)
    before = RECOVERY_PHASES.includes(facts.marker?.phase)
      ? facts.marker.phase
      : facts.marker === null && facts.legacy?.phase === "NPM_COMPLETE"
        ? "NPM_COMPLETE"
        : "UNKNOWN"
    published = facts.publication?.state === "published"
    // Completion uses immutable observations first. Mutable marker corruption,
    // lost write authority, and a deleted git intent cannot reopen ownership.
    if (published) {
      const finalization = finalProof(facts, facts.finalization)
      const publication = facts.publication
      requireThat(publication.immutable === true, "Published release is not immutable")
      same(publication.candidate, facts.candidate, "Published candidate identity mismatch")
      same(
        publication.tag,
        {
          name: facts.candidate.tag,
          objectSha: facts.candidate.tagObjectSha,
          candidateSha: facts.candidate.candidateSha,
        },
        "Published immutable tag mismatch",
      )
      same(
        publication.assets,
        sortedAssets([...finalization.assets, facts.finalization.ref]),
        "Published immutable asset inventory mismatch",
      )
      same(
        publication.finalizationSha256,
        facts.finalization.ref.sha256,
        "Published finalization digest mismatch",
      )
      let displayDrift = publication.metadata !== "matching"
      try {
        const marker = markerProof(facts)
        if (
          marker.phase !== "PUBLICATION_READY" ||
          marker.revision !== finalization.metadata.markerRevision
        )
          displayDrift = true
      } catch {
        displayDrift = true
      }
      return result(before, "COMPLETE", "complete", [], [], displayDrift, [facts.finalization.ref])
    }
    requireThat(facts.publication === null, "Unsupported publication observation")
    admitted(facts.capability, facts.executor, facts.policySha256)
    // EXISTENCE is the freeze boundary, even before the readiness marker exists.
    if (facts.finalization !== null && facts.finalization !== undefined) {
      const finalization = finalProof(facts, facts.finalization)
      same(
        facts.verification.set.executor.verifierClosureSha256,
        facts.capability.verifierClosureSha256,
        "Selected verifier implementation is not admitted",
      )
      freshProof(facts, finalization)
      const effects = []
      let observedMarker = null
      try {
        observedMarker = wire(facts, facts.marker, "recovery-marker")
      } catch {
        /* Verified finalization can reconstruct missing or corrupt display metadata. */
      }
      let ready = false
      if (observedMarker !== null) {
        const marker = markerProof(facts)
        ready =
          marker.phase === "PUBLICATION_READY" &&
          marker.revision === finalization.metadata.markerRevision
        requireThat(
          ready || marker.revision < finalization.metadata.markerRevision,
          "Finalization cannot regress or reuse a valid marker revision",
        )
      }
      if (!ready)
        effects.push({
          operation: "write-marker",
          target: "PUBLICATION_READY",
        })
      effects.push({ operation: "publish", target: facts.candidate.releaseId })
      return result(before, "PUBLICATION_READY", "planned", effects, [], false, [
        facts.finalization.ref,
      ])
    }
    if (facts.marker === null) {
      const intent = legacyAuthority(facts)
      if (facts.adoption === null) {
        registry(facts, facts.fresh?.registry, facts.manifestPackages)
        return planned(before, before, "adopt", facts.candidate.releaseId)
      }
      const adoption = adoptionProof(facts)
      same(
        adoption.authority,
        {
          intentPath: facts.authority.intentPath,
          intentSha256: facts.authority.intentSha256,
          reviewedControllerSha: adoption.executor.controllerSha,
        },
        "Adoption authority differs from reviewed intent",
      )
      same(
        adoption.archive.sha256,
        intent.legacyBodySha256,
        "Adoption archived a different legacy body",
      )
      return planned(before, "RECOVERY_ADOPTED", "write-marker", "RECOVERY_ADOPTED", [
        facts.adoption.ref,
      ])
    }
    adoptionProof(facts)
    const marker = markerProof(facts)
    requireThat(
      marker.revision < Number.MAX_SAFE_INTEGER,
      "Marker revision is exhausted; no further durable advancement is possible",
    )
    if (marker.phase === "RECOVERY_ADOPTED") {
      if (facts.verification === null)
        return planned(before, before, "smoke", facts.candidate.releaseId)
      const set = verificationProof(facts)
      same(
        set.executor.verifierClosureSha256,
        facts.capability.verifierClosureSha256,
        "Selected verifier implementation is not admitted",
      )
      return planned(before, "VERIFICATION_COMPLETE", "write-marker", "VERIFICATION_COMPLETE", [
        facts.verification.ref,
      ])
    }
    verificationProof(facts)
    same(
      facts.verification.set.executor.verifierClosureSha256,
      facts.capability.verifierClosureSha256,
      "Selected verifier implementation is not admitted",
    )
    if (marker.phase === "VERIFICATION_COMPLETE") {
      if (facts.audit === null)
        return planned(before, before, "dispatch-audit", facts.candidate.releaseId)
      dispatchProof(facts)
      return planned(before, "AUDIT_PENDING", "write-marker", "AUDIT_PENDING", [
        facts.audit.dispatchRef,
      ])
    }
    if (marker.phase === "AUDIT_PENDING") {
      dispatchProof(facts)
      if (facts.audit.result === null && facts.audit.resultRef === null)
        return result(before, before, "waiting")
      auditProof(facts)
      return planned(before, "AUDIT_VERIFIED", "write-marker", "AUDIT_VERIFIED", [
        facts.audit.resultRef,
      ])
    }
    if (marker.phase === "AUDIT_VERIFIED") {
      auditProof(facts)
      const finalization = facts.proposedFinalization
        ? finalProof(facts, facts.proposedFinalization, false)
        : { assets: finalInventory(facts) }
      if (facts.proposedFinalization)
        requireThat(
          finalization.metadata.markerRevision > marker.revision,
          "Finalization marker revision must advance monotonically",
        )
      freshProof(facts, finalization)
      return planned(before, before, "finalize", "recovery-v2-finalization.json")
    }
    throw new Error("Readiness lacks immutable finalization evidence")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid recovery facts"
    return result(
      before,
      before,
      "blocked",
      [],
      [`${published ? "Publication integrity failure: " : ""}${message}`],
    )
  }
}

// Read-only observer validation shares proof rules without granting writer eligibility.
export function verifyRecoveryObservedPhase(input) {
  const facts = snapshotRecoveryData(input, 16 * 1024 * 1024)
  adoptionProof(facts)
  const marker = markerProof(facts)
  const index = RECOVERY_PHASES.indexOf(marker.phase)
  if (index >= 1) verificationProof(facts)
  if (index >= 2) dispatchProof(facts)
  if (index >= 3) auditProof(facts)
  if (index >= 4 || facts.finalization) finalProof(facts, facts.finalization)
  return marker.phase
}
