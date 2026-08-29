import { createHash } from "node:crypto"
import { canonicalReleaseBody, parseSmokeReleaseAssetName } from "./metadata.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

const PLANNER_FIELDS = Object.freeze(["candidate", "observation", "mode"])
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const ASSET_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/u
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const RELEASE_STATES = new Set([
  "NO_CANDIDATE",
  "SUPERSEDED_NOOP",
  "CANDIDATE_VALIDATED",
  "CANDIDATE_TAGGED",
  "ARTIFACTS_PREPARED",
  "ARTIFACTS_ATTESTED",
  "CANDIDATE_ESCROWED",
  "NPM_PARTIAL",
  "NPM_COMPLETE",
  "RELEASE_DRAFT_COMPLETE",
  "SMOKES_COMPLETE",
  "AUDIT_DISPATCHED",
  "AUDIT_RETRYABLE",
  "AUDIT_VERIFIED",
  "AUDIT_COMPLETE",
  "ABANDONED_PREPUBLICATION",
])
const OBSERVATION_FIELDS = Object.freeze([
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
])
const SMOKE_FIELDS = Object.freeze([
  "name",
  "status",
  "version",
  "commitSha",
  "manifestSha256",
  "workflowRunId",
  "runAttempt",
])
const AUDIT_FIELDS = Object.freeze([
  "status",
  "version",
  "commitSha",
  "manifestSha256",
  "workflowRunId",
  "runAttempt",
  "conclusion",
])

export function snapshotPlannerInput(input) {
  assertPlannerRoot(input)
  const snapshot = snapshotJson(input, "planner input")
  const mode = Object.hasOwn(snapshot, "mode") ? snapshot.mode : "shadow"
  if (mode !== "shadow" && mode !== "controller") {
    throw new TypeError("mode must be shadow or controller")
  }
  validateCandidate(snapshot.candidate)
  assertObservation(snapshot.observation)
  return { candidate: snapshot.candidate, observation: snapshot.observation, mode }
}

export function snapshotReleaseInput(candidate, observation) {
  const snapshot = snapshotJson({ candidate, observation }, "release input")
  validateCandidate(snapshot.candidate)
  assertObservation(snapshot.observation)
  return snapshot
}

export function findObservationSchemaConflicts(observation) {
  const conflicts = new Set()
  if (!isRecord(observation)) return ["observation-schema-invalid"]
  if (!hasExactFields(observation, OBSERVATION_FIELDS, ["requiredSmokeLanes"])) {
    conflicts.add("observation-schema-invalid")
  }
  const structurallyValid =
    hasExactFields(observation.inventory, ["status", "packages"]) &&
    recordsHaveExactFields(observation.inventory?.packages, [
      "name",
      "version",
      "filename",
      "tarballSha256",
      "attestationFilename",
      "attestationSha256",
      "integrity",
    ]) &&
    hasExactFields(observation.ci, [
      "status",
      "workflow",
      "check",
      "commitSha",
      "workflowRunId",
      "runAttempt",
    ]) &&
    recordsHaveExactFields(observation.otherCandidates, ["version", "commitSha", "state"]) &&
    hasExactFields(observation.tag, ["status", "commitSha"]) &&
    hasExactFields(observation.artifacts, [
      "status",
      "manifestVersion",
      "manifestCommitSha",
      "manifestSha256",
      "files",
      "manifestAsset",
      "releaseRecordAsset",
      "manifestAttestationAsset",
      "attestations",
    ]) &&
    recordsHaveExactFields(observation.artifacts?.files, [
      "name",
      "status",
      "assetName",
      "sha256",
      "integrity",
    ]) &&
    hasExactFields(observation.artifacts?.manifestAsset, ["name", "sha256"]) &&
    hasExactFields(observation.artifacts?.releaseRecordAsset, ["name", "sha256"]) &&
    hasExactFields(observation.artifacts?.manifestAttestationAsset, ["name", "sha256"]) &&
    recordsHaveExactFields(observation.artifacts?.attestations, [
      "name",
      "status",
      "sha256",
      "subjectName",
      "subjectSha256",
    ]) &&
    hasExactFields(observation.escrow, ["status", "manifestSha256", "assets"]) &&
    recordsHaveExactFields(observation.escrow?.assets, ["name", "status", "sha256"]) &&
    hasExactFields(observation.registry, ["publishJobStarted", "mutationStarted", "packages"]) &&
    recordsHaveExactFields(observation.registry?.packages, [
      "name",
      "status",
      "version",
      "tarballSha256",
      "integrity",
      "latest",
      "signature",
      "provenance",
    ]) &&
    hasExactFields(observation.release, [
      "status",
      "tag",
      "commitSha",
      "immutable",
      "bodySha256",
      "marker",
      "assets",
    ]) &&
    recordsHaveExactFields(observation.release?.assets, ["name", "status", "sha256"]) &&
    hasExactFields(observation.abandonment, ["requested", "recorded", "predecessor"])
  if (!structurallyValid) conflicts.add("observation-schema-invalid")
  for (const pkg of Array.isArray(observation.registry?.packages)
    ? observation.registry.packages
    : []) {
    if (!isRecord(pkg)) continue
    if (!hasExactFields(pkg.latest, ["status", "version"])) {
      conflicts.add("observation-schema-invalid")
    }
    if (!hasExactFields(pkg.signature, ["status"])) {
      conflicts.add("observation-schema-invalid")
    }
    if (pkg.provenance !== null && !hasExactFields(pkg.provenance, ["workflow", "commitSha"])) {
      conflicts.add("observation-schema-invalid")
    }
  }
  const smokes = Array.isArray(observation.smokes) ? observation.smokes : []
  if (!Array.isArray(observation.smokes)) conflicts.add("observation-schema-invalid")
  for (const smoke of smokes) {
    if (!isRecord(smoke)) continue
    if (!hasExactFields(smoke, SMOKE_FIELDS)) conflicts.add("observation-schema-invalid")
    if (
      !Object.hasOwn(smoke, "workflowRunId") ||
      (smoke.status === "pending"
        ? smoke.workflowRunId !== null && !isPositiveInteger(smoke.workflowRunId)
        : !isPositiveInteger(smoke.workflowRunId))
    ) {
      conflicts.add("required-smoke-workflow-run-id-invalid")
    }
    if (
      !Object.hasOwn(smoke, "runAttempt") ||
      (smoke.status === "pending"
        ? smoke.runAttempt !== null && !isPositiveInteger(smoke.runAttempt)
        : !isPositiveInteger(smoke.runAttempt))
    ) {
      conflicts.add("required-smoke-run-attempt-invalid")
    }
  }
  const audit = observation.audit
  if (!hasExactFields(audit, AUDIT_FIELDS)) conflicts.add("observation-schema-invalid")
  if (audit?.status !== "none") {
    if (!isPositiveInteger(audit?.workflowRunId)) {
      conflicts.add("release-audit-workflow-run-id-invalid")
    }
    if (!isPositiveInteger(audit?.runAttempt)) {
      conflicts.add("release-audit-run-attempt-invalid")
    }
  }
  if (structurallyValid) addStatusDependentConflicts(observation, conflicts)
  if (structurallyValid && !semanticallyValid(observation)) {
    conflicts.add("observation-schema-invalid")
  }
  return [...conflicts].sort()
}

