import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u

// This pure evaluator accepts only an already validated/canonical historical fixture. It is
// intentionally separate from ReleaseState and can never return mutations or effect callbacks.
export function assessValidatedHistoricalFacts({ candidate, facts, run }) {
  const controllerConflicts = controllerEvidenceConflicts(facts.controllerEvidence)
  const ambiguous = facts.npmPackages.some((pkg) => ["AMBIGUOUS", "ERROR"].includes(pkg.status))
  const packageSetComplete = arraysEqual(
    facts.npmPackages.map((pkg) => pkg.name),
    facts.packageNames,
  )
  const complete =
    packageSetComplete &&
    facts.npmPackages.length > 0 &&
    facts.npmPackages.every((pkg) => historicalPackageComplete(pkg, candidate))
  const superseded =
    !complete &&
    facts.npmPackages.length > 0 &&
    facts.npmPackages.every(
      (pkg) => isReleaseVersion(pkg.latest) && compareSemver(pkg.latest, candidate.version) > 0,
    )

  if (complete)
    return assessment({
      lastProvenTransition: "LEGACY_NPM_REGISTRY_COMPLETE_UNCORRELATED",
      nextSafeTransition: `Perform a manual audit for v${candidate.version} at release run ${run.workflowRunId} attempt ${run.runAttempt}; preserve public npm evidence and do not resume managed publication.`,
      reasons: [
        `All exact ${candidate.version} npm packages have public integrity, signatures, latest tags, and publisher provenance, but no managed tarball SHA-256 correlation exists.`,
        "This pre-controller release has no managed manifest, release record, artifact attestations, or escrow evidence.",
      ],
      conflicts: controllerConflicts,
      manualRecoveryInputs: manualInputs(candidate, run),
    })
  if (superseded)
    return assessment({
      lastProvenTransition: "LEGACY_CANDIDATE_SUPERSEDED_UNCORRELATED",
      nextSafeTransition: `Retain ${candidate.version} as skipped history and audit the failed release run ${run.workflowRunId} attempt ${run.runAttempt}; do not publish or repair it.`,
      reasons: [
        `Every observed package latest tag is newer than ${candidate.version}, while exact-version 404 responses do not prove registry absence.`,
        "The failed pre-controller release has no managed manifest, release record, artifact attestations, or escrow evidence.",
      ],
      conflicts: ["exact-version-registry-absence-unproven", ...controllerConflicts],
      manualRecoveryInputs: manualInputs(candidate, run),
    })
  return assessment({
    lastProvenTransition: "LEGACY_NPM_REGISTRY_INCOMPLETE",
    nextSafeTransition: `Collect and independently audit exact npm evidence for v${candidate.version}; do not invoke managed publication.`,
    reasons: [
      "Public npm facts are missing, ambiguous, or do not exactly correlate to the historical candidate.",
      "Pre-controller facts cannot establish managed release completion.",
    ],
    conflicts: [
      ...(!packageSetComplete ? ["historical-npm-package-set-mismatch"] : []),
      ...(ambiguous ? ["historical-npm-package-ambiguous"] : ["historical-npm-package-incomplete"]),
      ...nestedConflicts(facts.npmPackages, candidate),
      ...controllerConflicts,
    ],
    manualRecoveryInputs: manualInputs(candidate, run),
  })
}

function assessment({
  lastProvenTransition,
  nextSafeTransition,
  reasons,
  conflicts,
  manualRecoveryInputs,
}) {
  return deepFreeze({
    analysisKind: "historical-audit",
    disposition: "audit-only",
    lastProvenTransition,
    nextSafeTransition,
    reasons,
    conflicts: [...new Set(conflicts)].sort(compareText),
    manualRecoveryInputs,
    proposedMutations: [],
  })
}
function historicalPackageComplete(pkg, candidate) {
  return (
    pkg.status === "PRESENT" &&
    pkg.code === null &&
    pkg.version === candidate.version &&
    typeof pkg.shasum === "string" &&
    SHA1_PATTERN.test(pkg.shasum) &&
    typeof pkg.integrity === "string" &&
    INTEGRITY_PATTERN.test(pkg.integrity) &&
    pkg.latest === candidate.version &&
    Number.isSafeInteger(pkg.signatureCount) &&
    pkg.signatureCount > 0 &&
    pkg.provenanceStatus === "PRESENT" &&
    pkg.provenanceWorkflow === candidate.publisherWorkflow &&
    pkg.provenanceCommitSha === candidate.commitSha
  )
}
function nestedConflicts(packages, candidate) {
  const conflicts = new Set()
  for (const pkg of packages) {
    if (pkg.status !== "PRESENT") continue
    if (pkg.latest !== candidate.version) conflicts.add("historical-npm-latest-incomplete")
    if (!Number.isSafeInteger(pkg.signatureCount) || pkg.signatureCount <= 0)
      conflicts.add("historical-npm-signature-unverified")
    if (pkg.provenanceStatus !== "PRESENT") conflicts.add("historical-npm-provenance-incomplete")
    else if (
      pkg.provenanceWorkflow !== candidate.publisherWorkflow ||
      pkg.provenanceCommitSha !== candidate.commitSha
    )
      conflicts.add("historical-npm-provenance-mismatch")
  }
  return [...conflicts].sort(compareText)
}
function controllerEvidenceConflicts(value) {
  const names = {
    artifactAttestations: "managed-artifact-attestations-unavailable",
    escrow: "managed-escrow-unavailable",
    manifest: "managed-manifest-unavailable",
    releaseRecord: "managed-release-record-unavailable",
  }
  return Object.keys(names)
    .filter((key) => value[key] === "unavailable")
    .map((key) => names[key])
    .sort(compareText)
}
function manualInputs(candidate, run) {
  return {
    version: candidate.version,
    commitSha: candidate.commitSha,
    tag: `v${candidate.version}`,
    workflowRunId: run.workflowRunId,
    runAttempt: run.runAttempt,
  }
}
function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}
function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
