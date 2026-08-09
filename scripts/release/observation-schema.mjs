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
  "RELEASE_PUBLISHED",
  "AUDIT_DISPATCHED",
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
    hasExactFields(observation.ci, ["status", "workflow", "check", "commitSha"]) &&
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
      "metadataReconciled",
      "assets",
    ]) &&
    recordsHaveExactFields(observation.release?.assets, ["name", "status", "sha256"]) &&
    hasExactFields(observation.abandonment, ["requested", "recorded"])
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
    if (!Object.hasOwn(smoke, "workflowRunId") || !isPositiveInteger(smoke.workflowRunId)) {
      conflicts.add("required-smoke-workflow-run-id-invalid")
    }
    if (!Object.hasOwn(smoke, "runAttempt") || !isPositiveInteger(smoke.runAttempt)) {
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
  if (structurallyValid && !semanticallyValid(observation)) {
    conflicts.add("observation-schema-invalid")
  }
  return [...conflicts].sort()
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
    typeof observation.abandonment?.requested === "boolean" &&
    typeof observation.abandonment?.recorded === "boolean"
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
  const categorizedAssetsMatch =
    (observation.escrow.status !== "present" ||
      hasExactAssetIdentities(observation.escrow.assets, expectedAssets)) &&
    (!["draft", "published"].includes(observation.release.status) ||
      hasExactAssetIdentities(observation.release.assets, expectedAssets))
  return (
    hasExactUniqueSet(registryNames, packageNames) &&
    hasExactUniqueSet(artifactPackageNames, packageNames) &&
    hasExactUniqueSet(attestationSubjects, expectedAttestationSubjects) &&
    artifactIdentitiesMatch &&
    attestationIdentitiesMatch &&
    modeledAssetsAreUnique &&
    categorizedAssetsMatch
  )
}

function hasExactAssetIdentities(actual, expected) {
  return (
    hasExactUniqueSet(
      actual.map((asset) => asset.name),
      expected.map((asset) => asset.name),
    ) &&
    actual.every((asset) => {
      const identity = expected.find((expectedAsset) => expectedAsset.name === asset.name)
      return identity !== undefined && asset.sha256 === identity.sha256
    })
  )
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
    const valid =
      isPackageName(pkg.name) &&
      isReleaseSemver(pkg.version) &&
      isAssetName(pkg.filename) &&
      isSha256(pkg.tarballSha256) &&
      isAssetName(pkg.attestationFilename) &&
      isSha256(pkg.attestationSha256) &&
      isIntegrity(pkg.integrity) &&
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
  return (
    ["missing", "failed", "success", "ambiguous"].includes(ci?.status) &&
    isNonEmptyString(ci.workflow) &&
    isNonEmptyString(ci.check) &&
    isSha(ci.commitSha)
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
    !isSha256(attestation.subjectSha256)
  ) {
    return false
  }
  return attestation.status === "valid" ? isSha256(attestation.sha256) : attestation.sha256 === null
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
  if (typeof release.metadataReconciled !== "boolean" || !Array.isArray(release.assets))
    return false
  if (!release.assets.every(validateManagedAsset)) return false
  if (["draft", "published"].includes(release.status)) {
    return isNonEmptyString(release.tag) && isSha(release.commitSha) && release.assets.length > 0
  }
  return (
    release.tag === null &&
    release.commitSha === null &&
    release.metadataReconciled === false &&
    release.assets.length === 0
  )
}

function validateManagedAsset(asset) {
  return (
    isAssetName(asset?.name) &&
    ["absent", "matching", "different", "ambiguous"].includes(asset.status) &&
    isSha256(asset.sha256)
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
      isPositiveInteger(smoke.workflowRunId) &&
      isPositiveInteger(smoke.runAttempt),
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