function addStatusDependentConflicts(observation, conflicts) {
  if (
    artifactPreparationSignalObserved(observation) &&
    !observation.inventory.packages.every(packageTarballDigestsComplete)
  ) {
    conflicts.add("inventory-artifact-digests-missing")
  }
  if (
    attestationSignalObserved(observation) &&
    !observation.inventory.packages.every(packageAttestationDigestComplete)
  ) {
    conflicts.add("inventory-attestation-digests-missing")
  }
  if (
    ["prepared", "attested"].includes(observation.artifacts.status) &&
    !isSha256(observation.artifacts.manifestSha256)
  ) {
    conflicts.add("artifacts-manifest-digest-missing")
  }
  if (observation.escrow.status === "present") {
    if (!isSha256(observation.escrow.manifestSha256)) {
      conflicts.add("escrow-manifest-digest-missing")
    }
    if (observation.escrow.assets.length === 0) {
      conflicts.add("escrow-required-assets-empty")
    }
  }
  if (!Object.hasOwn(observation, "requiredSmokeLanes")) {
    conflicts.add("required-smoke-lanes-missing")
  }
  if (
    observation.registry.packages.some((pkg) => pkg.status === "present") &&
    observation.escrow.status !== "present"
  ) {
    conflicts.add("npm-before-escrow")
  }
  if (
    observation.registry.packages.some((pkg) => pkg.status === "present" && pkg.provenance === null)
  ) {
    conflicts.add("npm-provenance-missing")
  }
  if (observation.release.status === "absent" && observation.release.assets.length > 0) {
    conflicts.add("github-assets-without-release")
  }
  if (observation.release.status === "draft" && observation.release.immutable !== false) {
    conflicts.add("github-release-draft-immutable-invalid")
  }
  if (observation.release.status === "published") {
    if (observation.release.immutable !== true) conflicts.add("github-release-not-immutable")
    if (observation.release.marker?.phase !== "AUDIT_VERIFIED") {
      conflicts.add("github-release-published-without-audit")
    }
  }
  if (["draft", "published"].includes(observation.release.status)) {
    const releaseMarker = observation.release.marker
    const abandoned = releaseMarker?.phase === "ABANDONED_PREPUBLICATION"
    const attestedAbandonment = abandoned && releaseMarker.attestationSet !== null
    const abandonmentBaseAssets = abandonmentBaseAssetsFromMarker(releaseMarker)
    if (attestedAbandonment && abandonmentBaseAssets.length !== 45) {
      conflicts.add("abandonment-verifiable-base-invalid")
    }
    const expectedAssets = abandoned
      ? attestedAbandonment
        ? abandonmentBaseAssets
        : []
      : [
          observation.artifacts.releaseRecordAsset,
          observation.artifacts.manifestAsset,
          observation.artifacts.manifestAttestationAsset,
          ...observation.inventory.packages.map((pkg) => ({
            name: pkg.filename,
            sha256: pkg.tarballSha256,
          })),
          ...observation.inventory.packages.map((pkg) => ({
            name: pkg.attestationFilename,
            sha256: pkg.attestationSha256,
          })),
        ]
    const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset]))
    const seen = new Set()
    for (const asset of observation.release.assets) {
      if (seen.has(asset.name)) conflicts.add("github-asset-duplicate")
      seen.add(asset.name)
      const expected = expectedByName.get(asset.name)
      if (expected === undefined) {
        if (!releaseEvidenceAssetIsAllowed(asset, observation.release.marker)) {
          conflicts.add("github-managed-asset-unexpected")
        }
      } else if (asset.sha256 !== expected.sha256) conflicts.add("github-asset-bytes-mismatch")
      if (asset.status === "ambiguous") conflicts.add("github-asset-ambiguous")
    }
    if (abandoned) {
      const abandonmentAssets = observation.release.assets.filter(
        (asset) => asset.name === "abandonment.json",
      )
      if (
        abandonmentAssets.length !== 1 ||
        abandonmentAssets[0].sha256 !== observation.release.marker.abandonmentSha256
      ) {
        conflicts.add("abandonment-terminal-evidence-incomplete")
      }
      const retainedBase = observation.release.assets.filter((asset) =>
        expectedByName.has(asset.name),
      )
      if (
        attestedAbandonment
          ? abandonmentBaseAssets.length !== 45 ||
            retainedBase.length !== 45 ||
            abandonmentBaseAssets.some(
              (expected) =>
                !retainedBase.some(
                  (asset) => asset.name === expected.name && asset.sha256 === expected.sha256,
                ),
            )
          : observation.release.assets.some((asset) => asset.name !== "abandonment.json")
      ) {
        conflicts.add("abandonment-verifiable-base-incomplete")
      }
    }
  }
  const manifestAttestations = observation.artifacts.attestations.filter(
    (attestation) => attestation.subjectName === "manifest.json",
  )
  if (manifestAttestations.length === 0) {
    conflicts.add("artifact-manifest-attestation-missing")
    conflicts.add("artifact-attestation-subject-set-mismatch")
  }
  if (
    observation.otherCandidates.some(
      (other) => isExactSemver(other.version) && parseSemver(other.version).build.length > 0,
    )
  ) {
    conflicts.add("competing-version-build-metadata")
  }
}

