import { compareSemver, isExactSemver } from "./semver.mjs"

export const ReleaseState = Object.freeze({
  NO_CANDIDATE: "NO_CANDIDATE",
  SUPERSEDED_NOOP: "SUPERSEDED_NOOP",
  CANDIDATE_VALIDATED: "CANDIDATE_VALIDATED",
  CANDIDATE_TAGGED: "CANDIDATE_TAGGED",
  ARTIFACTS_PREPARED: "ARTIFACTS_PREPARED",
  ARTIFACTS_ATTESTED: "ARTIFACTS_ATTESTED",
  CANDIDATE_ESCROWED: "CANDIDATE_ESCROWED",
  NPM_PARTIAL: "NPM_PARTIAL",
  NPM_COMPLETE: "NPM_COMPLETE",
  RELEASE_DRAFT_COMPLETE: "RELEASE_DRAFT_COMPLETE",
  SMOKES_COMPLETE: "SMOKES_COMPLETE",
  RELEASE_PUBLISHED: "RELEASE_PUBLISHED",
  AUDIT_DISPATCHED: "AUDIT_DISPATCHED",
  AUDIT_COMPLETE: "AUDIT_COMPLETE",
  ABANDONED_PREPUBLICATION: "ABANDONED_PREPUBLICATION",
})

export const TERMINAL_RELEASE_STATES = Object.freeze([
  ReleaseState.NO_CANDIDATE,
  ReleaseState.SUPERSEDED_NOOP,
  ReleaseState.AUDIT_COMPLETE,
  ReleaseState.ABANDONED_PREPUBLICATION,
])

const RELEASE_STATES = Object.freeze(Object.values(ReleaseState))
const STATE_INDEX = new Map(RELEASE_STATES.map((state, index) => [state, index]))
const ROOT_FIELDS = [
  "inventory",
  "ci",
  "otherCandidates",
  "tag",
  "artifacts",
  "escrow",
  "registry",
  "release",
  "requiredSmokeLanes",
  "smokes",
  "audit",
  "abandonment",
]
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

export function classifyObservedRelease(candidate, observation) {
  const snapshot = snapshotRelease(candidate, observation)
  return classifySnapshot(snapshot.candidate, snapshot.observation)
}

export function findReleaseConflicts(candidate, observation) {
  const snapshot = snapshotRelease(candidate, observation)
  if (snapshot.candidate === null) {
    return []
  }
  return findSnapshotConflicts(snapshot.candidate, snapshot.observation)
}

function classifySnapshot(candidate, observation) {
  if (candidate === null) {
    return ReleaseState.NO_CANDIDATE
  }
  if (observation.abandonment.recorded) {
    return ReleaseState.ABANDONED_PREPUBLICATION
  }
  if (observation.audit.status === "complete") {
    return ReleaseState.AUDIT_COMPLETE
  }
  if (observation.audit.status === "dispatched") {
    return ReleaseState.AUDIT_DISPATCHED
  }
  if (observation.release.status === "published") {
    return ReleaseState.RELEASE_PUBLISHED
  }
  if (observation.release.status === "draft" && requiredSmokesAreComplete(candidate, observation)) {
    return ReleaseState.SMOKES_COMPLETE
  }
  if (observation.release.status === "draft") {
    return ReleaseState.RELEASE_DRAFT_COMPLETE
  }

  const presentPackages = observation.registry.packages.filter(
    (packageObservation) => packageObservation.status === "present",
  )
  if (
    presentPackages.length === observation.inventory.packages.length &&
    observation.inventory.packages.length > 0
  ) {
    return ReleaseState.NPM_COMPLETE
  }
  if (
    presentPackages.length > 0 ||
    observation.registry.publishJobStarted ||
    observation.registry.mutationStarted
  ) {
    return ReleaseState.NPM_PARTIAL
  }
  if (observation.escrow.status === "present") {
    return ReleaseState.CANDIDATE_ESCROWED
  }
  if (observation.artifacts.status === "attested") {
    return ReleaseState.ARTIFACTS_ATTESTED
  }
  if (observation.artifacts.status === "prepared") {
    return ReleaseState.ARTIFACTS_PREPARED
  }
  if (observation.tag.status === "present") {
    return ReleaseState.CANDIDATE_TAGGED
  }
  if (
    observation.registry.latest.status === "present" &&
    compareSemver(observation.registry.latest.version, candidate.version) > 0 &&
    isUnstarted(observation)
  ) {
    return ReleaseState.SUPERSEDED_NOOP
  }
  return ReleaseState.CANDIDATE_VALIDATED
}

