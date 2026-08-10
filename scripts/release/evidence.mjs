import {
  findObservationSchemaConflicts,
  observationStructureIsValid,
} from "./observation-schema.mjs"
import { compareSemver, isExactSemver } from "./semver.mjs"

const SHA256_PATTERN = /^[0-9a-f]{64}$/u

export function correlateReleaseEvidence(candidate, observation) {
  const conflicts = new Set(findObservationSchemaConflicts(observation))
  if (conflicts.has("observation-schema-invalid") || !observationStructureIsValid(observation)) {
    return invalidEvidence(conflicts)
  }
  const inventoryPackages = Array.isArray(observation.inventory?.packages)
    ? observation.inventory.packages
    : []
  const packageByName = new Map(inventoryPackages.map((pkg) => [pkg.name, pkg]))
  const artifact = analyzeArtifacts(candidate, observation, inventoryPackages, conflicts)
  const assets = analyzeAssets(candidate, observation, artifact, conflicts)
  const npm = analyzeNpm(candidate, observation, packageByName, conflicts)
  const smokes = analyzeSmokes(candidate, observation, artifact.manifestSha256, conflicts)
  const audit = analyzeAudit(candidate, observation, artifact.manifestSha256, conflicts)

  return Object.freeze({
    conflicts: Object.freeze([...conflicts].sort()),
    schemaValid: !conflicts.has("observation-schema-invalid"),
    structureValid: true,
    artifact,
    assets,
    npm,
    smokes,
    audit,
  })
}

function invalidEvidence(conflicts) {
  return Object.freeze({
    conflicts: Object.freeze([...conflicts].sort()),
    schemaValid: false,
    structureValid: false,
    artifact: Object.freeze({
      prepared: false,
      attested: false,
      manifestSha256: null,
      immutableAssets: Object.freeze([]),
    }),
    assets: Object.freeze({
      releaseExists: false,
      escrowComplete: false,
      draftExact: false,
      metadataComplete: false,
      publishedExact: false,
    }),
    npm: Object.freeze({
      complete: false,
      presentCount: 0,
      started: false,
      latestNewer: false,
      ambiguous: false,
    }),
    smokes: Object.freeze({ complete: false, anyPassed: false, ambiguous: false }),
    audit: Object.freeze({
      dispatched: false,
      complete: false,
      active: false,
      ambiguous: false,
      retryable: false,
    }),
  })
}

