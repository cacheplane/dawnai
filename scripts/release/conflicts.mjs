import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const TRUSTED_PUBLISHER_WORKFLOW = ".github/workflows/release.yml"
const ABANDONABLE_STATES = new Set([
  "CANDIDATE_TAGGED",
  "ARTIFACTS_PREPARED",
  "ARTIFACTS_ATTESTED",
  "CANDIDATE_ESCROWED",
])

export function findPolicyConflicts(candidate, observation, evidence, state, progressRank) {
  const conflicts = new Set(evidence.conflicts)
  if (observation.inventory?.status !== "valid") conflicts.add("release-inventory-invalid")
  if (observation.inventory?.packages?.some((pkg) => pkg.version !== candidate.version) === true) {
    conflicts.add("fixed-group-version-mismatch")
  }
  if (candidate.publisherWorkflow !== TRUSTED_PUBLISHER_WORKFLOW) {
    conflicts.add("publisher-workflow-untrusted")
  }
  addCiConflicts(conflicts, candidate, observation)
  addArbitrationConflicts(conflicts, candidate, observation, state, progressRank)
  addIdentityConflicts(conflicts, candidate, observation)
  addProgressionConflicts(conflicts, observation, evidence)
  addAbandonmentConflicts(conflicts, observation, evidence, state)
  if (state === "AUDIT_COMPLETE" && evidence.npm.latestNewer) {
    conflicts.delete("npm-package-latest-version-mismatch")
    conflicts.delete("release-metadata-reconciled-before-npm-complete")
  }
  return [...conflicts].sort()
}

function addCiConflicts(conflicts, candidate, observation) {
  const ci = observation.ci ?? {}
  if (ci.status === "ambiguous") conflicts.add("candidate-ci-ambiguous")
  else if (ci.status === "missing") conflicts.add("candidate-ci-missing")
  else if (ci.status === "failed") conflicts.add("candidate-ci-failed")
  else if (ci.status !== "success") conflicts.add("candidate-ci-invalid")
  if (ci.commitSha !== candidate.commitSha) conflicts.add("candidate-ci-commit-mismatch")
}

function addArbitrationConflicts(conflicts, candidate, observation, state, progressRank) {
  for (const other of observation.otherCandidates ?? []) {
    if (!isExactSemver(other.version)) {
      conflicts.add("competing-version-invalid")
      continue
    }
    if (parseSemver(other.version).build.length > 0) {
      conflicts.add("competing-version-build-metadata")
      continue
    }
    if (typeof other.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(other.commitSha)) {
      conflicts.add("competing-candidate-commit-invalid")
      continue
    }
    if (!Object.hasOwn(progressRank, other.state)) {
      conflicts.add("competing-candidate-state-invalid")
      continue
    }
    const comparison = compareSemver(other.version, candidate.version)
    if (comparison === 0 && other.commitSha !== candidate.commitSha) {
      conflicts.add("candidate-version-sha-conflict")
    }
    if (
      comparison < 0 &&
      (progressRank[other.state] ?? -1) >= progressRank.CANDIDATE_TAGGED &&
      !["AUDIT_COMPLETE", "ABANDONED_PREPUBLICATION"].includes(other.state)
    ) {
      conflicts.add("older-tagged-candidate-incomplete")
    }
    if (
      comparison > 0 &&
      observation.abandonment?.requested &&
      !observation.abandonment?.recorded &&
      (progressRank[other.state] ?? -1) >= progressRank.CANDIDATE_TAGGED
    ) {
      conflicts.add("abandonment-newer-public-state")
    }
  }
  if (
    !observation.abandonment?.recorded &&
    evidenceHasNewerLatest(observation, candidate) &&
    state !== "AUDIT_COMPLETE" &&
    !isUnstarted(observation)
  ) {
    conflicts.add("newer-registry-version-interleaved")
  }
}

function addIdentityConflicts(conflicts, candidate, observation) {
  const tag = observation.tag ?? {}
  if (tag.status === "ambiguous") conflicts.add("candidate-tag-ambiguous")
  if (tag.status === "present" && tag.commitSha !== candidate.commitSha) {
    conflicts.add("candidate-tag-commit-mismatch")
  }
  if (observation.release?.status === "ambiguous") conflicts.add("github-release-ambiguous")
}