export function abandonmentBaseAssetsFromMarker(marker) {
  if (
    marker?.phase !== "ABANDONED_PREPUBLICATION" ||
    !isRecord(marker.attestationSet) ||
    !Array.isArray(marker.attestationSet.subjects)
  ) {
    return []
  }
  const subjects = marker.attestationSet.subjects
  const assets = [
    { name: "release-record.json", sha256: marker.releaseRecordSha256 },
    { name: "manifest.json", sha256: marker.manifestSha256 },
    ...subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  if (
    assets.length !== 45 ||
    new Set(assets.map((asset) => asset.name)).size !== 45 ||
    assets.some((asset) => !isAssetName(asset.name) || !isSha256(asset.sha256)) ||
    createHash("sha256")
      .update(`${JSON.stringify(assets)}\n`)
      .digest("hex") !== marker.baseAssetSetSha256
  ) {
    return []
  }
  return assets
}

export function observationStructureIsValid(observation) {
  return (
    observation !== null &&
    typeof observation === "object" &&
    Array.isArray(observation.inventory?.packages) &&
    observation.inventory.packages.every(isRecord) &&
    Array.isArray(observation.otherCandidates) &&
    observation.otherCandidates.every(isRecord) &&
    isRecord(observation.artifacts?.manifestAsset) &&
    isRecord(observation.artifacts?.releaseRecordAsset) &&
    isRecord(observation.artifacts?.manifestAttestationAsset) &&
    Array.isArray(observation.artifacts?.files) &&
    observation.artifacts.files.every(isRecord) &&
    Array.isArray(observation.artifacts?.attestations) &&
    observation.artifacts.attestations.every(isRecord) &&
    Array.isArray(observation.escrow?.assets) &&
    observation.escrow.assets.every(isRecord) &&
    Array.isArray(observation.registry?.packages) &&
    observation.registry.packages.every(isRecord) &&
    Array.isArray(observation.release?.assets) &&
    observation.release.assets.every(isRecord) &&
    Array.isArray(observation.smokes) &&
    observation.smokes.every(isRecord)
  )
}

function semanticallyValid(observation) {
  return (
    validateInventory(observation.inventory) &&
    validateCi(observation.ci) &&
    validateOtherCandidates(observation.otherCandidates) &&
    validateTag(observation.tag) &&
    validateArtifacts(observation.artifacts) &&
    validateEscrow(observation.escrow) &&
    validateRegistry(observation.registry) &&
    validateRelease(observation.release) &&
    validateSmokes(observation.requiredSmokeLanes, observation.smokes) &&
    validateAudit(observation.audit) &&
    validateCanonicalObservationSets(observation) &&
    validateAbandonment(observation.abandonment)
  )
}

function validateAbandonment(abandonment) {
  if (typeof abandonment?.requested !== "boolean" || typeof abandonment?.recorded !== "boolean") {
    return false
  }
  if (!abandonment.recorded) return abandonment.predecessor === null
  return (
    abandonment.requested &&
    ["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED", "CANDIDATE_ESCROWED"].includes(
      abandonment.predecessor,
    )
  )
}

function validateCanonicalObservationSets(observation) {
  const inventory = observation.inventory.packages
  const packageNames = inventory.map((pkg) => pkg.name)
  const tarballNames = inventory.map((pkg) => pkg.filename)
  const expectedAttestationSubjects = [...tarballNames, "manifest.json"]
  const registryNames = observation.registry.packages.map((pkg) => pkg.name)
  const artifactPackageNames = observation.artifacts.files.map((file) => file.name)
  const attestationSubjects = observation.artifacts.attestations.map(
    (attestation) => attestation.subjectName,
  )
  const artifactIdentitiesMatch = observation.artifacts.files.every((file) => {
    const expected = inventory.find((pkg) => pkg.name === file.name)
    return expected !== undefined && file.assetName === expected.filename
  })
  const attestationIdentitiesMatch = observation.artifacts.attestations.every((attestation) => {
    const expected = inventory.find((pkg) => pkg.filename === attestation.subjectName)
    if (expected !== undefined) return attestation.name === expected.attestationFilename
    return (
      attestation.subjectName === "manifest.json" &&
      attestation.name === observation.artifacts.manifestAttestationAsset.name
    )
  })
  const expectedAssets = [
    observation.artifacts.releaseRecordAsset,
    observation.artifacts.manifestAsset,
    observation.artifacts.manifestAttestationAsset,
    ...inventory.map((pkg) => ({ name: pkg.filename, sha256: pkg.tarballSha256 })),
    ...inventory.map((pkg) => ({
      name: pkg.attestationFilename,
      sha256: pkg.attestationSha256,
    })),
  ]
  const expectedAssetNames = expectedAssets.map((asset) => asset.name)
  const modeledAssetsAreUnique = new Set(expectedAssetNames).size === expectedAssetNames.length
  return (
    hasExactUniqueSet(registryNames, packageNames) &&
    hasExactUniqueSet(artifactPackageNames, packageNames) &&
    hasExactUniqueSet(attestationSubjects, expectedAttestationSubjects) &&
    artifactIdentitiesMatch &&
    attestationIdentitiesMatch &&
    modeledAssetsAreUnique &&
    markerMatchesObservation(observation)
  )
}

function markerMatchesObservation(observation) {
  const marker = observation.release.marker
  if (marker === null) return true
  if (marker.phase === "ABANDONED_PREPUBLICATION" && marker.attestationSet === null) {
    if (marker.baseAssetSetSha256 !== null) return false
    if (observation.abandonment.predecessor === "CANDIDATE_TAGGED") {
      return (
        marker.manifestSha256 === null &&
        marker.releaseRecordSha256 === null &&
        observation.artifacts.status === "absent"
      )
    }
    if (observation.abandonment.predecessor !== "ARTIFACTS_PREPARED") return false
    if (!isSha256(marker.manifestSha256) || !isSha256(marker.releaseRecordSha256)) return false
    return (
      (observation.artifacts.status === "prepared" &&
        marker.manifestSha256 === observation.artifacts.manifestSha256 &&
        marker.releaseRecordSha256 === observation.artifacts.releaseRecordAsset.sha256) ||
      (observation.artifacts.status === "absent" &&
        observation.artifacts.manifestSha256 === null &&
        observation.artifacts.releaseRecordAsset.sha256 === null)
    )
  }
  if (marker.phase === "ATTACHING") {
    return (
      marker.manifestSha256 === observation.artifacts.manifestSha256 &&
      marker.releaseRecordSha256 === observation.artifacts.releaseRecordAsset.sha256 &&
      marker.baseAssetSetSha256 === null &&
      marker.attestationSet === null
    )
  }
  const subjects = marker.attestationSet?.subjects
  const expectedSubjects = [
    {
      subjectName: "manifest.json",
      subjectSha256: observation.artifacts.manifestSha256,
      bundleName: observation.artifacts.manifestAttestationAsset.name,
      bundleSha256: observation.artifacts.manifestAttestationAsset.sha256,
    },
    ...observation.inventory.packages.map((pkg) => ({
      subjectName: pkg.filename,
      subjectSha256: pkg.tarballSha256,
      bundleName: pkg.attestationFilename,
      bundleSha256: pkg.attestationSha256,
    })),
  ]
  const expectedByName = new Map(expectedSubjects.map((subject) => [subject.subjectName, subject]))
  if (
    marker.manifestSha256 !== observation.artifacts.manifestSha256 ||
    marker.releaseRecordSha256 !== observation.artifacts.releaseRecordAsset.sha256 ||
    !Array.isArray(subjects) ||
    subjects.length !== expectedSubjects.length ||
    new Set(subjects.map((subject) => subject.subjectName)).size !== subjects.length ||
    !subjects.every((subject) => {
      const expected = expectedByName.get(subject.subjectName)
      return (
        expected !== undefined &&
        ["subjectName", "subjectSha256", "bundleName", "bundleSha256"].every(
          (field) => subject[field] === expected[field],
        )
      )
    })
  ) {
    return false
  }
  const digestEntries = [
    {
      name: observation.artifacts.releaseRecordAsset.name,
      sha256: observation.artifacts.releaseRecordAsset.sha256,
    },
    {
      name: observation.artifacts.manifestAsset.name,
      sha256: observation.artifacts.manifestAsset.sha256,
    },
    ...subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  const baseDigest = createHash("sha256")
    .update(`${JSON.stringify(digestEntries)}\n`)
    .digest("hex")
  return marker.baseAssetSetSha256 === baseDigest
}

function hasExactUniqueSet(actual, expected) {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  return (
    actual.length === expected.length &&
    actualSet.size === actual.length &&
    expectedSet.size === expected.length &&
    actual.every((value) => expectedSet.has(value))
  )
}

function validateInventory(inventory) {
  if (!["valid", "invalid"].includes(inventory?.status) || !Array.isArray(inventory.packages)) {
    return false
  }
  if (inventory.packages.length === 0) return false
  const names = new Set()
  const filenames = new Set()
  const attestationNames = new Set()
  return inventory.packages.every((pkg) => {
    const artifactIdentityComplete = packageArtifactDigestsComplete(pkg)
    const preparedIdentityComplete =
      packageTarballDigestsComplete(pkg) && pkg.attestationSha256 === null
    const artifactIdentityAbsent =
      pkg.tarballSha256 === null && pkg.attestationSha256 === null && pkg.integrity === null
    const valid =
      isPackageName(pkg.name) &&
      isReleaseSemver(pkg.version) &&
      isAssetName(pkg.filename) &&
      isAssetName(pkg.attestationFilename) &&
      (artifactIdentityComplete || preparedIdentityComplete || artifactIdentityAbsent) &&
      !names.has(pkg.name) &&
      !filenames.has(pkg.filename) &&
      !attestationNames.has(pkg.attestationFilename)
    names.add(pkg.name)
    filenames.add(pkg.filename)
    attestationNames.add(pkg.attestationFilename)
    return valid
  })
}

function validateCi(ci) {
  if (!["missing", "failed", "success", "ambiguous"].includes(ci?.status)) return false
  if (["failed", "success"].includes(ci.status)) {
    return (
      isNonEmptyString(ci.workflow) &&
      isNonEmptyString(ci.check) &&
      isSha(ci.commitSha) &&
      isPositiveInteger(ci.workflowRunId) &&
      isPositiveInteger(ci.runAttempt)
    )
  }
  return (
    (ci.workflow === null || isNonEmptyString(ci.workflow)) &&
    (ci.check === null || isNonEmptyString(ci.check)) &&
    (ci.commitSha === null || isSha(ci.commitSha)) &&
    (ci.workflowRunId === null || isPositiveInteger(ci.workflowRunId)) &&
    (ci.runAttempt === null || isPositiveInteger(ci.runAttempt)) &&
    (ci.workflowRunId === null) === (ci.runAttempt === null)
  )
}

function validateOtherCandidates(otherCandidates) {
  return (
    Array.isArray(otherCandidates) &&
    otherCandidates.every(
      (other) =>
        isReleaseSemver(other?.version) &&
        isSha(other.commitSha) &&
        RELEASE_STATES.has(other.state),
    )
  )
}

function validateTag(tag) {
  if (!["absent", "present", "ambiguous"].includes(tag?.status)) return false
  return tag.status === "present" ? isSha(tag.commitSha) : tag.commitSha === null
}

function validateArtifacts(artifacts) {
  if (!["absent", "prepared", "attested", "ambiguous"].includes(artifacts?.status)) {
    return false
  }
  if (!Array.isArray(artifacts.files) || !Array.isArray(artifacts.attestations)) return false
  const active = ["prepared", "attested"].includes(artifacts.status)
  const identityValid = active
    ? isReleaseSemver(artifacts.manifestVersion) &&
      isSha(artifacts.manifestCommitSha) &&
      isSha256(artifacts.manifestSha256) &&
      artifacts.manifestAsset?.name === "manifest.json" &&
      artifacts.manifestAsset.sha256 === artifacts.manifestSha256 &&
      artifacts.releaseRecordAsset?.name === "release-record.json" &&
      isSha256(artifacts.releaseRecordAsset.sha256) &&
      artifacts.manifestAttestationAsset?.name === "manifest.json.intoto.jsonl" &&
      (artifacts.status === "attested"
        ? isSha256(artifacts.manifestAttestationAsset.sha256)
        : artifacts.manifestAttestationAsset.sha256 === null)
    : artifacts.manifestVersion === null &&
      artifacts.manifestCommitSha === null &&
      artifacts.manifestSha256 === null &&
      artifacts.manifestAsset?.name === "manifest.json" &&
      artifacts.manifestAsset.sha256 === null &&
      artifacts.releaseRecordAsset?.name === "release-record.json" &&
      artifacts.releaseRecordAsset.sha256 === null &&
      artifacts.manifestAttestationAsset?.name === "manifest.json.intoto.jsonl" &&
      artifacts.manifestAttestationAsset.sha256 === null
  const nestedProgressValid =
    artifacts.status === "prepared"
      ? artifacts.attestations.every((attestation) => attestation.status === "pending")
      : artifacts.status === "attested"
        ? artifacts.attestations.every((attestation) => attestation.status !== "pending")
        : artifacts.files.every(
            (file) => file.status === "pending" && file.sha256 === null && file.integrity === null,
          ) &&
          artifacts.attestations.every(
            (attestation) => attestation.status === "pending" && attestation.sha256 === null,
          )
  return (
    identityValid &&
    nestedProgressValid &&
    artifacts.files.every(validateArtifactFile) &&
    artifacts.attestations.every(validateAttestation)
  )
}

function validateArtifactFile(file) {
  if (
    !["pending", "valid", "missing", "corrupt", "unmanifested", "ambiguous"].includes(file?.status)
  ) {
    return false
  }
  if (!isPackageName(file.name) || !isAssetName(file.assetName)) return false
  return file.status === "valid"
    ? isSha256(file.sha256) && isIntegrity(file.integrity)
    : (file.sha256 === null || isSha256(file.sha256)) &&
        (file.integrity === null || isIntegrity(file.integrity))
}

function validateAttestation(attestation) {
  if (!["pending", "valid", "missing", "corrupt", "ambiguous"].includes(attestation?.status)) {
    return false
  }
  if (
    !isAssetName(attestation.name) ||
    !isAssetName(attestation.subjectName) ||
    !(attestation.subjectSha256 === null || isSha256(attestation.subjectSha256))
  ) {
    return false
  }
  return attestation.status === "valid"
    ? isSha256(attestation.sha256) && isSha256(attestation.subjectSha256)
    : attestation.sha256 === null
}

function packageArtifactDigestsComplete(pkg) {
  return packageTarballDigestsComplete(pkg) && packageAttestationDigestComplete(pkg)
}

function packageTarballDigestsComplete(pkg) {
  return isSha256(pkg?.tarballSha256) && isIntegrity(pkg.integrity)
}

function packageAttestationDigestComplete(pkg) {
  return isSha256(pkg?.attestationSha256)
}

function artifactPreparationSignalObserved(observation) {
  return (
    observation.artifacts.status !== "absent" ||
    observation.escrow.status !== "absent" ||
    releaseRequiresArtifactDigests(observation.release) ||
    observation.registry.publishJobStarted ||
    observation.registry.mutationStarted ||
    observation.registry.packages.some((pkg) => pkg.status !== "e404")
  )
}

function attestationSignalObserved(observation) {
  return (
    observation.artifacts.status === "attested" ||
    observation.escrow.status !== "absent" ||
    releaseRequiresArtifactDigests(observation.release) ||
    observation.registry.publishJobStarted ||
    observation.registry.mutationStarted ||
    observation.registry.packages.some((pkg) => pkg.status !== "e404")
  )
}

function releaseRequiresArtifactDigests(release) {
  return (
    release.status !== "absent" &&
    !(
      release.status === "draft" &&
      ["ATTACHING", "ABANDONED_PREPUBLICATION"].includes(release.marker?.phase)
    )
  )
}

function validateEscrow(escrow) {
  if (!["absent", "present", "ambiguous"].includes(escrow?.status)) return false
  if (!Array.isArray(escrow.assets) || !escrow.assets.every(validateManagedAsset)) return false
  return escrow.status === "present"
    ? isSha256(escrow.manifestSha256) && escrow.assets.length > 0
    : escrow.manifestSha256 === null && escrow.assets.length === 0
}

function validateRegistry(registry) {
  return (
    typeof registry?.publishJobStarted === "boolean" &&
    typeof registry.mutationStarted === "boolean" &&
    Array.isArray(registry.packages) &&
    registry.packages.every(validateRegistryPackage)
  )
}

function validateRegistryPackage(pkg) {
  if (!isPackageName(pkg?.name) || !["e404", "present", "ambiguous"].includes(pkg.status)) {
    return false
  }
  if (!validateLatest(pkg.latest) || !validateSignature(pkg.signature)) return false
  if (pkg.status === "present") {
    return (
      isReleaseSemver(pkg.version) &&
      isSha256(pkg.tarballSha256) &&
      isIntegrity(pkg.integrity) &&
      validateProvenance(pkg.provenance)
    )
  }
  return (
    pkg.version === null &&
    pkg.tarballSha256 === null &&
    pkg.integrity === null &&
    pkg.provenance === null &&
    (pkg.status !== "ambiguous" ||
      (pkg.latest.status === "ambiguous" && pkg.signature.status === "ambiguous"))
  )
}

function validateLatest(latest) {
  if (!["e404", "present", "ambiguous"].includes(latest?.status)) return false
  return latest.status === "present" ? isReleaseSemver(latest.version) : latest.version === null
}

function validateSignature(signature) {
  return ["missing", "valid", "invalid", "ambiguous"].includes(signature?.status)
}

function validateProvenance(provenance) {
  return (
    provenance !== null &&
    typeof provenance === "object" &&
    isNonEmptyString(provenance.workflow) &&
    isSha(provenance.commitSha)
  )
}

function validateRelease(release) {
  if (!["absent", "draft", "published", "ambiguous"].includes(release?.status)) return false
  if (!Array.isArray(release.assets)) return false
  if (!release.assets.every(validateManagedAsset)) return false
  if (["draft", "published"].includes(release.status)) {
    return (
      isNonEmptyString(release.tag) &&
      isSha(release.commitSha) &&
      typeof release.immutable === "boolean" &&
      isSha256(release.bodySha256) &&
      validateObservedMarker(release.marker)
    )
  }
  return (
    release.tag === null &&
    release.commitSha === null &&
    release.immutable === null &&
    release.bodySha256 === null &&
    release.marker === null &&
    release.assets.length === 0
  )
}

function validateObservedMarker(marker) {
  try {
    canonicalReleaseBody({ marker, manifest: null })
    return true
  } catch {
    return false
  }
}

function releaseEvidenceAssetIsAllowed(asset, marker) {
  if (marker?.phase === "ABANDONED_PREPUBLICATION") {
    return asset.name === "abandonment.json" && asset.sha256 === marker.abandonmentSha256
  }
  const smokeReceipt = marker?.smoke?.receiptAssets?.find(
    ({ releaseAssetName }) => releaseAssetName === asset.name,
  )
  if (smokeReceipt !== undefined) {
    return asset.sha256 === smokeReceipt.receiptSha256
  }
  if (
    marker?.phase === "NPM_COMPLETE" &&
    marker.smoke === null &&
    parseSmokeReleaseAssetName(asset.name) !== null
  ) {
    return true
  }
  if (!["AUDIT_DISPATCHED", "AUDIT_RETRYABLE", "AUDIT_VERIFIED"].includes(marker?.phase)) {
    return false
  }
  if (/^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(asset.name)) {
    return (
      asset.name !== marker.audit?.attemptAssetName || asset.sha256 === marker.audit.attemptSha256
    )
  }
  return (
    marker.phase === "AUDIT_VERIFIED" &&
    asset.name === "audit-result.json" &&
    asset.sha256 === marker.audit?.canonicalSha256
  )
}

function validateManagedAsset(asset) {
  return (
    isAssetName(asset?.name) &&
    ["absent", "matching", "different", "ambiguous"].includes(asset.status) &&
    (isSha256(asset.sha256) || (asset.status === "ambiguous" && asset.sha256 === null))
  )
}

function validateSmokes(lanes, smokes) {
  if (!Array.isArray(lanes) || !lanes.every(isNonEmptyString) || !Array.isArray(smokes)) {
    return false
  }
  return smokes.every(
    (smoke) =>
      isNonEmptyString(smoke?.name) &&
      ["pending", "passed", "missing", "failed", "ambiguous"].includes(smoke.status) &&
      isReleaseSemver(smoke.version) &&
      isSha(smoke.commitSha) &&
      (smoke.manifestSha256 === null || isSha256(smoke.manifestSha256)) &&
      (smoke.status === "pending"
        ? smoke.workflowRunId === null || isPositiveInteger(smoke.workflowRunId)
        : isPositiveInteger(smoke.workflowRunId)) &&
      (smoke.status === "pending"
        ? smoke.runAttempt === null || isPositiveInteger(smoke.runAttempt)
        : isPositiveInteger(smoke.runAttempt)),
  )
}

function validateAudit(audit) {
  if (
    !["none", "dispatched", "success", "failed", "expired", "ambiguous"].includes(audit?.status)
  ) {
    return false
  }
  if (audit.status === "none") {
    return [
      audit.version,
      audit.commitSha,
      audit.manifestSha256,
      audit.workflowRunId,
      audit.runAttempt,
      audit.conclusion,
    ].every((value) => value === null)
  }
  const identityValid =
    isReleaseSemver(audit.version) &&
    isSha(audit.commitSha) &&
    isSha256(audit.manifestSha256) &&
    isPositiveInteger(audit.workflowRunId) &&
    isPositiveInteger(audit.runAttempt)
  if (!identityValid) return false
  if (audit.status === "success") return audit.conclusion === "success"
  if (audit.status === "failed") return audit.conclusion === "failure"
  if (audit.status === "expired") return audit.conclusion === "expired"
  return audit.conclusion === null
}

function isReleaseSemver(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value)
}

function isPackageName(value) {
  return typeof value === "string" && PACKAGE_NAME_PATTERN.test(value)
}

function isAssetName(value) {
  return typeof value === "string" && ASSET_NAME_PATTERN.test(value)
}

function isIntegrity(value) {
  return typeof value === "string" && INTEGRITY_PATTERN.test(value)
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function assertPlannerRoot(input) {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new TypeError("release planner input must be an object")
  }
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string")) {
    throw new TypeError("planner input must contain only string keys")
  }
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError("planner input must not contain accessors")
    }
    if (PLANNER_FIELDS.includes(key) && !descriptor.enumerable) {
      throw new TypeError("planner input must use enumerable data properties")
    }
  }
  const unknown = Object.getOwnPropertyNames(input)
    .filter((key) => !PLANNER_FIELDS.includes(key))
    .sort()[0]
  if (unknown !== undefined) {
    throw new TypeError(`planner input contains unknown field ${unknown}`)
  }
  if (
    (!Object.hasOwn(input, "candidate") && "candidate" in input) ||
    (!Object.hasOwn(input, "observation") && "observation" in input)
  ) {
    throw new TypeError("planner input must use own data properties")
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("planner input must be a plain object")
  }
  for (const field of ["candidate", "observation"]) {
    if (!Object.hasOwn(input, field)) {
      throw new TypeError(`planner input is missing field ${field}`)
    }
  }
}