function analyzeArtifacts(candidate, observation, inventoryPackages, conflicts) {
  const artifacts = observation.artifacts ?? {}
  const files = Array.isArray(artifacts.files) ? artifacts.files : []
  const attestations = Array.isArray(artifacts.attestations) ? artifacts.attestations : []
  const active = artifacts.status === "prepared" || artifacts.status === "attested"
  if (artifacts.status === "ambiguous") conflicts.add("artifacts-ambiguous")
  if (active && artifacts.manifestVersion !== candidate.version) {
    conflicts.add("artifact-manifest-version-mismatch")
  }
  if (active && artifacts.manifestCommitSha !== candidate.commitSha) {
    conflicts.add("artifact-manifest-commit-mismatch")
  }
  if (active && !isSha256(artifacts.manifestSha256)) {
    conflicts.add("artifacts-manifest-digest-missing")
  }
  if (active && artifacts.manifestAsset?.name !== "manifest.json") {
    conflicts.add("artifact-manifest-asset-name-mismatch")
  }
  if (active && artifacts.manifestAsset?.sha256 !== artifacts.manifestSha256) {
    conflicts.add("artifact-manifest-asset-digest-mismatch")
  }
  if (active && artifacts.releaseRecordAsset?.name !== "release-record.json") {
    conflicts.add("artifact-release-record-name-mismatch")
  }
  if (active && !isSha256(artifacts.releaseRecordAsset?.sha256)) {
    conflicts.add("artifact-release-record-digest-missing")
  }
  const byName = groupByName(files)
  for (const pkg of inventoryPackages) {
    const matches = byName.get(pkg.name) ?? []
    if (matches.length !== 1) conflicts.add("artifact-inventory-set-mismatch")
    const file = matches[0]
    if (file === undefined) continue
    if (["missing", "corrupt", "unmanifested"].includes(file.status)) {
      conflicts.add(`artifact-${file.status}`)
    } else if (file.status === "ambiguous") {
      conflicts.add("artifact-ambiguous")
    } else if (active && file.status === "pending") {
      conflicts.add("artifact-pending-after-preparation")
    }
    if (active && file.assetName !== pkg.filename) conflicts.add("artifact-filename-mismatch")
    if (active && file.sha256 !== pkg.tarballSha256) conflicts.add("artifact-bytes-mismatch")
    if (active && file.integrity !== pkg.integrity) conflicts.add("artifact-integrity-mismatch")
  }
  if (artifacts.status === "absent" && files.some((file) => file.status !== "pending")) {
    conflicts.add("artifact-observation-contradiction")
  }
  const expectedAttestations = [
    ...inventoryPackages.map((pkg) => ({
      name: pkg.attestationFilename,
      sha256: pkg.attestationSha256,
      subjectName: pkg.filename,
      subjectSha256: pkg.tarballSha256,
    })),
    {
      name: artifacts.manifestAttestationAsset?.name,
      sha256: artifacts.manifestAttestationAsset?.sha256,
      subjectName: "manifest.json",
      subjectSha256: artifacts.manifestSha256,
    },
  ]
  const attestationBySubject = groupBy(attestations, (attestation) => attestation.subjectName)
  let attestationsComplete = attestations.length === expectedAttestations.length
  if (!attestationsComplete) conflicts.add("artifact-attestation-subject-set-mismatch")
  for (const expected of expectedAttestations) {
    const matches = attestationBySubject.get(expected.subjectName) ?? []
    if (matches.length !== 1) {
      conflicts.add("artifact-attestation-subject-set-mismatch")
      conflicts.add(
        expected.subjectName === "manifest.json"
          ? "artifact-manifest-attestation-missing"
          : "artifact-attestation-missing",
      )
      attestationsComplete = false
      continue
    }
    const attestation = matches[0]
    if (attestation.name !== expected.name) {
      conflicts.add("artifact-attestation-name-mismatch")
      attestationsComplete = false
    }
    if (active && attestation.subjectSha256 !== expected.subjectSha256) {
      conflicts.add("artifact-attestation-subject-mismatch")
      attestationsComplete = false
    }
    if (artifacts.status === "attested") {
      if (attestation.status !== "valid") {
        conflicts.add(`artifact-attestation-${attestation.status}`)
        attestationsComplete = false
      }
      if (attestation.sha256 !== expected.sha256) {
        conflicts.add("artifact-attestation-digest-mismatch")
        attestationsComplete = false
      }
    }
  }
  for (const subject of attestationBySubject.keys()) {
    if (!expectedAttestations.some((expected) => expected.subjectName === subject)) {
      conflicts.add("artifact-attestation-subject-set-mismatch")
      attestationsComplete = false
    }
  }
  const valid =
    active &&
    isSha256(artifacts.manifestSha256) &&
    files.length === inventoryPackages.length &&
    inventoryPackages.every((pkg) => {
      const matches = byName.get(pkg.name) ?? []
      const file = matches[0]
      return (
        matches.length === 1 &&
        file.status === "valid" &&
        file.assetName === pkg.filename &&
        file.sha256 === pkg.tarballSha256 &&
        file.integrity === pkg.integrity
      )
    })
  return Object.freeze({
    prepared: valid,
    attested: valid && artifacts.status === "attested" && attestationsComplete,
    manifestSha256: artifacts.manifestSha256 ?? null,
    immutableAssets: Object.freeze([
      artifacts.releaseRecordAsset,
      artifacts.manifestAsset,
      artifacts.manifestAttestationAsset,
      ...inventoryPackages.map((pkg) => ({ name: pkg.filename, sha256: pkg.tarballSha256 })),
      ...inventoryPackages.map((pkg) => ({
        name: pkg.attestationFilename,
        sha256: pkg.attestationSha256,
      })),
    ]),
  })
}