function findSnapshotConflicts(candidate, observation) {
  const conflicts = new Set()
  const state = classifySnapshot(candidate, observation)
  const packageByName = new Map(observation.inventory.packages.map((pkg) => [pkg.name, pkg]))
  const presentPackages = observation.registry.packages.filter((pkg) => pkg.status === "present")
  const allPackagesPresent =
    presentPackages.length === observation.inventory.packages.length &&
    observation.inventory.packages.length > 0

  if (observation.inventory.status !== "valid") {
    conflicts.add("release-inventory-invalid")
  }
  if (observation.inventory.packages.some((pkg) => pkg.version !== candidate.version)) {
    conflicts.add("fixed-group-version-mismatch")
  }

  if (observation.ci.status === "ambiguous") {
    conflicts.add("candidate-ci-ambiguous")
  } else if (observation.ci.status === "missing") {
    conflicts.add("candidate-ci-missing")
  } else if (observation.ci.status === "failed") {
    conflicts.add("candidate-ci-failed")
  } else if (observation.ci.commitSha !== candidate.commitSha) {
    conflicts.add("candidate-ci-commit-mismatch")
  }

  for (const other of observation.otherCandidates) {
    const comparison = compareSemver(other.version, candidate.version)
    if (
      comparison < 0 &&
      stateAtLeast(other.state, ReleaseState.CANDIDATE_TAGGED) &&
      ![ReleaseState.AUDIT_COMPLETE, ReleaseState.ABANDONED_PREPUBLICATION].includes(other.state)
    ) {
      conflicts.add("older-tagged-candidate-incomplete")
    }
    if (
      comparison > 0 &&
      observation.abandonment.requested &&
      !observation.abandonment.recorded &&
      stateAtLeast(other.state, ReleaseState.CANDIDATE_TAGGED)
    ) {
      conflicts.add("abandonment-newer-public-state")
    }
  }

  if (observation.tag.status === "ambiguous") {
    conflicts.add("candidate-tag-ambiguous")
  } else if (
    observation.tag.status === "present" &&
    observation.tag.commitSha !== candidate.commitSha
  ) {
    conflicts.add("candidate-tag-commit-mismatch")
  }

  if (observation.artifacts.status === "ambiguous") {
    conflicts.add("artifacts-ambiguous")
  }
  if (["prepared", "attested"].includes(observation.artifacts.status)) {
    if (observation.artifacts.manifestVersion !== candidate.version) {
      conflicts.add("artifact-manifest-version-mismatch")
    }
    if (observation.artifacts.manifestCommitSha !== candidate.commitSha) {
      conflicts.add("artifact-manifest-commit-mismatch")
    }
    if (observation.artifacts.manifestSha256 === null) {
      conflicts.add("artifacts-manifest-digest-missing")
    }
    for (const artifact of observation.artifacts.files) {
      if (["missing", "corrupt", "unmanifested"].includes(artifact.status)) {
        conflicts.add(`artifact-${artifact.status}`)
      } else if (artifact.status === "ambiguous") {
        conflicts.add("artifact-ambiguous")
      } else if (artifact.status === "pending") {
        conflicts.add("artifact-pending-after-preparation")
      }
    }
  }
  if (
    observation.artifacts.status === "absent" &&
    observation.artifacts.files.some((artifact) => artifact.status !== "pending")
  ) {
    conflicts.add("artifact-observation-contradiction")
  }

  if (observation.escrow.status === "ambiguous") {
    conflicts.add("candidate-escrow-ambiguous")
  } else if (observation.escrow.status === "present") {
    if (observation.escrow.manifestSha256 === null) {
      conflicts.add("escrow-manifest-digest-missing")
    } else if (observation.escrow.manifestSha256 !== observation.artifacts.manifestSha256) {
      conflicts.add("escrow-manifest-digest-mismatch")
    }
  }

  if (observation.registry.latest.status === "ambiguous") {
    conflicts.add("registry-latest-ambiguous")
  }
  for (const packageObservation of observation.registry.packages) {
    if (packageObservation.status === "ambiguous") {
      conflicts.add("registry-package-ambiguous")
      continue
    }
    if (packageObservation.status !== "present") {
      continue
    }
    const expected = packageByName.get(packageObservation.name)
    if (packageObservation.version !== candidate.version) {
      conflicts.add("npm-version-mismatch")
    }
    if (packageObservation.integrity !== expected.integrity) {
      conflicts.add("npm-bytes-mismatch")
    }
    if (packageObservation.provenance?.workflow !== observation.ci.workflow) {
      conflicts.add("npm-provenance-workflow-mismatch")
    }
    if (packageObservation.provenance?.commitSha !== candidate.commitSha) {
      conflicts.add("npm-provenance-commitSha-mismatch")
    }
  }
  if (
    !observation.abandonment.recorded &&
    observation.registry.latest.status === "present" &&
    compareSemver(observation.registry.latest.version, candidate.version) > 0 &&
    ![ReleaseState.AUDIT_COMPLETE, ReleaseState.ABANDONED_PREPUBLICATION].includes(state) &&
    !isUnstarted(observation)
  ) {
    conflicts.add("newer-registry-version-interleaved")
  }
  if (
    observation.registry.latest.status === "present" &&
    observation.registry.latest.version === candidate.version &&
    presentPackages.length === 0
  ) {
    conflicts.add("registry-latest-without-package")
  }

  if (observation.release.status === "ambiguous") {
    conflicts.add("github-release-ambiguous")
  }
  if (observation.release.status !== "absent" && observation.release.status !== "ambiguous") {
    if (observation.release.tag !== `v${candidate.version}`) {
      conflicts.add("github-release-tag-mismatch")
    }
    if (observation.release.commitSha !== candidate.commitSha) {
      conflicts.add("github-release-commit-mismatch")
    }
  }
  for (const asset of observation.release.assets) {
    if (asset.status === "different") {
      conflicts.add("github-asset-bytes-mismatch")
    } else if (asset.status === "ambiguous") {
      conflicts.add("github-asset-ambiguous")
    }
  }

  const requiredSmokeAnalysis = analyzeRequiredSmokes(candidate, observation)
  const requiredSmokes = requiredSmokeAnalysis.results
  for (const conflict of requiredSmokeAnalysis.conflicts) {
    conflicts.add(conflict)
  }
  for (const smoke of requiredSmokes) {
    if (smoke.version !== candidate.version) {
      conflicts.add("required-smoke-version-mismatch")
    }
    if (smoke.status === "missing" || smoke.status === "failed") {
      conflicts.add(`required-smoke-${smoke.status}`)
    } else if (smoke.status === "ambiguous") {
      conflicts.add("required-smoke-ambiguous")
    }
  }

  if (observation.audit.status === "ambiguous") {
    conflicts.add("release-audit-ambiguous")
  }

  addProgressionConflicts(conflicts, observation, {
    allPackagesPresent,
    presentPackages,
    requiredSmokes,
    requiredSmokesComplete: requiredSmokeAnalysis.complete,
  })
  addAbandonmentConflicts(conflicts, candidate, observation, state, presentPackages)

  return [...conflicts].sort()
}