function validateCandidate(candidate) {
  if (candidate === null) {
    return
  }
  if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
    throw new TypeError("candidate must be an object or null")
  }
  assertExactFields(candidate, CANDIDATE_FIELDS, "candidate")
  if (!isExactSemver(candidate.version)) {
    throw new TypeError("candidate.version must be an exact SemVer")
  }
  if (parseSemver(candidate.version).build.length > 0) {
    throw new TypeError("candidate.version must not contain build metadata")
  }
  if (typeof candidate.commitSha !== "string" || !SHA_PATTERN.test(candidate.commitSha)) {
    throw new TypeError("candidate.commitSha must be a 40-character lowercase hexadecimal SHA")
  }
  if (typeof candidate.publisherWorkflow !== "string" || candidate.publisherWorkflow.length === 0) {
    throw new TypeError("candidate.publisherWorkflow must be a non-empty string")
  }
  if (typeof candidate.ciWorkflow !== "string" || candidate.ciWorkflow.length === 0) {
    throw new TypeError("candidate.ciWorkflow must be a non-empty string")
  }
  if (typeof candidate.ciCheck !== "string" || candidate.ciCheck.length === 0) {
    throw new TypeError("candidate.ciCheck must be a non-empty string")
  }
}

function assertObservation(observation) {
  if (observation === null || Array.isArray(observation) || typeof observation !== "object") {
    throw new TypeError("observation must be an object")
  }
}