function analyzeAssets(candidate, observation, artifact, conflicts) {
  const escrow = observation.escrow ?? {}
  const release = observation.release ?? {}
  const expected = artifact.immutableAssets
  if (expected.length === 0) conflicts.add("escrow-required-assets-empty")
  if (escrow.status === "ambiguous") conflicts.add("candidate-escrow-ambiguous")
  if (escrow.status === "present") {
    if (!isSha256(escrow.manifestSha256)) conflicts.add("escrow-manifest-digest-missing")
    else if (escrow.manifestSha256 !== artifact.manifestSha256) {
      conflicts.add("escrow-manifest-digest-mismatch")
    }
  }
  const escrowAssets = Array.isArray(escrow.assets) ? escrow.assets : []
  if (escrow.status === "present" && escrowAssets.length === 0) {
    conflicts.add("escrow-required-assets-empty")
  }
  const escrowExact =
    escrow.status === "present" ? exactAssetSet(escrowAssets, expected, "escrow", conflicts) : false

  if (release.status === "ambiguous") conflicts.add("github-release-ambiguous")
  const releaseExists = release.status === "draft" || release.status === "published"
  const releaseAssets = Array.isArray(release.assets) ? release.assets : []
  if (!releaseExists && releaseAssets.length > 0) conflicts.add("github-assets-without-release")
  if (releaseExists) {
    if (release.tag !== `v${candidate.version}`) conflicts.add("github-release-tag-mismatch")
    if (release.commitSha !== candidate.commitSha) conflicts.add("github-release-commit-mismatch")
  }
  const releaseExact = releaseExists
    ? exactAssetSet(releaseAssets, expected, "github", conflicts)
    : false
  for (const asset of releaseAssets) {
    if (asset.status === "different") conflicts.add("github-asset-bytes-mismatch")
    if (asset.status === "ambiguous") conflicts.add("github-asset-ambiguous")
    if (asset.status === "absent") conflicts.add("github-required-asset-absent")
  }
  const escrowComplete =
    releaseExists && releaseExact && escrow.status === "present" && escrowExact && artifact.attested
  const draftExact = release.status === "draft" && escrowComplete
  return Object.freeze({
    releaseExists,
    escrowComplete,
    draftExact,
    metadataComplete: escrowComplete && release.metadataReconciled === true,
    publishedExact:
      release.status === "published" &&
      release.metadataReconciled === true &&
      releaseExact &&
      escrowExact &&
      artifact.attested,
  })
}

function exactAssetSet(actual, expected, prefix, conflicts) {
  if (
    !Array.isArray(actual) ||
    !Array.isArray(expected) ||
    actual.some(
      (item) =>
        item === null ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.name !== "string" ||
        (item.sha256 !== null && !isSha256(item.sha256)),
    ) ||
    expected.some(
      (item) =>
        item === null ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.name !== "string" ||
        !isSha256(item.sha256),
    )
  ) {
    conflicts.add("observation-schema-invalid")
    return false
  }
  const groups = groupByName(actual)
  let exact = actual.length === expected.length && expected.length > 0
  for (const [name, records] of groups) {
    if (records.length > 1) {
      conflicts.add(prefix === "github" ? "github-asset-duplicate" : "escrow-asset-duplicate")
      exact = false
    }
    if (!expected.some((item) => item.name === name)) {
      conflicts.add(
        prefix === "github" ? "github-managed-asset-unexpected" : "escrow-asset-unexpected",
      )
      exact = false
    }
  }
  for (const item of expected) {
    const records = groups.get(item.name) ?? []
    if (records.length !== 1) {
      conflicts.add(prefix === "github" ? "github-required-asset-absent" : "escrow-asset-missing")
      if (prefix === "escrow") {
        if (item.name === "manifest.json") conflicts.add("escrow-manifest-asset-missing")
        else if (item.name === "release-record.json") {
          conflicts.add("escrow-release-record-asset-missing")
        } else if (item.name.endsWith(".intoto.jsonl")) {
          conflicts.add("escrow-attestation-asset-missing")
        }
      } else if (item.name === "manifest.json") {
        conflicts.add("github-manifest-asset-missing")
      } else if (item.name === "release-record.json") {
        conflicts.add("github-release-record-asset-missing")
      } else if (item.name.endsWith(".intoto.jsonl")) {
        conflicts.add("github-attestation-asset-missing")
      }
      exact = false
      continue
    }
    const record = records[0]
    if (record.sha256 !== item.sha256) {
      conflicts.add(
        prefix === "github" ? "github-asset-bytes-mismatch" : "escrow-asset-bytes-mismatch",
      )
      exact = false
    }
    if (record.status !== undefined && record.status !== "matching") exact = false
  }
  return exact
}