function addProgressionConflicts(conflicts, observation, evidence) {
  const artifactsActive = ["prepared", "attested"].includes(observation.artifacts?.status)
  const escrowPresent = observation.escrow?.status === "present"
  const releaseExists = evidence.assets.releaseExists
  const advancedBeyondTag =
    artifactsActive ||
    escrowPresent ||
    evidence.npm.started ||
    releaseExists ||
    evidence.smokes.anyPassed ||
    evidence.audit.active
  if (advancedBeyondTag && observation.tag?.status !== "present") {
    conflicts.add("candidate-tag-prerequisite-missing")
  }
  if (escrowPresent && !evidence.artifact.attested) conflicts.add("escrow-before-attestation")
  if (escrowPresent && !evidence.assets.escrowComplete) conflicts.add("escrow-draft-incomplete")
  if (evidence.npm.started && !evidence.artifact.attested) {
    conflicts.add("npm-before-artifacts-attested")
  }
  if (evidence.npm.started && !evidence.assets.escrowComplete) conflicts.add("npm-before-escrow")
  if (observation.release?.metadataReconciled === true && !evidence.npm.complete) {
    conflicts.add("release-metadata-reconciled-before-npm-complete")
  }
  if (evidence.smokes.anyPassed && !evidence.assets.metadataComplete) {
    conflicts.add("smoke-before-release-draft")
  }
  if (observation.release?.status === "published" && !evidence.smokes.complete) {
    conflicts.add("github-release-published-before-smokes")
  }
  if (evidence.audit.active && observation.release?.status !== "published") {
    conflicts.add("audit-before-release-published")
  }
}

function addAbandonmentConflicts(conflicts, observation, evidence, state) {
  const abandonment = observation.abandonment ?? {}
  if (!abandonment.requested && !abandonment.recorded) return
  if (abandonment.recorded && !abandonment.requested) {
    conflicts.add("abandonment-recorded-without-request")
  }
  const underlyingState = abandonment.recorded
    ? classifyUnderlyingState(observation, evidence)
    : state
  if (!ABANDONABLE_STATES.has(underlyingState)) {
    conflicts.add("abandonment-not-permitted-from-state")
  }
  if (observation.registry?.publishJobStarted || observation.registry?.mutationStarted) {
    conflicts.add("abandonment-after-publish-started")
  }
  if (evidence.npm.presentCount > 0) {
    conflicts.add("abandonment-after-package-visible")
    if (abandonment.recorded) conflicts.add("abandoned-candidate-visible-on-npm")
  }
  if (hasAmbiguity(observation, evidence)) conflicts.add("abandonment-with-ambiguity")
  if (!abandonment.recorded && evidence.npm.latestNewer) {
    conflicts.add("abandonment-newer-public-state")
  }
}

function classifyUnderlyingState(observation, evidence) {
  if (evidence.assets.draftExact) return "CANDIDATE_ESCROWED"
  if (evidence.artifact.attested) return "ARTIFACTS_ATTESTED"
  if (evidence.artifact.prepared) return "ARTIFACTS_PREPARED"
  if (observation.tag?.status === "present") return "CANDIDATE_TAGGED"
  return "CANDIDATE_VALIDATED"
}

function hasAmbiguity(observation, evidence) {
  return (
    observation.ci?.status === "ambiguous" ||
    observation.tag?.status === "ambiguous" ||
    observation.artifacts?.status === "ambiguous" ||
    observation.artifacts?.files?.some((file) => file.status === "ambiguous") ||
    observation.escrow?.status === "ambiguous" ||
    evidence.npm.ambiguous ||
    observation.release?.status === "ambiguous" ||
    observation.release?.assets?.some((asset) => asset.status === "ambiguous") ||
    evidence.smokes.ambiguous ||
    evidence.audit.ambiguous
  )
}

function evidenceHasNewerLatest(observation, candidate) {
  return (observation.registry?.packages ?? []).some(
    (pkg) =>
      pkg.latest?.status === "present" &&
      isExactSemver(pkg.latest.version) &&
      compareSemver(pkg.latest.version, candidate.version) > 0,
  )
}

function isUnstarted(observation) {
  return (
    observation.tag?.status === "absent" &&
    observation.artifacts?.status === "absent" &&
    observation.escrow?.status === "absent" &&
    !observation.registry?.publishJobStarted &&
    !observation.registry?.mutationStarted &&
    (observation.registry?.packages ?? []).every((pkg) => pkg.status !== "present") &&
    observation.release?.status === "absent" &&
    observation.audit?.status === "none" &&
    !observation.abandonment?.recorded
  )
}