function addProgressionConflicts(
  conflicts,
  observation,
  { allPackagesPresent, presentPackages, requiredSmokes, requiredSmokesComplete },
) {
  const releaseExists = ["draft", "published"].includes(observation.release.status)
  const publishStarted =
    observation.registry.publishJobStarted ||
    observation.registry.mutationStarted ||
    presentPackages.length > 0
  const advancedBeyondTag =
    ["prepared", "attested"].includes(observation.artifacts.status) ||
    observation.escrow.status === "present" ||
    publishStarted ||
    releaseExists ||
    requiredSmokes.some((smoke) => smoke.status === "passed") ||
    ["dispatched", "complete"].includes(observation.audit.status)

  if (advancedBeyondTag && observation.tag.status !== "present") {
    conflicts.add("candidate-tag-prerequisite-missing")
  }
  if (observation.escrow.status === "present" && observation.artifacts.status !== "attested") {
    conflicts.add("escrow-before-attestation")
  }
  if (publishStarted && observation.artifacts.status !== "attested") {
    conflicts.add("npm-before-artifacts-attested")
  }
  if (publishStarted && observation.escrow.status !== "present") {
    conflicts.add("npm-before-escrow")
  }
  if (releaseExists && !allPackagesPresent) {
    conflicts.add("github-release-before-npm-complete")
  }
  if (releaseExists && observation.release.assets.some((asset) => asset.status === "absent")) {
    conflicts.add("github-required-asset-absent")
  }
  if (requiredSmokes.some((smoke) => smoke.status === "passed") && !releaseExists) {
    conflicts.add("smoke-before-release-draft")
  }
  if (observation.release.status === "published" && !requiredSmokesComplete) {
    conflicts.add("github-release-published-before-smokes")
  }
  if (
    ["dispatched", "complete"].includes(observation.audit.status) &&
    observation.release.status !== "published"
  ) {
    conflicts.add("audit-before-release-published")
  }
}