function analyzeNpm(candidate, observation, packageByName, conflicts) {
  const registry = observation.registry ?? {}
  const packages = Array.isArray(registry.packages) ? registry.packages : []
  const groups = groupByName(packages)
  let presentCount = 0
  let complete = packageByName.size > 0 && packages.length === packageByName.size
  let latestNewer = false
  let ambiguous = false
  for (const [name, expected] of packageByName) {
    const matches = groups.get(name) ?? []
    if (matches.length !== 1) {
      conflicts.add("registry-package-set-mismatch")
      complete = false
      continue
    }
    const pkg = matches[0]
    if (pkg.status === "ambiguous") {
      conflicts.add("registry-package-ambiguous")
      ambiguous = true
      complete = false
    } else if (pkg.status === "present") {
      presentCount += 1
      if (pkg.version !== candidate.version) conflicts.add("npm-version-mismatch")
      if (pkg.integrity !== expected.integrity) conflicts.add("npm-bytes-mismatch")
      if (pkg.tarballSha256 !== expected.tarballSha256) {
        conflicts.add("npm-tarball-digest-mismatch")
      }
      if (pkg.provenance === null || typeof pkg.provenance !== "object") {
        conflicts.add("npm-provenance-missing")
      } else {
        if (pkg.provenance.workflow !== candidate.publisherWorkflow) {
          conflicts.add("npm-provenance-workflow-mismatch")
        }
        if (pkg.provenance.commitSha !== candidate.commitSha) {
          conflicts.add("npm-provenance-commitSha-mismatch")
        }
      }
      if (pkg.signature?.status !== "valid") {
        conflicts.add(`npm-signature-${pkg.signature?.status ?? "missing"}`)
        if (pkg.signature?.status === "ambiguous") ambiguous = true
      }
      if (pkg.latest?.status === "ambiguous") {
        conflicts.add("registry-latest-ambiguous")
        ambiguous = true
      } else if (pkg.latest?.status === "e404") {
        conflicts.add("npm-package-latest-missing")
      } else if (pkg.latest?.status !== "present") {
        conflicts.add("npm-package-latest-invalid")
      } else if (pkg.latest.version !== candidate.version) {
        conflicts.add("npm-package-latest-version-mismatch")
      }
      complete &&=
        pkg.version === candidate.version &&
        pkg.integrity === expected.integrity &&
        pkg.tarballSha256 === expected.tarballSha256 &&
        pkg.provenance?.workflow === candidate.publisherWorkflow &&
        pkg.provenance?.commitSha === candidate.commitSha &&
        pkg.signature?.status === "valid" &&
        pkg.latest?.status === "present" &&
        pkg.latest.version === candidate.version
    } else if (pkg.status !== "e404") {
      conflicts.add("registry-package-status-invalid")
      complete = false
    } else {
      complete = false
    }
    if (pkg.latest?.status === "ambiguous") {
      conflicts.add("registry-latest-ambiguous")
      ambiguous = true
    } else if (!["e404", "present"].includes(pkg.latest?.status)) {
      conflicts.add("npm-package-latest-invalid")
    } else if (
      pkg.latest?.status === "present" &&
      isExactSemver(pkg.latest.version) &&
      compareSemver(pkg.latest.version, candidate.version) > 0
    ) {
      latestNewer = true
    }
  }
  return Object.freeze({
    complete,
    presentCount,
    started: Boolean(registry.publishJobStarted || registry.mutationStarted || presentCount > 0),
    latestNewer,
    ambiguous,
  })
}