function assertExactFields(value, expected, label) {
  const missing = expected.find((field) => !Object.hasOwn(value, field))
  if (missing !== undefined) {
    throw new TypeError(`${label} is missing field ${missing}`)
  }
  const unknown = Object.keys(value)
    .filter((field) => !expected.includes(field))
    .sort()[0]
  if (unknown !== undefined) {
    throw new TypeError(`${label} contains unknown field ${unknown}`)
  }
}

function hasExactFields(value, expected, optional = []) {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false
  const actual = Object.keys(value)
  return (
    expected.every((field) => optional.includes(field) || Object.hasOwn(value, field)) &&
    actual.every((field) => expected.includes(field))
  )
}

function recordsHaveExactFields(records, expected) {
  return Array.isArray(records) && records.every((record) => hasExactFields(record, expected))
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function snapshotJson(value, label) {
  assertSafeJson(value, label, new Set())
  return structuredClone(value)
}

function assertSafeJson(value, label, ancestors) {
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
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string keys`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain objects`)
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${label} arrays must not be sparse`)
      }
    }
    if (
      Object.getOwnPropertyNames(value).some(
        (key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key),
      )
    ) {
      throw new TypeError(`${label} arrays must contain only indexed values`)
    }
  }
  const nextAncestors = new Set(ancestors).add(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label} must not contain accessors`)
    }
    assertSafeJson(descriptor.value, label, nextAncestors)
  }
}