function analyzeRequiredSmokes(candidate, observation) {
  const conflicts = []
  const lanes = observation.requiredSmokeLanes
  if (lanes === undefined) {
    return {
      complete: false,
      conflicts: ["required-smoke-lanes-missing"],
      results: [],
    }
  }
  if (lanes.length === 0) {
    conflicts.push("required-smoke-lanes-empty")
  }
  if (new Set(lanes).size !== lanes.length) {
    conflicts.push("required-smoke-lane-duplicate")
  }
  if (!arraysEqual(lanes, [...lanes].sort(compareNames))) {
    conflicts.push("required-smoke-lanes-nondeterministic")
  }

  const laneSet = new Set(lanes)
  const resultsByName = new Map()
  for (const smoke of observation.smokes) {
    const results = resultsByName.get(smoke.name) ?? []
    results.push(smoke)
    resultsByName.set(smoke.name, results)
    if (!laneSet.has(smoke.name)) {
      conflicts.push("required-smoke-result-unexpected")
    }
  }
  for (const lane of laneSet) {
    const results = resultsByName.get(lane) ?? []
    if (results.length === 0) {
      conflicts.push("required-smoke-result-missing")
    } else if (results.length > 1) {
      conflicts.push("required-smoke-result-duplicate")
    }
  }

  const results = observation.smokes.filter((smoke) => laneSet.has(smoke.name))
  for (const smoke of results) {
    if (smoke.commitSha !== candidate.commitSha) {
      conflicts.push("required-smoke-commit-mismatch")
    }
    if (smoke.manifestSha256 !== observation.artifacts.manifestSha256) {
      conflicts.push("required-smoke-manifest-mismatch")
    }
    if (
      smoke.workflowRunId !== null &&
      (!Number.isSafeInteger(smoke.workflowRunId) || smoke.workflowRunId <= 0)
    ) {
      conflicts.push("required-smoke-workflow-run-id-invalid")
    }
    if (
      smoke.runAttempt !== null &&
      (!Number.isSafeInteger(smoke.runAttempt) || smoke.runAttempt <= 0)
    ) {
      conflicts.push("required-smoke-run-attempt-invalid")
    }
    if (smoke.status === "passed") {
      if (!Number.isSafeInteger(smoke.workflowRunId) || smoke.workflowRunId <= 0) {
        conflicts.push("required-smoke-workflow-run-id-invalid")
      }
      if (!Number.isSafeInteger(smoke.runAttempt) || smoke.runAttempt <= 0) {
        conflicts.push("required-smoke-run-attempt-invalid")
      }
    }
  }
  const complete =
    conflicts.length === 0 &&
    lanes.length > 0 &&
    lanes.every((lane) => {
      const laneResults = resultsByName.get(lane)
      return (
        laneResults.length === 1 &&
        laneResults[0].status === "passed" &&
        laneResults[0].version === candidate.version &&
        laneResults[0].commitSha === candidate.commitSha &&
        laneResults[0].manifestSha256 === observation.artifacts.manifestSha256 &&
        observation.artifacts.manifestSha256 !== null &&
        laneResults[0].workflowRunId > 0 &&
        laneResults[0].runAttempt > 0
      )
    })
  return { complete, conflicts, results }
}