function analyzeSmokes(candidate, observation, manifestSha256, conflicts) {
  const lanes = observation.requiredSmokeLanes
  const results = Array.isArray(observation.smokes) ? observation.smokes : []
  if (!Array.isArray(lanes)) {
    conflicts.add("required-smoke-lanes-missing")
    return Object.freeze({ complete: false, anyPassed: false, ambiguous: false })
  }
  if (lanes.length === 0) conflicts.add("required-smoke-lanes-empty")
  if (new Set(lanes).size !== lanes.length) conflicts.add("required-smoke-lane-duplicate")
  if (!arraysEqual(lanes, [...lanes].sort(compareNames))) {
    conflicts.add("required-smoke-lanes-nondeterministic")
  }
  const laneSet = new Set(lanes)
  const groups = groupByName(results)
  let complete = lanes.length > 0
  let ambiguous = false
  for (const result of results) {
    if (!laneSet.has(result.name)) conflicts.add("required-smoke-result-unexpected")
    if (result.version !== candidate.version) conflicts.add("required-smoke-version-mismatch")
    if (result.commitSha !== candidate.commitSha) conflicts.add("required-smoke-commit-mismatch")
    if (result.manifestSha256 !== manifestSha256) conflicts.add("required-smoke-manifest-mismatch")
    if (!isPositiveInteger(result.workflowRunId)) {
      conflicts.add("required-smoke-workflow-run-id-invalid")
    }
    if (!isPositiveInteger(result.runAttempt)) conflicts.add("required-smoke-run-attempt-invalid")
    if (result.status === "missing" || result.status === "failed") {
      conflicts.add(`required-smoke-${result.status}`)
    } else if (result.status === "ambiguous") {
      conflicts.add("required-smoke-ambiguous")
      ambiguous = true
    }
  }
  for (const lane of laneSet) {
    const matches = groups.get(lane) ?? []
    if (matches.length === 0) conflicts.add("required-smoke-result-missing")
    if (matches.length > 1) conflicts.add("required-smoke-result-duplicate")
    const result = matches[0]
    complete &&=
      matches.length === 1 &&
      result.status === "passed" &&
      result.version === candidate.version &&
      result.commitSha === candidate.commitSha &&
      isSha256(manifestSha256) &&
      result.manifestSha256 === manifestSha256 &&
      isPositiveInteger(result.workflowRunId) &&
      isPositiveInteger(result.runAttempt)
  }
  return Object.freeze({
    complete,
    anyPassed: results.some((result) => result.status === "passed"),
    ambiguous,
  })
}

function analyzeAudit(candidate, observation, manifestSha256, conflicts) {
  const audit = observation.audit ?? {}
  const active = ["dispatched", "success", "failed", "expired", "ambiguous"].includes(audit.status)
  let correlated = true
  if (active && audit.version !== candidate.version) {
    conflicts.add("release-audit-version-mismatch")
    correlated = false
  }
  if (active && audit.commitSha !== candidate.commitSha) {
    conflicts.add("release-audit-commit-mismatch")
    correlated = false
  }
  if (active && (!isSha256(manifestSha256) || audit.manifestSha256 !== manifestSha256)) {
    conflicts.add("release-audit-manifest-mismatch")
    correlated = false
  }
  if (active && !isPositiveInteger(audit.workflowRunId)) {
    conflicts.add("release-audit-workflow-run-id-invalid")
    correlated = false
  }
  if (active && !isPositiveInteger(audit.runAttempt)) {
    conflicts.add("release-audit-run-attempt-invalid")
    correlated = false
  }
  if (audit.status === "ambiguous") conflicts.add("release-audit-ambiguous")
  return Object.freeze({
    dispatched: audit.status === "dispatched" && correlated,
    complete: audit.status === "success" && correlated,
    active,
    ambiguous: audit.status === "ambiguous",
    retryable: ["failed", "expired"].includes(audit.status) && correlated,
  })
}

function groupByName(records) {
  return groupBy(records, (record) => record?.name)
}

function groupBy(records, keyFor) {
  const result = new Map()
  for (const record of records) {
    const key = keyFor(record)
    const matches = result.get(key) ?? []
    matches.push(record)
    result.set(key, matches)
  }
  return result
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value)
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareNames(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