function requiredSmokesAreComplete(candidate, observation) {
  return analyzeRequiredSmokes(candidate, observation).complete
}

function addAbandonmentConflicts(conflicts, candidate, observation, state, presentPackages) {
  if (!observation.abandonment.requested && !observation.abandonment.recorded) {
    return
  }
  if (observation.abandonment.recorded && !observation.abandonment.requested) {
    conflicts.add("abandonment-recorded-without-request")
  }

  const stateBeforeAbandonment = observation.abandonment.recorded
    ? classifySnapshot(candidate, {
        ...observation,
        abandonment: { requested: false, recorded: false },
      })
    : state
  const permitted = [
    ReleaseState.CANDIDATE_TAGGED,
    ReleaseState.ARTIFACTS_PREPARED,
    ReleaseState.ARTIFACTS_ATTESTED,
    ReleaseState.CANDIDATE_ESCROWED,
  ]
  if (!permitted.includes(stateBeforeAbandonment)) {
    conflicts.add("abandonment-not-permitted-from-state")
  }
  if (observation.registry.publishJobStarted || observation.registry.mutationStarted) {
    conflicts.add("abandonment-after-publish-started")
  }
  if (presentPackages.length > 0) {
    conflicts.add("abandonment-after-package-visible")
    if (observation.abandonment.recorded) {
      conflicts.add("abandoned-candidate-visible-on-npm")
    }
  }
  if (hasAmbiguity(observation)) {
    conflicts.add("abandonment-with-ambiguity")
  }
  if (
    !observation.abandonment.recorded &&
    observation.registry.latest.status === "present" &&
    compareSemver(observation.registry.latest.version, candidate.version) > 0
  ) {
    conflicts.add("abandonment-newer-public-state")
  }
}

function hasAmbiguity(observation) {
  return (
    observation.ci.status === "ambiguous" ||
    observation.tag.status === "ambiguous" ||
    observation.artifacts.status === "ambiguous" ||
    observation.artifacts.files.some((file) => file.status === "ambiguous") ||
    observation.escrow.status === "ambiguous" ||
    observation.registry.latest.status === "ambiguous" ||
    observation.registry.packages.some((pkg) => pkg.status === "ambiguous") ||
    observation.release.status === "ambiguous" ||
    observation.release.assets.some((asset) => asset.status === "ambiguous") ||
    observation.smokes.some((smoke) => smoke.status === "ambiguous") ||
    observation.audit.status === "ambiguous"
  )
}

function isUnstarted(observation) {
  return (
    observation.tag.status === "absent" &&
    observation.artifacts.status === "absent" &&
    observation.escrow.status === "absent" &&
    !observation.registry.publishJobStarted &&
    !observation.registry.mutationStarted &&
    observation.registry.packages.every((pkg) => pkg.status !== "present") &&
    observation.release.status === "absent" &&
    observation.audit.status === "none" &&
    !observation.abandonment.recorded
  )
}

function stateAtLeast(state, minimum) {
  return STATE_INDEX.get(state) >= STATE_INDEX.get(minimum)
}

function snapshotRelease(candidate, observation) {
  assertJsonValue(candidate, "candidate")
  assertJsonValue(observation, "observation")
  const snapshot = structuredClone({ candidate, observation })
  validateCandidate(snapshot.candidate)
  validateObservation(snapshot.observation)
  return snapshot
}

function validateCandidate(candidate) {
  if (candidate === null) {
    return
  }
  assertObject(candidate, "candidate")
  assertExactFields(candidate, ["version", "commitSha"], "candidate")
  if (!isExactSemver(candidate.version)) {
    throw new TypeError("candidate.version must be an exact SemVer")
  }
  assertSha(candidate.commitSha, "candidate.commitSha")
}

function validateObservation(observation) {
  assertObject(observation, "observation")
  assertExactFields(observation, ROOT_FIELDS, "observation", ["requiredSmokeLanes"])

  assertObject(observation.inventory, "observation.inventory")
  assertExactFields(observation.inventory, ["status", "packages"], "observation.inventory")
  assertOneOf(observation.inventory.status, ["valid", "invalid"], "inventory.status")
  assertNonEmptyArray(observation.inventory.packages, "inventory.packages")
  const packageNames = new Set()
  for (const pkg of observation.inventory.packages) {
    assertObject(pkg, "inventory package")
    assertExactFields(pkg, ["name", "version", "integrity"], "inventory package")
    assertNonEmptyString(pkg.name, "inventory package name")
    if (packageNames.has(pkg.name)) {
      throw new TypeError(`inventory contains duplicate package ${pkg.name}`)
    }
    packageNames.add(pkg.name)
    if (!isExactSemver(pkg.version)) {
      throw new TypeError(`${pkg.name} inventory version must be an exact SemVer`)
    }
    assertNonEmptyString(pkg.integrity, `${pkg.name} inventory integrity`)
  }

  assertObject(observation.ci, "observation.ci")
  assertExactFields(observation.ci, ["status", "workflow", "commitSha"], "observation.ci")
  assertOneOf(observation.ci.status, ["missing", "failed", "success", "ambiguous"], "ci.status")
  assertNonEmptyString(observation.ci.workflow, "ci.workflow")
  assertSha(observation.ci.commitSha, "ci.commitSha")

  assertArray(observation.otherCandidates, "otherCandidates")
  for (const other of observation.otherCandidates) {
    assertObject(other, "other candidate")
    assertExactFields(other, ["version", "state"], "other candidate")
    if (!isExactSemver(other.version)) {
      throw new TypeError("other candidate version must be an exact SemVer")
    }
    assertOneOf(other.state, RELEASE_STATES, "other candidate state")
  }

  assertObject(observation.tag, "observation.tag")
  assertExactFields(observation.tag, ["status", "commitSha"], "observation.tag")
  assertOneOf(observation.tag.status, ["absent", "present", "ambiguous"], "tag.status")
  assertNullableSha(observation.tag.commitSha, "tag.commitSha")
  assertIdentityPresence(observation.tag.status, observation.tag.commitSha, "tag.commitSha")

  assertObject(observation.artifacts, "observation.artifacts")
  assertExactFields(
    observation.artifacts,
    ["status", "manifestVersion", "manifestCommitSha", "manifestSha256", "files"],
    "observation.artifacts",
  )
  assertOneOf(
    observation.artifacts.status,
    ["absent", "prepared", "attested", "ambiguous"],
    "artifacts.status",
  )
  assertNullableSemver(observation.artifacts.manifestVersion, "artifacts.manifestVersion")
  assertNullableSha(observation.artifacts.manifestCommitSha, "artifacts.manifestCommitSha")
  assertNullableSha256(observation.artifacts.manifestSha256, "artifacts.manifestSha256")
  const artifactsExist = ["prepared", "attested"].includes(observation.artifacts.status)
  assertIdentityPresence(
    artifactsExist ? "present" : observation.artifacts.status,
    observation.artifacts.manifestVersion,
    "artifacts.manifestVersion",
  )
  assertIdentityPresence(
    artifactsExist ? "present" : observation.artifacts.status,
    observation.artifacts.manifestCommitSha,
    "artifacts.manifestCommitSha",
  )
  validateNamedRecords(observation.artifacts.files, packageNames, "artifacts.files", (file) => {
    assertExactFields(file, ["name", "status"], "artifact file")
    assertOneOf(
      file.status,
      ["pending", "valid", "missing", "corrupt", "unmanifested", "ambiguous"],
      "artifact file status",
    )
  })

  assertObject(observation.escrow, "observation.escrow")
  assertExactFields(observation.escrow, ["status", "manifestSha256"], "observation.escrow")
  assertOneOf(observation.escrow.status, ["absent", "present", "ambiguous"], "escrow.status")
  assertNullableSha256(observation.escrow.manifestSha256, "escrow.manifestSha256")

  validateRegistry(observation.registry, packageNames)
  validateRelease(observation.release)
  validateRequiredSmokeLanes(observation.requiredSmokeLanes)
  validateSmokes(observation.smokes)

  assertObject(observation.audit, "observation.audit")
  assertExactFields(observation.audit, ["status"], "observation.audit")
  assertOneOf(
    observation.audit.status,
    ["none", "dispatched", "complete", "ambiguous"],
    "audit.status",
  )

  assertObject(observation.abandonment, "observation.abandonment")
  assertExactFields(observation.abandonment, ["requested", "recorded"], "observation.abandonment")
  if (
    typeof observation.abandonment.requested !== "boolean" ||
    typeof observation.abandonment.recorded !== "boolean"
  ) {
    throw new TypeError("abandonment flags must be booleans")
  }
}

function validateRegistry(registry, packageNames) {
  assertObject(registry, "observation.registry")
  assertExactFields(
    registry,
    ["latest", "publishJobStarted", "mutationStarted", "packages"],
    "observation.registry",
  )
  assertObject(registry.latest, "registry.latest")
  assertExactFields(registry.latest, ["status", "version"], "registry.latest")
  assertOneOf(registry.latest.status, ["e404", "present", "ambiguous"], "registry.latest.status")
  assertNullableSemver(registry.latest.version, "registry.latest.version")
  assertIdentityPresence(registry.latest.status, registry.latest.version, "registry.latest.version")
  if (
    typeof registry.publishJobStarted !== "boolean" ||
    typeof registry.mutationStarted !== "boolean"
  ) {
    throw new TypeError("registry publish flags must be booleans")
  }
  validateNamedRecords(registry.packages, packageNames, "registry.packages", (pkg) => {
    assertExactFields(
      pkg,
      ["name", "status", "version", "integrity", "provenance"],
      "registry package",
    )
    assertOneOf(pkg.status, ["e404", "present", "ambiguous"], "registry package status")
    assertNullableSemver(pkg.version, "registry package version")
    if (pkg.integrity !== null) {
      assertNonEmptyString(pkg.integrity, "registry package integrity")
    }
    if (pkg.provenance !== null) {
      assertObject(pkg.provenance, "registry package provenance")
      assertExactFields(pkg.provenance, ["workflow", "commitSha"], "registry package provenance")
      assertNonEmptyString(pkg.provenance.workflow, "registry provenance workflow")
      assertSha(pkg.provenance.commitSha, "registry provenance commitSha")
    }
    for (const [field, value] of [
      ["version", pkg.version],
      ["integrity", pkg.integrity],
      ["provenance", pkg.provenance],
    ]) {
      assertIdentityPresence(pkg.status, value, `registry package ${field}`)
    }
  })
}

function validateRelease(release) {
  assertObject(release, "observation.release")
  assertExactFields(release, ["status", "tag", "commitSha", "assets"], "observation.release")
  assertOneOf(release.status, ["absent", "draft", "published", "ambiguous"], "release.status")
  if (release.tag !== null) {
    assertNonEmptyString(release.tag, "release.tag")
  }
  assertNullableSha(release.commitSha, "release.commitSha")
  assertIdentityPresence(release.status, release.tag, "release.tag")
  assertIdentityPresence(release.status, release.commitSha, "release.commitSha")
  assertArray(release.assets, "release.assets")
  const names = new Set()
  for (const asset of release.assets) {
    assertObject(asset, "release asset")
    assertExactFields(asset, ["name", "status", "integrity"], "release asset")
    assertNonEmptyString(asset.name, "release asset name")
    if (names.has(asset.name)) {
      throw new TypeError(`release assets contain duplicate name ${asset.name}`)
    }
    names.add(asset.name)
    assertOneOf(
      asset.status,
      ["absent", "matching", "different", "ambiguous"],
      "release asset status",
    )
    assertNonEmptyString(asset.integrity, "release asset integrity")
  }
}

function validateSmokes(smokes) {
  assertArray(smokes, "smokes")
  for (const smoke of smokes) {
    assertObject(smoke, "smoke")
    assertExactFields(
      smoke,
      ["name", "status", "version", "commitSha", "manifestSha256", "workflowRunId", "runAttempt"],
      "smoke",
      ["commitSha", "manifestSha256", "workflowRunId", "runAttempt"],
    )
    assertNonEmptyString(smoke.name, "smoke.name")
    assertOneOf(
      smoke.status,
      ["pending", "passed", "missing", "failed", "ambiguous"],
      "smoke.status",
    )
    if (!isExactSemver(smoke.version)) {
      throw new TypeError("smoke.version must be an exact SemVer")
    }
    if (smoke.commitSha !== undefined && smoke.commitSha !== null) {
      assertSha(smoke.commitSha, "smoke.commitSha")
    }
    if (smoke.manifestSha256 !== undefined && smoke.manifestSha256 !== null) {
      assertNullableSha256(smoke.manifestSha256, "smoke.manifestSha256")
    }
  }
}

function validateRequiredSmokeLanes(lanes) {
  if (lanes === undefined) {
    return
  }
  assertArray(lanes, "requiredSmokeLanes")
  for (const lane of lanes) {
    assertNonEmptyString(lane, "required smoke lane")
  }
}

function validateNamedRecords(records, expectedNames, label, validateRecord) {
  assertArray(records, label)
  const actualNames = new Set()
  for (const record of records) {
    assertObject(record, label)
    assertNonEmptyString(record.name, `${label} name`)
    if (actualNames.has(record.name)) {
      throw new TypeError(`${label} contains duplicate name ${record.name}`)
    }
    actualNames.add(record.name)
    validateRecord(record)
  }
  if (
    actualNames.size !== expectedNames.size ||
    [...expectedNames].some((name) => !actualNames.has(name))
  ) {
    throw new TypeError(`${label} must exactly match the release inventory`)
  }
}

function assertJsonValue(value, label, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} must contain only JSON values`)
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} must not contain cycles`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only JSON objects`)
  }
  const nextAncestors = new Set(ancestors).add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} must contain only string keys`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label} must not contain accessors`)
    }
    assertJsonValue(descriptor.value, label, nextAncestors)
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${label} arrays must not be sparse`)
      }
    }
  }
}

function assertObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, fields, label, optionalFields = []) {
  const actual = Object.keys(value)
  const missing = fields.find(
    (field) => !optionalFields.includes(field) && !Object.hasOwn(value, field),
  )
  if (missing !== undefined) {
    throw new TypeError(`${label} is missing field ${missing}`)
  }
  const unknown = actual.filter((field) => !fields.includes(field)).sort()[0]
  if (unknown !== undefined) {
    throw new TypeError(`${label} contains unknown field ${unknown}`)
  }
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareNames(left, right) {
  return left.localeCompare(right)
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }
}

function assertNonEmptyArray(value, label) {
  assertArray(value, label)
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of ${allowed.join(", ")}`)
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 40-character lowercase hexadecimal SHA`)
  }
}

function assertNullableSha(value, label) {
  if (value !== null) {
    assertSha(value, label)
  }
}

function assertNullableSemver(value, label) {
  if (value !== null && !isExactSemver(value)) {
    throw new TypeError(`${label} must be null or an exact SemVer`)
  }
}

function assertNullableSha256(value, label) {
  if (value !== null && (typeof value !== "string" || !SHA256_PATTERN.test(value))) {
    throw new TypeError(`${label} must be null or a lowercase SHA-256 digest`)
  }
}

function assertIdentityPresence(status, value, label) {
  if (status === "present" || status === "draft" || status === "published") {
    if (value === null) {
      throw new TypeError(`${label} must be present when status is ${status}`)
    }
  } else if (value !== null) {
    throw new TypeError(`${label} must be null when status is ${status}`)
  }
}
