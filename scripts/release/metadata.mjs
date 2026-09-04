import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { extractActionsArtifactZip } from "./artifact-store.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import { canonicalManifestBytes, parseSealedReleaseManifest } from "./manifest.mjs"
import { canonicalNpmEvidenceBytes, parseNpmEvidence } from "./npm-evidence.mjs"
import {
  canonicalReleaseRecordBytes,
  parseReleaseRecord,
  releaseRecordSha256,
} from "./release-record.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"
import {
  aggregateSmokeResults,
  canonicalAggregateSmokeResultBytes,
  parseSmokeResult,
  REQUIRED_RELEASE_SMOKE_LANES,
} from "./smoke-result.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

const MARKER_START = "<!-- DAWN_RELEASE_CONTROLLER_MARKER\n"
const MARKER_END = "\nEND_DAWN_RELEASE_CONTROLLER_MARKER -->"
const MARKER_FIELDS = Object.freeze([
  "schemaVersion",
  "epoch",
  "revision",
  "phase",
  "version",
  "commitSha",
  "tag",
  "manifestSha256",
  "releaseRecordSha256",
  "baseAssetSetSha256",
  "attestationSet",
  "npmEvidenceSha256",
  "smoke",
  "audit",
  "abandonmentSha256",
])
const ATTESTATION_FIELDS = Object.freeze([
  "repository",
  "workflow",
  "sourceRef",
  "commitSha",
  "workflowRunId",
  "runAttempt",
  "subjects",
])
const SUBJECT_FIELDS = Object.freeze(["subjectName", "subjectSha256", "bundleName", "bundleSha256"])
const AUDIT_FIELDS = Object.freeze([
  "workflow",
  "workflowRunId",
  "runUrl",
  "htmlUrl",
  "runAttempt",
  "attemptAssetName",
  "attemptSha256",
  "canonicalSha256",
  "conclusion",
])
const SMOKE_FIELDS = Object.freeze([
  "workflow",
  "workflowRunId",
  "runAttempt",
  "requiredLanes",
  "artifacts",
  "receiptAssets",
  "aggregateSha256",
])
const SMOKE_ARTIFACT_FIELDS = Object.freeze([
  "lane",
  "actionsArtifactId",
  "actionsArtifactName",
  "actionsArtifactUrl",
  "actionsArtifactServiceDigest",
  "releaseAssetId",
  "releaseAssetName",
  "receiptSha256",
])
const SMOKE_RECEIPT_ASSET_FIELDS = Object.freeze([
  "lane",
  "workflowRunId",
  "runAttempt",
  "releaseAssetId",
  "releaseAssetName",
  "receiptSha256",
])
const PUBLICATION_FIELDS = Object.freeze([
  "schemaVersion",
  "version",
  "commitSha",
  "tag",
  "observedAt",
  "candidateRuns",
  "registryMutationReceipts",
  "packages",
])
const RUN_FIELDS = Object.freeze([
  "runId",
  "runAttempt",
  "headSha",
  "headBranch",
  "workflowPath",
  "event",
  "jobs",
])
const JOB_FIELDS = Object.freeze([
  "id",
  "runAttempt",
  "name",
  "status",
  "conclusion",
  "startedAt",
  "completedAt",
])
const PACKAGE_OBSERVATION_FIELDS = Object.freeze([
  "name",
  "version",
  "status",
  "httpStatus",
  "observedAt",
])
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const PHASES = Object.freeze([
  "ATTACHING",
  "ESCROWED",
  "NPM_COMPLETE",
  "SMOKES_COMPLETE",
  "AUDIT_DISPATCHED",
  "AUDIT_RETRYABLE",
  "AUDIT_VERIFIED",
  "ABANDONED_PREPUBLICATION",
])
const PHASE_TRANSITIONS = Object.freeze({
  ATTACHING: Object.freeze(["ESCROWED"]),
  ESCROWED: Object.freeze(["NPM_COMPLETE", "ABANDONED_PREPUBLICATION"]),
  NPM_COMPLETE: Object.freeze(["SMOKES_COMPLETE"]),
  SMOKES_COMPLETE: Object.freeze(["AUDIT_DISPATCHED"]),
  AUDIT_DISPATCHED: Object.freeze(["AUDIT_RETRYABLE", "AUDIT_VERIFIED"]),
  AUDIT_RETRYABLE: Object.freeze(["AUDIT_DISPATCHED"]),
  AUDIT_VERIFIED: Object.freeze([]),
  ABANDONED_PREPUBLICATION: Object.freeze([]),
})
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const ASSET_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._@+-]{0,511}$/u
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const AUDIT_WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const ATTESTATION_REPOSITORY = "cacheplane/dawnai"
export const MAX_AUDIT_ATTEMPTS = 128
export const MAX_SMOKE_ATTEMPTS = 128
const BASE_ASSET_COUNT = 45
export const MAX_SMOKE_ASSETS = MAX_SMOKE_ATTEMPTS * REQUIRED_RELEASE_SMOKE_LANES.length
export const MAX_PUBLICATION_ASSETS = BASE_ASSET_COUNT + MAX_SMOKE_ASSETS + MAX_AUDIT_ATTEMPTS + 1
const SMOKE_WORKFLOW = ".github/workflows/release.yml"
const ACTIONS_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u
const SMOKE_ASSET_PATTERN =
  /^smoke-result-(metadata|published-harness|runtime-targets|scaffold|storage)-([1-9][0-9]*)-([1-9][0-9]*)\.json$/u

export function parseReleaseMarker(value) {
  if (typeof value !== "string") throw new TypeError("Release body must be a string")
  assertPayloadByteLength(Buffer.byteLength(value, "utf8"), 1024 * 1024, "Release body")
  const starts = allIndexes(value, MARKER_START)
  const ends = allIndexes(value, MARKER_END)
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new TypeError("Release body must contain exactly one canonical marker")
  }
  const jsonStart = starts[0] + MARKER_START.length
  const json = value.slice(jsonStart, ends[0])
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new TypeError("Release marker JSON is invalid", { cause: error })
  }
  const marker = validateMarker(snapshotJson(parsed))
  if (json !== JSON.stringify(canonicalize(marker))) {
    throw new TypeError("Release marker JSON is not canonical")
  }
  return marker
}

export function isManagedReleaseForTag(release, tag) {
  try {
    if (!isPlainDataObject(release) || typeof tag !== "string") return false
    const tagName = Object.getOwnPropertyDescriptor(release, "tag_name")
    if (!isEnumerableData(tagName) || typeof tagName.value !== "string") return false
    if (tagName.value === tag) return true
    const draft = Object.getOwnPropertyDescriptor(release, "draft")
    const immutable = Object.getOwnPropertyDescriptor(release, "immutable")
    const body = Object.getOwnPropertyDescriptor(release, "body")
    if (
      !isEnumerableData(draft) ||
      draft.value !== true ||
      !isEnumerableData(immutable) ||
      immutable.value !== false ||
      !isEnumerableData(body) ||
      typeof body.value !== "string"
    ) {
      return false
    }
    return parseReleaseMarker(body.value).tag === tag
  } catch {
    return false
  }
}

export function canonicalReleaseBody(input) {
  const source = snapshotJson(input)
  if (!isRecord(source) || !hasExactFields(source, ["marker", "manifest"], ["previousMarker"])) {
    throw new TypeError("Canonical Release body input is invalid")
  }
  const marker = validateMarker(source.marker)
  if (source.previousMarker !== undefined) {
    validateMarkerTransition(validateMarker(source.previousMarker), marker)
  }
  let manifest = null
  if (source.manifest !== null && source.manifest !== undefined) {
    manifest = parseSealedReleaseManifest(canonicalManifestBytes(source.manifest), {
      candidate: { version: marker.version, commitSha: marker.commitSha },
    })
    if (marker.manifestSha256 !== sha256(canonicalManifestBytes(manifest))) {
      throw new Error("Release marker manifest digest does not match the manifest")
    }
    if (marker.attestationSet !== null) {
      parseAttestationSet(marker.attestationSet, {
        candidate: { version: marker.version, commitSha: marker.commitSha },
        manifest,
        repository: marker.attestationSet.repository,
      })
    }
  } else if (
    !["ATTACHING", "ABANDONED_PREPUBLICATION"].includes(marker.phase) &&
    marker.attestationSet === null
  ) {
    throw new TypeError("Canonical Release body requires exact artifact metadata")
  }

  const lines = [
    `# Dawn v${marker.version}`,
    "",
    `Candidate commit: \`${marker.commitSha}\``,
    `Controller phase: \`${marker.phase}\``,
    "",
    "## Packages",
    "",
  ]
  if (manifest === null && marker.attestationSet === null) {
    lines.push("No package artifact was prepared before this candidate was abandoned.")
  } else if (manifest === null) {
    lines.push("| Tarball | SHA-256 |", "| --- | --- |")
    for (const subject of marker.attestationSet.subjects.slice(1)) {
      lines.push(`| \`${subject.subjectName}\` | \`${subject.subjectSha256}\` |`)
    }
  } else {
    lines.push("| Package | Tarball | SHA-256 |", "| --- | --- | --- |")
    for (const pkg of manifest.packages) {
      lines.push(`| \`${pkg.name}\` | \`${pkg.filename}\` | \`${pkg.sha256}\` |`)
    }
  }
  lines.push(
    "",
    "## Evidence",
    "",
    `- Manifest: ${marker.manifestSha256 === null ? "not prepared" : `\`${marker.manifestSha256}\``}`,
    `- npm evidence: ${marker.npmEvidenceSha256 === null ? "pending" : `\`${marker.npmEvidenceSha256}\``}`,
    `- Smoke aggregate: ${marker.smoke === null ? "pending" : `\`${marker.smoke.aggregateSha256}\``}`,
  )
  if (marker.smoke !== null) {
    lines.push(
      "",
      "## Smoke evidence",
      "",
      `Smoke workflow run: \`${marker.smoke.workflowRunId}\` attempt \`${marker.smoke.runAttempt}\``,
      `Retained attempt-scoped receipts: \`${marker.smoke.receiptAssets.length}\``,
      "",
      "| Lane | Actions artifact | Service digest | Durable Release receipt | Receipt SHA-256 |",
      "| --- | --- | --- | --- | --- |",
    )
    for (const artifact of marker.smoke.artifacts) {
      lines.push(
        `| \`${artifact.lane}\` | [\`${artifact.actionsArtifactName}\`](${artifact.actionsArtifactUrl}) (ID \`${artifact.actionsArtifactId}\`) | \`${artifact.actionsArtifactServiceDigest}\` | \`${artifact.releaseAssetName}\` (ID \`${artifact.releaseAssetId}\`) | \`${artifact.receiptSha256}\` |`,
      )
    }
  }
  lines.push("", `${MARKER_START}${JSON.stringify(canonicalize(marker))}${MARKER_END}`, "")
  const body = lines.join("\n")
  assertPayloadByteLength(Buffer.byteLength(body, "utf8"), 1024 * 1024, "Release body")
  return body
}

export function abandonmentReleaseMarker({
  candidate,
  artifact,
  abandonmentSha256,
  previousMarker = null,
}) {
  const identity = validateCandidate(snapshotJson(candidate), { policyFieldsOptional: true })
  const evidence = snapshotJson(artifact)
  assertExactFields(
    evidence,
    ["manifestSha256", "releaseRecordSha256", "baseAssetSetSha256", "attestationSet"],
    "abandonment artifact context",
  )
  if (!isSha256(abandonmentSha256)) {
    throw new TypeError("Abandonment evidence digest is invalid")
  }
  const previous = previousMarker === null ? null : validateMarker(previousMarker)
  if (
    previous !== null &&
    (previous.phase !== "ESCROWED" ||
      previous.version !== identity.version ||
      previous.commitSha !== identity.commitSha ||
      previous.tag !== `v${identity.version}`)
  ) {
    throw new TypeError("Abandonment predecessor marker is invalid")
  }
  const marker = validateMarker({
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: previous === null ? 1 : previous.revision + 1,
    phase: "ABANDONED_PREPUBLICATION",
    version: identity.version,
    commitSha: identity.commitSha,
    tag: `v${identity.version}`,
    manifestSha256: evidence.manifestSha256,
    releaseRecordSha256: evidence.releaseRecordSha256,
    baseAssetSetSha256: evidence.baseAssetSetSha256,
    attestationSet: evidence.attestationSet,
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256,
  })
  if (previous !== null) validateMarkerTransition(previous, marker)
  return marker
}

export function releaseBodySha256(body) {
  if (typeof body !== "string") throw new TypeError("Release body must be a string")
  assertPayloadByteLength(Buffer.byteLength(body, "utf8"), 1024 * 1024, "Release body")
  return sha256(Buffer.from(body, "utf8"))
}

export function parseAttestationSet(value, { candidate, manifest, repository }) {
  const expectations = snapshotJson({ candidate, manifest, repository })
  const identity = validateCandidate(expectations.candidate, { policyFieldsOptional: true })
  if (
    expectations.repository !== ATTESTATION_REPOSITORY ||
    !REPOSITORY_PATTERN.test(expectations.repository)
  ) {
    throw new TypeError("Attestation repository is invalid")
  }
  const sealedManifest = parseSealedReleaseManifest(canonicalManifestBytes(expectations.manifest), {
    candidate: identity,
  })
  const attestation = snapshotJson(value)
  assertExactFields(attestation, ATTESTATION_FIELDS, "attestation set")
  if (
    attestation.repository !== expectations.repository ||
    attestation.workflow !== ".github/workflows/release.yml" ||
    attestation.sourceRef !== `refs/tags/v${identity.version}` ||
    attestation.commitSha !== identity.commitSha ||
    !isPositiveInteger(attestation.workflowRunId) ||
    !isPositiveInteger(attestation.runAttempt) ||
    !Array.isArray(attestation.subjects) ||
    attestation.subjects.length !== 22
  ) {
    throw new TypeError("Attestation set identity or 22-subject shape is invalid")
  }
  const manifestBytes = canonicalManifestBytes(sealedManifest)
  const expected = [
    { name: "manifest.json", sha256: sha256(manifestBytes) },
    ...sealedManifest.packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.sha256 })),
  ]
  const names = new Set()
  const bundleNames = new Set()
  let bundleSha256 = null
  for (const [index, subject] of attestation.subjects.entries()) {
    assertExactFields(subject, SUBJECT_FIELDS, `attestation subject ${index}`)
    const expectedSubject = expected[index]
    if (
      subject.subjectName !== expectedSubject.name ||
      subject.subjectSha256 !== expectedSubject.sha256 ||
      subject.bundleName !== `${expectedSubject.name}.intoto.jsonl` ||
      !SHA256_PATTERN.test(subject.bundleSha256) ||
      (bundleSha256 !== null && subject.bundleSha256 !== bundleSha256) ||
      names.has(subject.subjectName) ||
      bundleNames.has(subject.bundleName)
    ) {
      throw new TypeError("Attestation subject order, identity, or bundle digest is invalid")
    }
    names.add(subject.subjectName)
    bundleNames.add(subject.bundleName)
    bundleSha256 = subject.bundleSha256
  }
  return deepFreeze(attestation)
}

export function canonicalBaseAssetSet({ record, artifact, attestationSet, bundles }) {
  const releaseRecord = parseReleaseRecord(record)
  const normalizedArtifact = snapshotArtifact(artifact)
  const manifest = parseSealedReleaseManifest(
    canonicalManifestBytes(snapshotJson(normalizedArtifact.manifest)),
    { candidate: releaseRecord },
  )
  const manifestBytes = canonicalManifestBytes(manifest)
  if (sha256(manifestBytes) !== releaseRecord.manifestSha256) {
    throw new Error("Artifact manifest digest does not match the release record")
  }
  const subjects = [
    { name: "manifest.json", bytes: manifestBytes, sha256: releaseRecord.manifestSha256 },
    ...manifest.packages.map((pkg) => ({
      name: pkg.filename,
      bytes: fileBytes(normalizedArtifact.files, pkg.filename),
      sha256: pkg.sha256,
    })),
  ]
  const expectedFileNames = subjects.map(({ name }) => name)
  assertExactNamedSet(normalizedArtifact.files, expectedFileNames, "artifact file")
  for (const subject of subjects) {
    if (sha256(subject.bytes) !== subject.sha256) {
      throw new Error(`Artifact subject digest does not match for ${subject.name}`)
    }
  }
  const parsedAttestations = parseAttestationSet(attestationSet, {
    candidate: { version: releaseRecord.version, commitSha: releaseRecord.commitSha },
    manifest,
    repository: ATTESTATION_REPOSITORY,
  })
  const normalizedBundles = snapshotFiles(bundles, "attestation bundle", {
    maximumItemBytes: RELEASE_PAYLOAD_LIMITS.attestationBundleBytes,
    maximumTotalBytes: RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
  })
  assertExactNamedSet(
    normalizedBundles,
    parsedAttestations.subjects.map(({ bundleName }) => bundleName),
    "attestation bundle",
  )
  const bundleAssets = parsedAttestations.subjects.map((subject) => {
    const bytes = fileBytes(normalizedBundles, subject.bundleName)
    if (sha256(bytes) !== subject.bundleSha256) {
      throw new Error(`Attestation bundle digest does not match for ${subject.bundleName}`)
    }
    return { name: subject.bundleName, bytes, sha256: subject.bundleSha256 }
  })
  const recordBytes = canonicalReleaseRecordBytes(releaseRecord)
  const byteAssets = [
    { name: "release-record.json", bytes: recordBytes, sha256: releaseRecordSha256(releaseRecord) },
    ...subjects,
    ...bundleAssets,
  ]
  if (byteAssets.length !== 45) throw new Error("Canonical base escrow must contain 45 assets")
  let totalBytes = 0
  const assets = byteAssets.map(({ name, bytes, sha256: digest }) => {
    totalBytes += bytes.byteLength
    return deepFreeze({
      name,
      sha256: digest,
      contentBase64: Buffer.from(bytes).toString("base64"),
    })
  })
  assertPayloadByteLength(totalBytes, RELEASE_PAYLOAD_LIMITS.escrowBytes, "Release escrow")
  const digestBytes = Buffer.from(
    `${JSON.stringify(assets.map(({ name, sha256: digest }) => ({ name, sha256: digest })))}\n`,
    "utf8",
  )
  return deepFreeze({ assets, sha256: sha256(digestBytes) })
}

export async function verifyReleaseAttestationAnchor({
  candidate,
  record,
  artifact,
  bundleBytes,
  attestations,
}) {
  const identity = validateCandidate(snapshotJson(candidate), { policyFieldsOptional: true })
  const releaseRecord = parseReleaseRecord(record)
  if (
    releaseRecord.version !== identity.version ||
    releaseRecord.commitSha !== identity.commitSha
  ) {
    throw new Error("Release attestation anchor record does not match the candidate")
  }
  const normalizedArtifact = snapshotArtifact(artifact)
  const manifest = parseSealedReleaseManifest(
    canonicalManifestBytes(snapshotJson(normalizedArtifact.manifest)),
    { candidate: identity },
  )
  if (releaseRecord.manifestSha256 !== sha256(canonicalManifestBytes(manifest))) {
    throw new Error("Release attestation anchor manifest does not match the release record")
  }
  if (!(bundleBytes instanceof Uint8Array)) {
    throw new TypeError("Release attestation anchor bytes are invalid")
  }
  assertPayloadByteLength(
    bundleBytes.byteLength,
    RELEASE_PAYLOAD_LIMITS.attestationBundleBytes,
    "Release attestation anchor",
  )
  const bundle = Buffer.from(bundleBytes)
  const invocation = validateMultiSubjectAttestationBundle(bundle, { manifest })
  const subjects = [
    { name: "manifest.json", sha256: releaseRecord.manifestSha256 },
    ...manifest.packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.sha256 })),
  ]
  const bundleSha256 = sha256(bundle)
  const attestationSet = parseAttestationSet(
    {
      repository: ATTESTATION_REPOSITORY,
      workflow: ".github/workflows/release.yml",
      sourceRef: `refs/tags/v${identity.version}`,
      commitSha: identity.commitSha,
      workflowRunId: invocation.workflowRunId,
      runAttempt: invocation.runAttempt,
      subjects: subjects.map((subject) => ({
        subjectName: subject.name,
        subjectSha256: subject.sha256,
        bundleName: `${subject.name}.intoto.jsonl`,
        bundleSha256,
      })),
    },
    { candidate: identity, manifest, repository: ATTESTATION_REPOSITORY },
  )
  const bundles = attestationSet.subjects.map(({ bundleName }) => ({
    name: bundleName,
    bytes: Buffer.from(bundle),
  }))
  await verifyAttestationBundles({
    attestations: bindMethods(attestations, ["verify"], "Attestation verifier"),
    record: releaseRecord,
    artifact: normalizedArtifact,
    attestationSet,
    bundles,
    candidate: identity,
    manifest,
  })
  const base = canonicalBaseAssetSet({
    record: releaseRecord,
    artifact: normalizedArtifact,
    attestationSet,
    bundles,
  })
  return deepFreeze({
    attestationSet,
    baseAssetSetSha256: base.sha256,
  })
}

export function parsePublicationState(value, { candidate, inventory }) {
  const expectations = snapshotJson({ candidate, inventory })
  const identity = validateCandidate(expectations.candidate)
  const packageNames = inventoryPackageNames(expectations.inventory)
  const state = snapshotJson(value)
  assertExactFields(state, PUBLICATION_FIELDS, "publication state")
  if (
    state.schemaVersion !== 1 ||
    state.version !== identity.version ||
    state.commitSha !== identity.commitSha ||
    state.tag !== `v${identity.version}` ||
    !isTimestamp(state.observedAt) ||
    !Array.isArray(state.candidateRuns) ||
    !Array.isArray(state.registryMutationReceipts) ||
    state.registryMutationReceipts.length !== 0 ||
    !Array.isArray(state.packages) ||
    state.packages.length !== packageNames.length
  ) {
    throw new TypeError("Publication state identity or absence proof is invalid")
  }
  let previousRunId = 0
  const runIds = new Set()
  for (const [runIndex, run] of state.candidateRuns.entries()) {
    assertExactFields(run, RUN_FIELDS, `candidate run ${runIndex}`)
    if (
      !isPositiveInteger(run.runId) ||
      !isPositiveInteger(run.runAttempt) ||
      run.runId <= previousRunId ||
      runIds.has(run.runId) ||
      run.headSha !== identity.commitSha ||
      run.headBranch !== `v${identity.version}` ||
      run.workflowPath !== ".github/workflows/release.yml" ||
      !["push", "workflow_dispatch", "schedule"].includes(run.event) ||
      !Array.isArray(run.jobs) ||
      run.jobs.length === 0
    ) {
      throw new TypeError("Candidate run identity or ordering is invalid")
    }
    previousRunId = run.runId
    runIds.add(run.runId)
    validateAllAttemptJobs(run.jobs, run.runAttempt)
  }
  for (const [index, pkg] of state.packages.entries()) {
    assertExactFields(pkg, PACKAGE_OBSERVATION_FIELDS, `package observation ${index}`)
    if (
      pkg.name !== packageNames[index] ||
      pkg.version !== identity.version ||
      pkg.status !== "ABSENT" ||
      pkg.httpStatus !== 404 ||
      !isTimestamp(pkg.observedAt)
    ) {
      throw new TypeError(
        "Publication package observation must be an exact E404 in inventory order",
      )
    }
  }
  return deepFreeze(state)
}

export function validatePublicationAuditAssets(value, { marker }) {
  const releaseMarker = validateMarker(marker)
  if (releaseMarker.phase !== "AUDIT_VERIFIED") {
    throw new TypeError("Publication audit assets require an AUDIT_VERIFIED marker")
  }
  const assets = snapshotFiles(value, "publication audit asset", {
    maximumItemBytes: RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
    maximumTotalBytes: RELEASE_PAYLOAD_LIMITS.auditEvidenceBytes,
  })
  if (assets.length < 2 || assets.length > MAX_AUDIT_ATTEMPTS + 1) {
    throw new TypeError("Publication audit asset count is outside its bound")
  }
  const names = new Set()
  const identities = new Set()
  let currentAttemptBytes = null
  let canonicalBytes = null
  const validated = []
  for (const asset of assets) {
    if (names.has(asset.name)) throw new TypeError("Publication audit assets contain duplicates")
    names.add(asset.name)
    const result = parseCanonicalAuditResultBytes(asset.bytes)
    if (
      result.version !== releaseMarker.version ||
      result.commitSha !== releaseMarker.commitSha ||
      result.manifestSha256 !== releaseMarker.manifestSha256
    ) {
      throw new TypeError("Publication audit receipt is not correlated to the candidate")
    }
    if (asset.name === "audit-result.json") {
      if (
        result.workflowRunId !== releaseMarker.audit.workflowRunId ||
        result.runAttempt !== releaseMarker.audit.runAttempt ||
        result.conclusion !== "success"
      ) {
        throw new TypeError("Canonical audit receipt does not match the verified attempt")
      }
      canonicalBytes = asset.bytes
    } else {
      const match = /^audit-attempt-([1-9][0-9]*)-([1-9][0-9]*)\.json$/u.exec(asset.name)
      const workflowRunId = match === null ? Number.NaN : Number(match[1])
      const runAttempt = match === null ? Number.NaN : Number(match[2])
      if (
        !Number.isSafeInteger(workflowRunId) ||
        !Number.isSafeInteger(runAttempt) ||
        result.workflowRunId !== workflowRunId ||
        result.runAttempt !== runAttempt
      ) {
        throw new TypeError("Audit attempt filename does not match its receipt identity")
      }
      const identity = `${workflowRunId}:${runAttempt}`
      if (identities.has(identity)) throw new TypeError("Duplicate audit attempt identity")
      identities.add(identity)
      if (asset.name === releaseMarker.audit.attemptAssetName) {
        if (result.conclusion !== "success") {
          throw new TypeError("Verified audit attempt receipt is not successful")
        }
        currentAttemptBytes = asset.bytes
      } else if (result.conclusion !== "failure") {
        throw new TypeError("Historical audit attempt receipt must be a genuine failure")
      }
    }
    validated.push({ name: asset.name, sha256: sha256(asset.bytes) })
  }
  if (
    currentAttemptBytes === null ||
    canonicalBytes === null ||
    !currentAttemptBytes.equals(canonicalBytes) ||
    sha256(currentAttemptBytes) !== releaseMarker.audit.attemptSha256 ||
    sha256(canonicalBytes) !== releaseMarker.audit.canonicalSha256
  ) {
    throw new TypeError("Canonical audit receipt is not byte-identical to its verified attempt")
  }
  return deepFreeze(validated.sort((left, right) => compareText(left.name, right.name)))
}

export function preflightPublicationAssetMetadata(value, { marker }) {
  const releaseMarker = validateMarker(marker)
  if (releaseMarker.phase !== "AUDIT_VERIFIED") {
    throw new TypeError("Publication asset metadata requires an AUDIT_VERIFIED marker")
  }
  if (
    !Array.isArray(value) ||
    value.length < BASE_ASSET_COUNT + releaseMarker.smoke.receiptAssets.length + 2 ||
    value.length > MAX_PUBLICATION_ASSETS
  ) {
    throw new TypeError("Publication asset count is outside its bound")
  }
  const listed = snapshotJson(value)
  const expectedBase = markerBaseAssets(releaseMarker)
  const expectedBaseByName = new Map(expectedBase.map((asset) => [asset.name, asset.sha256]))
  const expectedSmokeByName = new Map(
    releaseMarker.smoke.receiptAssets.map((asset) => [asset.releaseAssetName, asset]),
  )
  const names = new Set()
  const ids = new Set()
  const totals = { base: 0, prepared: 0, bundles: 0, smoke: 0, audit: 0 }
  let auditCount = 0
  const assets = listed.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || !ASSET_NAME_PATTERN.test(item.name)) {
      throw new TypeError("Publication asset identity is malformed")
    }
    const id = positiveId(item.id, "Publication asset ID")
    if (!Number.isSafeInteger(item.size) || item.size < 1) {
      throw new TypeError("Publication asset declared size is invalid")
    }
    if (names.has(item.name) || ids.has(id)) {
      throw new TypeError("Publication asset identity is duplicate")
    }
    names.add(item.name)
    ids.add(id)

    const baseSha256 = expectedBaseByName.get(item.name) ?? null
    const expectedSmoke = expectedSmokeByName.get(item.name) ?? null
    const smokeSha256 = expectedSmoke?.receiptSha256 ?? null
    if (expectedSmoke !== null && id !== expectedSmoke.releaseAssetId) {
      throw new TypeError(
        `Publication smoke receipt asset ID conflicts with its marker for ${item.name}: expected ${expectedSmoke.releaseAssetId}, observed ${id}`,
      )
    }
    const expectedSha256 = baseSha256 ?? smokeSha256
    const limits = publicationAssetLimits(item.name, baseSha256 !== null, smokeSha256 !== null)
    assertPayloadByteLength(item.size, limits.maximumBytes, `${item.name} declared size`)
    if (limits.group === "audit") {
      auditCount += 1
      totals.audit = addPublicationBytes(
        totals.audit,
        item.size,
        RELEASE_PAYLOAD_LIMITS.auditEvidenceBytes,
        "Publication audit evidence",
      )
    } else if (limits.group === "smoke") {
      totals.smoke = addPublicationBytes(
        totals.smoke,
        item.size,
        RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes,
        "Publication smoke receipts",
      )
    } else {
      totals.base = addPublicationBytes(
        totals.base,
        item.size,
        RELEASE_PAYLOAD_LIMITS.escrowBytes,
        "Publication base assets",
      )
      if (limits.group === "prepared") {
        totals.prepared = addPublicationBytes(
          totals.prepared,
          item.size,
          RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes,
          "Publication prepared assets",
        )
      } else if (limits.group === "bundles") {
        totals.bundles = addPublicationBytes(
          totals.bundles,
          item.size,
          RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
          "Publication attestation bundles",
        )
      }
    }
    return {
      id,
      name: item.name,
      size: item.size,
      maximumBytes: limits.maximumBytes,
      group: limits.group,
      expectedSha256,
    }
  })
  if (auditCount < 2 || auditCount > MAX_AUDIT_ATTEMPTS + 1) {
    throw new TypeError("Publication audit asset count is outside its bound")
  }
  if ([...expectedBaseByName.keys()].some((name) => !names.has(name))) {
    throw new TypeError("Publication base asset set is incomplete")
  }
  if ([...expectedSmokeByName.keys()].some((name) => !names.has(name))) {
    throw new TypeError("Publication smoke receipt asset set is incomplete")
  }
  return deepFreeze(assets)
}

export function preflightAuditDraftAssetMetadata(value, { marker }) {
  const releaseMarker = validateMarker(marker)
  if (
    !["SMOKES_COMPLETE", "AUDIT_DISPATCHED", "AUDIT_RETRYABLE", "AUDIT_VERIFIED"].includes(
      releaseMarker.phase,
    )
  ) {
    throw new TypeError("Audit asset metadata requires a smoke-complete audit phase")
  }
  if (
    !Array.isArray(value) ||
    value.length < BASE_ASSET_COUNT + releaseMarker.smoke.receiptAssets.length ||
    value.length > MAX_PUBLICATION_ASSETS
  ) {
    throw new TypeError("Audit draft asset count is outside its bound")
  }
  const listed = snapshotJson(value)
  const expectedBase = markerBaseAssets(releaseMarker)
  const expectedBaseByName = new Map(expectedBase.map((asset) => [asset.name, asset.sha256]))
  const expectedSmokeByName = new Map(
    releaseMarker.smoke.receiptAssets.map((asset) => [asset.releaseAssetName, asset]),
  )
  const names = new Set()
  const ids = new Set()
  const totals = { base: 0, prepared: 0, bundles: 0, smoke: 0, audit: 0 }
  let auditCount = 0
  const assets = listed.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || !ASSET_NAME_PATTERN.test(item.name)) {
      throw new TypeError("Audit draft asset identity is malformed")
    }
    const id = positiveId(item.id, "Audit draft asset ID")
    if (!Number.isSafeInteger(item.size) || item.size < 1) {
      throw new TypeError("Audit draft asset declared size is invalid")
    }
    if (names.has(item.name) || ids.has(id)) {
      throw new TypeError("Audit draft asset identity is duplicate")
    }
    names.add(item.name)
    ids.add(id)

    const baseSha256 = expectedBaseByName.get(item.name) ?? null
    const expectedSmoke = expectedSmokeByName.get(item.name) ?? null
    const smokeSha256 = expectedSmoke?.receiptSha256 ?? null
    if (expectedSmoke !== null && id !== expectedSmoke.releaseAssetId) {
      throw new TypeError(
        `Audit draft smoke receipt asset ID conflicts with its marker for ${item.name}: expected ${expectedSmoke.releaseAssetId}, observed ${id}`,
      )
    }
    const expectedSha256 = baseSha256 ?? smokeSha256
    const limits = publicationAssetLimits(item.name, baseSha256 !== null, smokeSha256 !== null)
    assertPayloadByteLength(item.size, limits.maximumBytes, `${item.name} declared size`)
    if (limits.group === "audit") {
      auditCount += 1
      totals.audit = addPublicationBytes(
        totals.audit,
        item.size,
        RELEASE_PAYLOAD_LIMITS.auditEvidenceBytes,
        "Audit draft evidence",
      )
    } else if (limits.group === "smoke") {
      totals.smoke = addPublicationBytes(
        totals.smoke,
        item.size,
        RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes,
        "Audit draft smoke receipts",
      )
    } else {
      totals.base = addPublicationBytes(
        totals.base,
        item.size,
        RELEASE_PAYLOAD_LIMITS.escrowBytes,
        "Audit draft base assets",
      )
      if (limits.group === "prepared") {
        totals.prepared = addPublicationBytes(
          totals.prepared,
          item.size,
          RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes,
          "Audit draft prepared assets",
        )
      } else if (limits.group === "bundles") {
        totals.bundles = addPublicationBytes(
          totals.bundles,
          item.size,
          RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
          "Audit draft attestation bundles",
        )
      }
    }
    return {
      id,
      name: item.name,
      size: item.size,
      maximumBytes: limits.maximumBytes,
      group: limits.group,
      expectedSha256,
    }
  })
  if (auditCount > MAX_AUDIT_ATTEMPTS + 1) {
    throw new TypeError("Audit draft evidence count is outside its bound")
  }
  if ([...expectedBaseByName.keys()].some((name) => !names.has(name))) {
    throw new TypeError("Audit draft base asset set is incomplete")
  }
  if ([...expectedSmokeByName.keys()].some((name) => !names.has(name))) {
    throw new TypeError("Audit draft smoke receipt asset set is incomplete")
  }
  if (releaseMarker.phase === "SMOKES_COMPLETE" && auditCount !== 0) {
    throw new TypeError("Smoke-complete draft contains premature audit evidence")
  }
  if (
    releaseMarker.phase === "AUDIT_RETRYABLE" &&
    (!names.has(releaseMarker.audit.attemptAssetName) || names.has("audit-result.json"))
  ) {
    throw new TypeError("Retryable audit draft evidence is incomplete or canonicalized")
  }
  if (
    releaseMarker.phase === "AUDIT_VERIFIED" &&
    (!names.has(releaseMarker.audit.attemptAssetName) || !names.has("audit-result.json"))
  ) {
    throw new TypeError("Verified audit draft evidence is incomplete")
  }
  return deepFreeze(assets)
}

export async function escrowCandidate(input) {
  const argumentsSnapshot = snapshotEscrowInput(input)
  const candidate = validateCandidate(argumentsSnapshot.candidate)
  const record = parseReleaseRecord(argumentsSnapshot.record)
  if (record.version !== candidate.version || record.commitSha !== candidate.commitSha) {
    throw new Error("Escrow release record does not match the candidate")
  }
  const base = canonicalBaseAssetSet({
    record,
    artifact: argumentsSnapshot.artifact,
    attestationSet: argumentsSnapshot.attestationSet,
    bundles: argumentsSnapshot.bundles,
  })
  const manifest = parseSealedReleaseManifest(
    canonicalManifestBytes(snapshotJson(argumentsSnapshot.artifact.manifest)),
    { candidate },
  )
  await verifyAttestationBundles({
    attestations: argumentsSnapshot.attestations,
    record,
    artifact: argumentsSnapshot.artifact,
    attestationSet: argumentsSnapshot.attestationSet,
    bundles: argumentsSnapshot.bundles,
    candidate,
    manifest,
  })
  const publicationState = parsePublicationState(argumentsSnapshot.publicationState, {
    candidate,
    inventory: { packages: manifest.packages.map(({ name }) => ({ name })) },
  })
  const inputAttestationSet = parseAttestationSet(argumentsSnapshot.attestationSet, {
    candidate,
    manifest,
    repository: ATTESTATION_REPOSITORY,
  })
  assertAttestationRunAuthorized(inputAttestationSet, publicationState)
  const github = argumentsSnapshot.github
  const title = `Dawn v${candidate.version}`
  const desiredMarker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 1,
    phase: "ATTACHING",
    version: candidate.version,
    commitSha: candidate.commitSha,
    tag: `v${candidate.version}`,
    manifestSha256: record.manifestSha256,
    releaseRecordSha256: releaseRecordSha256(record),
    baseAssetSetSha256: null,
    attestationSet: null,
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
  const initialBody = canonicalReleaseBody({ marker: desiredMarker, manifest })

  await verifyAnnotatedCandidateTag(github.reader, candidate)
  let release = await findManagedRelease(github.reader, desiredMarker.tag)
  if (release === null) {
    const created = await github.writer.createDraftRelease({
      tag: desiredMarker.tag,
      targetSha: candidate.commitSha,
      title,
      body: initialBody,
    })
    release = await readManagedRelease(github.reader, positiveId(created.releaseId, "Release ID"))
  }
  assertMutableCandidateRelease(release, title)
  let marker = parseReleaseMarker(release.body)
  assertEscrowMarkerMatches(marker, desiredMarker, { candidate, manifest })
  if (release.body !== canonicalReleaseBody({ marker, manifest })) {
    throw new Error("Existing Release escrow body is not canonical")
  }

  if (marker.phase === "ESCROWED") {
    const observed = await loadReleaseBaseAssets({
      reader: github.reader,
      releaseId: release.id,
      marker,
      manifest,
      candidate,
      attestations: argumentsSnapshot.attestations,
    })
    await verifyAnnotatedCandidateTag(github.reader, candidate)
    return deepFreeze({
      releaseId: release.id,
      phase: marker.phase,
      status: "unchanged",
      assetCount: observed.size,
      bodySha256: releaseBodySha256(release.body),
    })
  }

  const preparedAssets = base.assets.filter((asset) => !asset.name.endsWith(".intoto.jsonl"))
  if (preparedAssets.length !== 23) {
    throw new Error("Release attaching namespace must contain exactly 23 prepared assets")
  }
  const bundleNames = inputAttestationSet.subjects.map(({ bundleName }) => bundleName)
  let observed = await loadAttachingAssets({
    reader: github.reader,
    releaseId: release.id,
    preparedAssets,
    bundleNames,
  })
  for (const asset of preparedAssets) {
    if (observed.has(asset.name)) continue
    await github.writer.uploadAssetIfAbsentAndEqual({
      releaseId: release.id,
      tag: desiredMarker.tag,
      targetSha: candidate.commitSha,
      name: asset.name,
      bytes: Buffer.from(asset.contentBase64, "base64"),
      sha256: asset.sha256,
    })
  }
  observed = await loadAttachingAssets({
    reader: github.reader,
    releaseId: release.id,
    preparedAssets,
    bundleNames,
  })
  assertPreparedAssetsComplete(observed, preparedAssets)

  const anchorName = bundleNames[0]
  let anchor = firstObservedBundle(observed, bundleNames)
  if (anchor === null) {
    const inputAnchor = argumentsSnapshot.bundles.find((bundle) => bundle.name === anchorName)
    let uploadError = null
    try {
      await github.writer.uploadAssetIfAbsentAndEqual({
        releaseId: release.id,
        tag: desiredMarker.tag,
        targetSha: candidate.commitSha,
        name: anchorName,
        bytes: Buffer.from(inputAnchor.bytes),
        sha256: sha256(inputAnchor.bytes),
      })
    } catch (error) {
      uploadError = error
    }
    observed = await loadAttachingAssets({
      reader: github.reader,
      releaseId: release.id,
      preparedAssets,
      bundleNames,
    })
    anchor = firstObservedBundle(observed, bundleNames)
    if (anchor === null) {
      throw new Error("Release attestation anchor upload did not converge", {
        cause: uploadError,
      })
    }
  }

  const remoteMaterial = materializePreparedReleaseAssets({
    observed,
    candidate,
    expectedRecord: record,
    expectedManifest: manifest,
  })
  const anchored = await verifyReleaseAttestationAnchor({
    candidate,
    record: remoteMaterial.record,
    artifact: remoteMaterial.artifact,
    bundleBytes: anchor.bytes,
    attestations: argumentsSnapshot.attestations,
  })
  const adoptedAttestationSet = anchored.attestationSet
  assertAttestationRunAuthorized(adoptedAttestationSet, publicationState)
  const adoptedBundles = adoptedAttestationSet.subjects.map(({ bundleName }) => ({
    name: bundleName,
    bytes: Buffer.from(anchor.bytes),
  }))
  const adoptedBase = canonicalBaseAssetSet({
    record: remoteMaterial.record,
    artifact: remoteMaterial.artifact,
    attestationSet: adoptedAttestationSet,
    bundles: adoptedBundles,
  })
  for (const subject of adoptedAttestationSet.subjects) {
    if (observed.has(subject.bundleName)) continue
    await github.writer.uploadAssetIfAbsentAndEqual({
      releaseId: release.id,
      tag: desiredMarker.tag,
      targetSha: candidate.commitSha,
      name: subject.bundleName,
      bytes: Buffer.from(anchor.bytes),
      sha256: anchor.sha256,
    })
  }
  observed = await loadAttachingAssets({
    reader: github.reader,
    releaseId: release.id,
    preparedAssets,
    bundleNames,
  })
  if (observed.size !== 45) throw new Error("Release escrow did not re-read exactly 45 assets")
  await verifyObservedBaseAssets({
    observed,
    base: adoptedBase,
    candidate,
    attestations: argumentsSnapshot.attestations,
    attestationSet: adoptedAttestationSet,
  })
  const nextMarker = validateMarker({
    ...marker,
    revision: marker.revision + 1,
    phase: "ESCROWED",
    baseAssetSetSha256: adoptedBase.sha256,
    attestationSet: adoptedAttestationSet,
  })
  const nextBody = canonicalReleaseBody({ marker: nextMarker, manifest, previousMarker: marker })
  await github.writer.updateDraftReleaseIfCurrent({
    releaseId: release.id,
    tag: desiredMarker.tag,
    targetSha: candidate.commitSha,
    expectedBodySha256: releaseBodySha256(release.body),
    title,
    body: nextBody,
  })
  release = await readManagedRelease(github.reader, release.id)
  marker = parseReleaseMarker(release.body)
  if (marker.phase !== "ESCROWED" || marker.revision !== nextMarker.revision) {
    throw new Error("Release escrow marker did not advance after exact asset re-read")
  }
  await verifyAnnotatedCandidateTag(github.reader, candidate)
  return deepFreeze({
    releaseId: release.id,
    phase: marker.phase,
    status: "escrowed",
    assetCount: observed.size,
    bodySha256: releaseBodySha256(release.body),
  })
}

export async function reconcileNpmEvidence({ candidate, record, manifest, npmEvidence, github }) {
  const snapshot = snapshotJson({ candidate, record, manifest, npmEvidence })
  const identity = validateCandidate(snapshot.candidate)
  const releaseRecord = parseReleaseRecord(snapshot.record)
  assertRecordIdentity(releaseRecord, identity)
  const normalizedNpmEvidence = normalizeNpmEvidence(
    snapshot.npmEvidence,
    identity,
    releaseRecord,
    snapshot.manifest,
  )
  const npmDigest = normalizedNpmEvidence.sha256
  const effects = snapshotGitHubBoundary(github)
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  let release = await requireDraftRelease(effects.reader, identity)
  const marker = parseReleaseMarker(release.body)
  assertMarkerArtifactIdentity(marker, identity, releaseRecord)
  if (marker.phase === "NPM_COMPLETE") {
    if (marker.npmEvidenceSha256 !== npmDigest) {
      throw new Error("Existing npm evidence digest conflicts with the exact evidence")
    }
    await verifyAnnotatedCandidateTag(effects.reader, identity)
    return transitionResult(release, marker, "unchanged")
  }
  if (marker.phase !== "ESCROWED") {
    throw new Error("npm reconciliation is permitted only from ESCROWED")
  }
  const next = validateMarker({
    ...marker,
    revision: marker.revision + 1,
    phase: "NPM_COMPLETE",
    npmEvidenceSha256: npmDigest,
  })
  const body = canonicalReleaseBody({ marker: next, manifest: null, previousMarker: marker })
  await effects.writer.updateDraftReleaseIfCurrent({
    releaseId: release.id,
    tag: marker.tag,
    targetSha: identity.commitSha,
    expectedBodySha256: releaseBodySha256(release.body),
    title: `Dawn v${identity.version}`,
    body,
  })
  release = await readManagedRelease(effects.reader, release.id)
  const observed = parseReleaseMarker(release.body)
  if (observed.phase !== "NPM_COMPLETE" || observed.npmEvidenceSha256 !== npmDigest) {
    throw new Error("npm evidence marker compare-and-swap was not durable")
  }
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  return transitionResult(release, observed, "updated")
}

export async function reconcileSmokeEvidence(input) {
  const snapshot = snapshotSmokeReconciliationInput(input)
  const identity = validateCandidate(snapshot.candidate)
  const releaseRecord = parseReleaseRecord(snapshot.record)
  assertRecordIdentity(releaseRecord, identity)
  const normalizedNpmEvidence = normalizeNpmEvidence(
    snapshot.npmEvidence,
    identity,
    releaseRecord,
    snapshot.manifest,
  )
  const npmDigest = normalizedNpmEvidence.sha256
  const smokeAggregate = aggregateSmokeResults(snapshot.smokeResults, {
    version: identity.version,
    commitSha: identity.commitSha,
    manifestSha256: releaseRecord.manifestSha256,
    workflowRunId: snapshot.workflowRunId,
    runAttempt: snapshot.runAttempt,
  })
  if (smokeAggregate.conclusion !== "success") {
    throw new Error("Smoke aggregate conclusion must be success")
  }
  const smokeDigest = sha256(canonicalAggregateSmokeResultBytes(smokeAggregate))
  const effects = snapshotGitHubBoundary(snapshot.github)
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  let release = await requireDraftRelease(effects.reader, identity)
  const marker = parseReleaseMarker(release.body)
  assertMarkerArtifactIdentity(marker, identity, releaseRecord)
  if (marker.npmEvidenceSha256 !== npmDigest) {
    throw new Error("Smoke reconciliation npm evidence does not match the draft marker")
  }
  if (marker.phase === "SMOKES_COMPLETE") {
    assertSelectedSmokeReplay(marker.smoke, snapshot, smokeDigest)
    const observedAssets = await observeSmokeReceiptAssets(
      effects.reader,
      release.id,
      marker,
      identity,
    )
    assertSmokeReceiptAssetSet(marker.smoke, observedAssets)
    await verifyAnnotatedCandidateTag(effects.reader, identity)
    return transitionResult(release, marker, "unchanged")
  }
  if (marker.phase !== "NPM_COMPLETE") {
    throw new Error("smoke reconciliation is permitted only from NPM_COMPLETE")
  }
  const actionsArtifacts = await observeExactSmokeActionsArtifacts({
    reader: effects.reader,
    marker,
    identity,
    workflowRunId: snapshot.workflowRunId,
    runAttempt: snapshot.runAttempt,
    smokeResults: snapshot.smokeResults,
  })
  let observedAssets = await observeSmokeReceiptAssets(effects.reader, release.id, marker, identity)
  const currentByLane = new Map(
    observedAssets
      .filter(
        (asset) =>
          asset.workflowRunId === snapshot.workflowRunId &&
          asset.runAttempt === snapshot.runAttempt,
      )
      .map((asset) => [asset.lane, asset]),
  )
  for (const [index, lane] of REQUIRED_RELEASE_SMOKE_LANES.entries()) {
    const bytes = snapshot.smokeResults[index]
    const name = smokeReleaseAssetName(lane, snapshot.workflowRunId, snapshot.runAttempt)
    const digest = sha256(bytes)
    const existing = currentByLane.get(lane)
    if (existing !== undefined) {
      if (existing.releaseAssetName !== name || existing.receiptSha256 !== digest) {
        throw new Error(`Existing smoke receipt asset conflicts for lane ${lane}`)
      }
      continue
    }
    await effects.writer.uploadAssetIfAbsentAndEqual({
      releaseId: release.id,
      tag: marker.tag,
      targetSha: identity.commitSha,
      name,
      bytes: Buffer.from(bytes),
      sha256: digest,
    })
  }
  observedAssets = await observeSmokeReceiptAssets(effects.reader, release.id, marker, identity)
  const selectedReleaseAssets = new Map(
    observedAssets
      .filter(
        (asset) =>
          asset.workflowRunId === snapshot.workflowRunId &&
          asset.runAttempt === snapshot.runAttempt,
      )
      .map((asset) => [asset.lane, asset]),
  )
  if (selectedReleaseAssets.size !== REQUIRED_RELEASE_SMOKE_LANES.length) {
    throw new Error("Selected smoke receipt attempt is incomplete after exact re-read")
  }
  const smoke = validateSmokeDescriptor(
    {
      workflow: SMOKE_WORKFLOW,
      workflowRunId: snapshot.workflowRunId,
      runAttempt: snapshot.runAttempt,
      requiredLanes: [...REQUIRED_RELEASE_SMOKE_LANES],
      artifacts: actionsArtifacts.map((artifact) => {
        const releaseAsset = selectedReleaseAssets.get(artifact.lane)
        return {
          ...artifact,
          releaseAssetId: releaseAsset.releaseAssetId,
          releaseAssetName: releaseAsset.releaseAssetName,
          receiptSha256: releaseAsset.receiptSha256,
        }
      }),
      receiptAssets: observedAssets,
      aggregateSha256: smokeDigest,
    },
    marker,
  )
  const next = validateMarker({
    ...marker,
    revision: marker.revision + 1,
    phase: "SMOKES_COMPLETE",
    smoke,
  })
  const body = canonicalReleaseBody({ marker: next, manifest: null, previousMarker: marker })
  await effects.writer.updateDraftReleaseIfCurrent({
    releaseId: release.id,
    tag: marker.tag,
    targetSha: identity.commitSha,
    expectedBodySha256: releaseBodySha256(release.body),
    title: `Dawn v${identity.version}`,
    body,
  })
  release = await readManagedRelease(effects.reader, release.id)
  const observed = parseReleaseMarker(release.body)
  if (
    observed.phase !== "SMOKES_COMPLETE" ||
    canonicalJsonText(observed.smoke) !== canonicalJsonText(smoke)
  ) {
    throw new Error("Smoke evidence marker compare-and-swap was not durable")
  }
  const durableAssets = await observeSmokeReceiptAssets(
    effects.reader,
    release.id,
    observed,
    identity,
  )
  assertSmokeReceiptAssetSet(observed.smoke, durableAssets)
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  return transitionResult(release, observed, "updated")
}

export async function publishConsolidatedRelease({ candidate, record, auditResult, github }) {
  const snapshot = snapshotJson({ candidate, record, auditResult })
  const identity = validateCandidate(snapshot.candidate)
  const releaseRecord = parseReleaseRecord(snapshot.record)
  assertRecordIdentity(releaseRecord, identity)
  const audit = parseAuditResult(snapshot.auditResult)
  if (
    audit.version !== identity.version ||
    audit.commitSha !== identity.commitSha ||
    audit.manifestSha256 !== releaseRecord.manifestSha256 ||
    audit.conclusion !== "success"
  ) {
    throw new Error("Canonical audit result is not a successful exact-candidate receipt")
  }
  const auditBytes = canonicalAuditResultBytes(audit)
  const auditDigest = sha256(auditBytes)
  const effects = snapshotGitHubBoundary(github)
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  const release = await requireDraftRelease(effects.reader, identity)
  const marker = parseReleaseMarker(release.body)
  assertMarkerArtifactIdentity(marker, identity, releaseRecord)
  if (
    marker.phase !== "AUDIT_VERIFIED" ||
    marker.audit?.workflowRunId !== audit.workflowRunId ||
    marker.audit?.runAttempt !== audit.runAttempt ||
    marker.audit?.attemptSha256 !== auditDigest ||
    marker.audit?.canonicalSha256 !== auditDigest ||
    marker.audit?.conclusion !== "success"
  ) {
    throw new Error("Release publication requires the exact AUDIT_VERIFIED receipt")
  }
  const assets = await observePublicationAssets(effects.reader, release.id, marker, auditBytes)
  const result = await effects.writer.publishReleaseIfCurrent({
    releaseId: release.id,
    tag: marker.tag,
    targetSha: identity.commitSha,
    expectedBodySha256: releaseBodySha256(release.body),
    assets,
  })
  const published = await readManagedRelease(effects.reader, release.id)
  if (
    published.draft !== false ||
    published.immutable !== true ||
    published.body !== release.body ||
    published.name !== release.name ||
    parseReleaseMarker(published.body).phase !== "AUDIT_VERIFIED"
  ) {
    throw new Error("Published consolidated Release is not immutable and unchanged")
  }
  await verifyAnnotatedCandidateTag(effects.reader, identity)
  return deepFreeze({
    releaseId: release.id,
    phase: "AUDIT_COMPLETE",
    status: result.status,
    immutable: true,
    bodySha256: releaseBodySha256(published.body),
  })
}

function snapshotSmokeReconciliationInput(input) {
  const fields = [
    "candidate",
    "record",
    "manifest",
    "npmEvidence",
    "smokeResults",
    "workflowRunId",
    "runAttempt",
    "github",
  ]
  assertOwnDataFields(input, fields, "smoke reconciliation input")
  const rawResults = dataValue(input, "smokeResults")
  if (
    !Array.isArray(rawResults) ||
    Object.getPrototypeOf(rawResults) !== Array.prototype ||
    rawResults.length !== REQUIRED_RELEASE_SMOKE_LANES.length
  ) {
    throw new TypeError("Smoke reconciliation requires exactly five raw receipt byte sequences")
  }
  const expectedKeys = new Set(["length", ...rawResults.map((_value, index) => String(index))])
  if (
    Reflect.ownKeys(rawResults).some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    throw new TypeError("Smoke reconciliation receipt collection is sparse or contains fields")
  }
  let totalBytes = 0
  const smokeResults = rawResults.map((_value, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(rawResults, String(index))
    if (!isEnumerableData(descriptor) || !(descriptor.value instanceof Uint8Array)) {
      throw new TypeError("Smoke reconciliation accepts raw receipt bytes only")
    }
    const bytes = Buffer.from(descriptor.value)
    assertPayloadByteLength(
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes,
      `Smoke receipt ${index}`,
    )
    totalBytes += bytes.byteLength
    assertPayloadByteLength(totalBytes, RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes, "Smoke receipts")
    parseSmokeResult(bytes)
    return bytes
  })
  const workflowRunId = dataValue(input, "workflowRunId")
  const runAttempt = dataValue(input, "runAttempt")
  if (!isPositiveInteger(workflowRunId) || !isPositiveInteger(runAttempt)) {
    throw new TypeError("Smoke reconciliation trusted workflow run identity is invalid")
  }
  return Object.freeze({
    candidate: snapshotJson(dataValue(input, "candidate")),
    record: snapshotJson(dataValue(input, "record")),
    manifest: snapshotJson(dataValue(input, "manifest")),
    npmEvidence: snapshotJson(dataValue(input, "npmEvidence")),
    smokeResults: Object.freeze(smokeResults),
    workflowRunId,
    runAttempt,
    github: dataValue(input, "github"),
  })
}

async function observeExactSmokeActionsArtifacts({
  reader,
  marker,
  identity,
  workflowRunId,
  runAttempt,
  smokeResults,
}) {
  const run = await readGitHubValue(
    reader.getActionsRunAttempt({ runId: workflowRunId, attempt: runAttempt }),
    "actions-run-attempt",
  )
  if (
    !isRecord(run) ||
    positiveId(run.id, "Smoke workflow run ID") !== workflowRunId ||
    run.run_attempt !== runAttempt ||
    run.path !== SMOKE_WORKFLOW ||
    run.head_branch !== marker.tag ||
    run.head_sha !== identity.commitSha
  ) {
    throw new Error("Smoke workflow run attempt does not match the workflow, tag, or commit")
  }
  const listed = await readGitHubValue(
    reader.listActionsRunArtifacts({ runId: workflowRunId }),
    "actions-run-artifacts",
  )
  if (!Array.isArray(listed)) throw new Error("Smoke Actions artifact list is malformed")
  const selectedIds = new Set()
  let totalArchiveBytes = 0
  const locators = []
  for (const [index, lane] of REQUIRED_RELEASE_SMOKE_LANES.entries()) {
    const expectedName = smokeActionsArtifactName(lane, workflowRunId, runAttempt)
    const matches = listed.filter(
      (artifact) => isRecord(artifact) && artifact.name === expectedName,
    )
    if (matches.length !== 1) {
      throw new Error(`Smoke Actions artifact ${expectedName} is missing or duplicated`)
    }
    const artifactId = positiveId(matches[0].id, "Smoke Actions artifact ID")
    if (selectedIds.has(artifactId)) throw new Error("Smoke Actions artifact IDs are duplicated")
    selectedIds.add(artifactId)
    const artifact = await readGitHubValue(
      reader.getActionsArtifact({ artifactId }),
      "actions-artifact",
    )
    if (
      !isRecord(artifact) ||
      positiveId(artifact.id, "Smoke Actions artifact ID") !== artifactId ||
      artifact.name !== expectedName ||
      artifact.expired !== false ||
      typeof artifact.digest !== "string" ||
      !ACTIONS_DIGEST_PATTERN.test(artifact.digest) ||
      !isRecord(artifact.workflow_run) ||
      positiveId(artifact.workflow_run.id, "Smoke artifact workflow run ID") !== workflowRunId ||
      artifact.workflow_run.head_sha !== identity.commitSha ||
      artifact.workflow_run.head_branch !== marker.tag
    ) {
      throw new Error(`Smoke Actions artifact ${expectedName} metadata is not exact`)
    }
    const archive = await readActionsArtifactBytes(reader, artifactId)
    assertPayloadByteLength(
      archive.byteLength,
      RELEASE_PAYLOAD_LIMITS.smokeArchiveBytes,
      `Smoke Actions artifact ${expectedName}`,
    )
    totalArchiveBytes += archive.byteLength
    assertPayloadByteLength(
      totalArchiveBytes,
      RELEASE_PAYLOAD_LIMITS.smokeArchivesBytes,
      "Smoke Actions artifacts",
    )
    if (`sha256:${sha256(archive)}` !== artifact.digest) {
      throw new Error(`Smoke Actions artifact ${expectedName} service digest conflicts`)
    }
    const files = extractActionsArtifactZip(archive, {
      maxOutputBytes: RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes,
    })
    if (
      files.length !== 1 ||
      files[0].name !== `${lane}.json` ||
      !Buffer.from(files[0].bytes).equals(smokeResults[index])
    ) {
      throw new Error(`Smoke Actions artifact ${expectedName} receipt bytes conflict`)
    }
    locators.push({
      lane,
      actionsArtifactId: String(artifactId),
      actionsArtifactName: expectedName,
      actionsArtifactUrl: `https://github.com/${marker.attestationSet.repository}/actions/runs/${workflowRunId}/artifacts/${artifactId}`,
      actionsArtifactServiceDigest: artifact.digest,
    })
  }
  return deepFreeze(locators)
}

async function readActionsArtifactBytes(reader, artifactId) {
  const download = snapshotJson(
    await reader.downloadActionsArtifact({
      artifactId,
      maximumBytes: RELEASE_PAYLOAD_LIMITS.smokeArchiveBytes,
    }),
  )
  if (
    !hasExactFields(download, ["status", "operation", "httpStatus", "code", "contentBase64"]) ||
    download.status !== "PRESENT" ||
    download.operation !== "actions-artifact-download" ||
    download.httpStatus !== 200 ||
    download.code !== null ||
    typeof download.contentBase64 !== "string"
  ) {
    throw new Error("Smoke Actions artifact download is not exact")
  }
  const bytes = Buffer.from(download.contentBase64, "base64")
  if (bytes.toString("base64") !== download.contentBase64) {
    throw new Error("Smoke Actions artifact download base64 is noncanonical")
  }
  return bytes
}

async function observeSmokeReceiptAssets(reader, releaseId, marker, identity) {
  const listed = await readGitHubValue(reader.listReleaseAssets({ releaseId }), "release-assets")
  if (!Array.isArray(listed) || listed.length > BASE_ASSET_COUNT + MAX_SMOKE_ASSETS) {
    throw new Error("Smoke Release asset count is outside its bound")
  }
  const expectedBaseByName = new Map(markerBaseAssets(marker).map((asset) => [asset.name, asset]))
  const names = new Set()
  const ids = new Set()
  const observedBaseNames = new Set()
  const observedSmoke = []
  const attemptIdentities = new Set()
  const baseTotals = { base: 0, prepared: 0, bundles: 0, smoke: 0, audit: 0 }
  let totalSmokeBytes = 0
  for (const asset of listed) {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      !ASSET_NAME_PATTERN.test(asset.name)
    ) {
      throw new Error("Smoke Release asset identity is malformed")
    }
    const id = positiveId(asset.id, "Smoke Release asset ID")
    if (names.has(asset.name) || ids.has(id)) throw new Error("Smoke Release assets are duplicated")
    names.add(asset.name)
    ids.add(id)
    const expectedBase = expectedBaseByName.get(asset.name)
    if (expectedBase !== undefined) {
      const limits = publicationAssetLimits(asset.name, true, false)
      if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
        throw new Error("Smoke Release base asset declared size is invalid")
      }
      const bytes = await downloadExactReleaseAssetBytes(
        reader,
        id,
        asset.size,
        limits.maximumBytes,
        `Smoke Release base asset ${asset.name}`,
      )
      accountPublicationDownload(
        { name: asset.name, size: asset.size, ...limits },
        bytes,
        baseTotals,
      )
      if (sha256(bytes) !== expectedBase.sha256) {
        throw new Error("Smoke Release base asset bytes conflict with the canonical base set")
      }
      observedBaseNames.add(asset.name)
      continue
    }
    const parsedName = parseSmokeReleaseAssetName(asset.name)
    if (parsedName === null) throw new Error("Smoke Release asset namespace is unexpected")
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error("Smoke Release asset declared size is invalid")
    }
    assertPayloadByteLength(
      asset.size,
      RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes,
      `Smoke Release asset ${asset.name}`,
    )
    totalSmokeBytes += asset.size
    assertPayloadByteLength(
      totalSmokeBytes,
      RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes,
      "Smoke Release receipts",
    )
    const bytes = await downloadExactReleaseAssetBytes(
      reader,
      id,
      asset.size,
      RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes,
      `Smoke Release asset ${asset.name}`,
    )
    const receipt = parseSmokeResult(bytes)
    if (
      receipt.lane !== parsedName.lane ||
      receipt.workflowRunId !== parsedName.workflowRunId ||
      receipt.runAttempt !== parsedName.runAttempt ||
      receipt.version !== identity.version ||
      receipt.commitSha !== identity.commitSha ||
      receipt.manifestSha256 !== marker.manifestSha256 ||
      receipt.conclusion !== "success"
    ) {
      throw new Error("Smoke Release asset filename or candidate correlation conflicts")
    }
    const attemptIdentity = `${receipt.workflowRunId}:${receipt.runAttempt}`
    attemptIdentities.add(attemptIdentity)
    observedSmoke.push({
      lane: receipt.lane,
      workflowRunId: receipt.workflowRunId,
      runAttempt: receipt.runAttempt,
      releaseAssetId: id,
      releaseAssetName: asset.name,
      receiptSha256: sha256(bytes),
    })
  }
  if (observedBaseNames.size !== BASE_ASSET_COUNT) {
    throw new Error("Smoke Release base asset set is incomplete")
  }
  if (attemptIdentities.size > MAX_SMOKE_ATTEMPTS) {
    throw new Error("Smoke Release receipt attempt count is outside its bound")
  }
  observedSmoke.sort(compareSmokeReceiptAssets)
  return deepFreeze(observedSmoke)
}

async function downloadExactReleaseAssetBytes(reader, assetId, declaredSize, maximumBytes, label) {
  assertPayloadByteLength(declaredSize, maximumBytes, `${label} declared size`)
  const download = snapshotJson(
    await reader.downloadReleaseAsset({ assetId, maximumBytes: declaredSize }),
  )
  if (
    !hasExactFields(download, ["status", "operation", "httpStatus", "code", "contentBase64"]) ||
    download.status !== "PRESENT" ||
    download.operation !== "release-asset-download" ||
    download.httpStatus !== 200 ||
    download.code !== null ||
    typeof download.contentBase64 !== "string"
  ) {
    throw new Error(`${label} download is not exact`)
  }
  const bytes = Buffer.from(download.contentBase64, "base64")
  if (bytes.toString("base64") !== download.contentBase64 || bytes.byteLength !== declaredSize) {
    throw new Error(`${label} bytes or declared size conflict`)
  }
  return bytes
}

export function parseSmokeReleaseAssetName(name) {
  const match = SMOKE_ASSET_PATTERN.exec(name)
  if (match === null) return null
  const workflowRunId = Number(match[2])
  const runAttempt = Number(match[3])
  if (!isPositiveInteger(workflowRunId) || !isPositiveInteger(runAttempt)) return null
  return { lane: match[1], workflowRunId, runAttempt }
}

function smokeActionsArtifactName(lane, workflowRunId, runAttempt) {
  return `smoke-result-${lane}-${workflowRunId}-${runAttempt}`
}

function smokeReleaseAssetName(lane, workflowRunId, runAttempt) {
  return `${smokeActionsArtifactName(lane, workflowRunId, runAttempt)}.json`
}

function compareSmokeReceiptAssets(left, right) {
  return (
    left.workflowRunId - right.workflowRunId ||
    left.runAttempt - right.runAttempt ||
    compareText(left.lane, right.lane)
  )
}

function assertSelectedSmokeReplay(smoke, snapshot, aggregateSha256) {
  if (
    smoke.workflowRunId !== snapshot.workflowRunId ||
    smoke.runAttempt !== snapshot.runAttempt ||
    smoke.aggregateSha256 !== aggregateSha256
  ) {
    throw new Error("Existing smoke descriptor conflicts with the exact selected attempt")
  }
  for (const [index, artifact] of smoke.artifacts.entries()) {
    if (artifact.receiptSha256 !== sha256(snapshot.smokeResults[index])) {
      throw new Error(`Existing smoke receipt conflicts for lane ${artifact.lane}`)
    }
  }
}

function assertSmokeReceiptAssetSet(smoke, observedAssets) {
  if (canonicalJsonText(smoke.receiptAssets) !== canonicalJsonText(observedAssets)) {
    throw new Error("Release-hosted smoke receipt assets conflict with the marker descriptor")
  }
}

function snapshotEscrowInput(input) {
  if (!isPlainDataObject(input)) throw new TypeError("Escrow input is invalid")
  const fields = [
    "candidate",
    "record",
    "artifact",
    "attestationSet",
    "bundles",
    "publicationState",
    "attestations",
    "github",
  ]
  assertOwnDataFields(input, fields, "escrow input")
  const candidate = snapshotJson(dataValue(input, "candidate"))
  const record = snapshotJson(dataValue(input, "record"))
  const artifactValue = dataValue(input, "artifact")
  const artifact = snapshotArtifact(artifactValue)
  const attestationSet = snapshotJson(dataValue(input, "attestationSet"))
  const bundles = snapshotFiles(dataValue(input, "bundles"), "attestation bundle", {
    maximumItemBytes: RELEASE_PAYLOAD_LIMITS.attestationBundleBytes,
    maximumTotalBytes: RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
  })
  const publicationState = snapshotJson(dataValue(input, "publicationState"))
  const attestations = bindMethods(
    dataValue(input, "attestations"),
    ["verify"],
    "Attestation verifier",
  )
  const github = snapshotGitHubBoundary(dataValue(input, "github"))
  return {
    candidate,
    record,
    artifact,
    attestationSet,
    bundles,
    publicationState,
    attestations,
    github,
  }
}

async function verifyAttestationBundles({
  attestations,
  record,
  artifact,
  attestationSet,
  bundles,
  candidate,
  manifest,
}) {
  const parsed = parseAttestationSet(attestationSet, {
    candidate,
    manifest,
    repository: ATTESTATION_REPOSITORY,
  })
  const subjects = parsed.subjects.map(({ subjectName, subjectSha256 }) => ({
    name: subjectName,
    sha256: subjectSha256,
  }))
  const files = subjects.map(({ name }) => ({
    name,
    bytes: Buffer.from(fileBytes(artifact.files, name)),
  }))
  const orderedBundles = parsed.subjects.map(({ bundleName }) => ({
    name: bundleName,
    bytes: Buffer.from(fileBytes(bundles, bundleName)),
  }))
  const anchorBytes = orderedBundles[0]?.bytes
  if (
    !(anchorBytes instanceof Uint8Array) ||
    orderedBundles.some((bundle) => !Buffer.from(bundle.bytes).equals(anchorBytes))
  ) {
    throw new Error("Attestation bundle set must replicate one exact multi-subject bundle")
  }
  validateMultiSubjectAttestationBundle(anchorBytes, { manifest, attestationSet: parsed })
  let result
  try {
    result = snapshotJson(
      await attestations.verify({
        source: "escrow",
        record,
        subjects,
        files,
        bundles: orderedBundles,
      }),
    )
  } catch (error) {
    throw new Error(
      `Attestation bundle verification failed: ${attestationFailureReason(error?.message)}`,
      { cause: error },
    )
  }
  if (!isRecord(result) || result.status !== "VERIFIED") {
    // The verifier reports why gh (or the local membership proof) rejected the escrow:
    // exit code, signal/timeout, and redacted stderr. Run 33889526426 failed here with only
    // the bare "Attestation bundle verification failed" line.
    throw new Error(
      `Attestation bundle verification failed: ${attestationFailureReason(result?.reason)}`,
    )
  }
  if (
    !hasExactFields(result, ["status", "subjects"]) ||
    !Array.isArray(result.subjects) ||
    result.subjects.length !== subjects.length ||
    result.subjects.some(
      (subject, index) =>
        !hasExactFields(subject, ["name", "sha256"]) ||
        subject.name !== subjects[index].name ||
        subject.sha256 !== subjects[index].sha256,
    )
  ) {
    throw new Error("Attestation bundle verification did not prove all 22 subjects")
  }
}

const ATTESTATION_FAILURE_REASON_MAX_LENGTH = 2 * 1024 + 128
const ATTESTATION_FAILURE_REASON_REDACTIONS = Object.freeze([
  /gh[pous]_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /npm_[A-Za-z0-9]{20,}/gu,
  /Bearer\s+\S+/gu,
  /authorization:\s*\S+(?:\s+\S+)?/giu,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu,
])

/** Bounds and re-redacts a verifier-supplied reason before it reaches an Error message. */
function attestationFailureReason(value) {
  if (typeof value !== "string") return "(no reason)"
  let text = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character
  }).join("")
  for (const pattern of ATTESTATION_FAILURE_REASON_REDACTIONS) {
    text = text.replace(pattern, "[redacted]")
  }
  text = text.replace(/\s+/gu, " ").trim()
  if (text.length > ATTESTATION_FAILURE_REASON_MAX_LENGTH) {
    text = `${text.slice(0, ATTESTATION_FAILURE_REASON_MAX_LENGTH - 1)}…`
  }
  return text.length === 0 ? "(no reason)" : text
}

function validateMultiSubjectAttestationBundle(bytes, { manifest, attestationSet = null }) {
  let statement
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const bundle = JSON.parse(source)
    if (
      !isRecord(bundle) ||
      !isRecord(bundle.dsseEnvelope) ||
      bundle.dsseEnvelope.payloadType !== "application/vnd.in-toto+json" ||
      typeof bundle.dsseEnvelope.payload !== "string"
    ) {
      throw new Error("invalid attestation bundle")
    }
    const payload = Buffer.from(bundle.dsseEnvelope.payload, "base64")
    if (payload.length === 0 || payload.toString("base64") !== bundle.dsseEnvelope.payload) {
      throw new Error("invalid attestation payload")
    }
    statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))
  } catch (error) {
    throw new Error("Attestation bundle is not one valid DSSE JSON statement", { cause: error })
  }
  const expected = [
    { name: "manifest.json", sha256: sha256(canonicalManifestBytes(manifest)) },
    ...manifest.packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.sha256 })),
  ]
  if (
    !hasExactFields(statement, ["_type", "subject", "predicateType", "predicate"]) ||
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== expected.length ||
    statement.subject.some(
      (subject, index) =>
        !hasExactFields(subject, ["name", "digest"]) ||
        !hasExactFields(subject.digest, ["sha256"]) ||
        subject.name !== expected[index].name ||
        subject.digest.sha256 !== expected[index].sha256,
    )
  ) {
    throw new Error("Attestation bundle does not cover the exact ordered 22-subject set")
  }
  const invocationId = statement.predicate?.runDetails?.metadata?.invocationId
  const invocation =
    typeof invocationId === "string"
      ? /^https:\/\/github\.com\/cacheplane\/dawnai\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/u.exec(
          invocationId,
        )
      : null
  const workflowRunId = invocation === null ? null : Number(invocation[1])
  const runAttempt = invocation === null ? null : Number(invocation[2])
  if (
    !isPositiveInteger(workflowRunId) ||
    !isPositiveInteger(runAttempt) ||
    (attestationSet !== null &&
      (workflowRunId !== attestationSet.workflowRunId || runAttempt !== attestationSet.runAttempt))
  ) {
    throw new Error("Attestation bundle workflow run identity does not match preparation")
  }
  return { workflowRunId, runAttempt }
}

async function loadAttachingAssets({ reader, releaseId, preparedAssets, bundleNames }) {
  const listed = await readGitHubValue(reader.listReleaseAssets({ releaseId }), "release-assets")
  if (!Array.isArray(listed) || listed.length > 45) {
    throw new Error("GitHub Release attaching asset list is malformed")
  }
  const preparedByName = new Map(preparedAssets.map((asset) => [asset.name, asset]))
  const allowedBundles = new Set(bundleNames)
  const observed = new Map()
  const ids = new Set()
  let preparedBytes = 0
  let bundleBytes = 0
  let anchorBytes = null
  for (const asset of listed) {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      !ASSET_NAME_PATTERN.test(asset.name) ||
      !isPositiveInteger(asset.id) ||
      !isPositiveInteger(asset.size) ||
      observed.has(asset.name) ||
      ids.has(asset.id)
    ) {
      throw new Error("GitHub Release attaching asset identity is malformed")
    }
    const prepared = preparedByName.get(asset.name)
    const isBundle = allowedBundles.has(asset.name)
    if (prepared === undefined && !isBundle) {
      throw new Error("Unexpected Release attaching namespace member")
    }
    const maximumBytes = isBundle
      ? RELEASE_PAYLOAD_LIMITS.attestationBundleBytes
      : asset.name === "release-record.json"
        ? RELEASE_PAYLOAD_LIMITS.releaseRecordBytes
        : asset.name === "manifest.json"
          ? RELEASE_PAYLOAD_LIMITS.manifestBytes
          : RELEASE_PAYLOAD_LIMITS.tarballBytes
    if (asset.size > maximumBytes) throw new Error("Release attaching asset exceeds its byte bound")
    const bytes = await downloadExactReleaseAsset(reader, asset, maximumBytes)
    const digest = sha256(bytes)
    if (prepared !== undefined) {
      if (digest !== prepared.sha256) {
        throw new Error("Release prepared asset conflicts with the candidate")
      }
      preparedBytes += bytes.byteLength
      assertPayloadByteLength(
        preparedBytes,
        RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes,
        "Release prepared assets",
      )
    } else {
      bundleBytes += bytes.byteLength
      assertPayloadByteLength(
        bundleBytes,
        RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
        "Release attestation bundles",
      )
      if (anchorBytes !== null && !anchorBytes.equals(bytes)) {
        throw new Error("Release attaching assets mix different attestation anchors")
      }
      anchorBytes = Buffer.from(bytes)
    }
    observed.set(asset.name, { name: asset.name, bytes, sha256: digest })
    ids.add(asset.id)
  }
  return observed
}

async function downloadExactReleaseAsset(reader, asset, maximumBytes) {
  const download = snapshotJson(
    await reader.downloadReleaseAsset({ assetId: asset.id, maximumBytes: asset.size }),
  )
  if (
    !hasExactFields(download, ["status", "operation", "httpStatus", "code", "contentBase64"]) ||
    download.status !== "PRESENT" ||
    download.operation !== "release-asset-download" ||
    download.httpStatus !== 200 ||
    download.code !== null ||
    typeof download.contentBase64 !== "string"
  ) {
    throw new Error("Release asset download is not exact")
  }
  const bytes = Buffer.from(download.contentBase64, "base64")
  if (
    bytes.length !== asset.size ||
    bytes.length > maximumBytes ||
    bytes.toString("base64") !== download.contentBase64
  ) {
    throw new Error("Release asset bytes conflict with declared size or bound")
  }
  return bytes
}

function assertPreparedAssetsComplete(observed, preparedAssets) {
  if (preparedAssets.some((asset) => !observed.has(asset.name))) {
    throw new Error("Release attaching prepared asset set is incomplete")
  }
}

function firstObservedBundle(observed, bundleNames) {
  for (const name of bundleNames) {
    const asset = observed.get(name)
    if (asset !== undefined) return asset
  }
  return null
}

function materializePreparedReleaseAssets({
  observed,
  candidate,
  expectedRecord = null,
  expectedManifest,
}) {
  const recordAsset = observed.get("release-record.json")
  const manifestAsset = observed.get("manifest.json")
  if (recordAsset === undefined || manifestAsset === undefined) {
    throw new Error("Release prepared record or manifest is missing")
  }
  const record = parseReleaseRecord(recordAsset.bytes)
  const manifest = parseSealedReleaseManifest(manifestAsset.bytes, { candidate })
  if (
    !recordAsset.bytes.equals(canonicalReleaseRecordBytes(record)) ||
    !manifestAsset.bytes.equals(canonicalManifestBytes(manifest)) ||
    record.version !== candidate.version ||
    record.commitSha !== candidate.commitSha ||
    record.manifestSha256 !== sha256(manifestAsset.bytes) ||
    (expectedRecord !== null &&
      !canonicalReleaseRecordBytes(record).equals(canonicalReleaseRecordBytes(expectedRecord))) ||
    !canonicalManifestBytes(manifest).equals(canonicalManifestBytes(expectedManifest))
  ) {
    throw new Error("Release prepared record or manifest identity is invalid")
  }
  const files = [
    { name: "manifest.json", bytes: Buffer.from(manifestAsset.bytes) },
    ...manifest.packages.map((pkg) => {
      const asset = observed.get(pkg.filename)
      if (asset === undefined) throw new Error("Release prepared tarball set is incomplete")
      return { name: pkg.filename, bytes: Buffer.from(asset.bytes) }
    }),
  ]
  return { record, manifest, artifact: { manifest, files } }
}

async function verifyObservedBaseAssets({
  observed,
  base,
  candidate,
  attestations,
  attestationSet,
}) {
  const expectedByName = new Map(base.assets.map((asset) => [asset.name, asset]))
  if (
    observed.size !== expectedByName.size ||
    [...observed].some(([name, asset]) => expectedByName.get(name)?.sha256 !== asset.sha256)
  ) {
    throw new Error("Release escrow base assets do not exactly match their anchor")
  }
  const manifestAsset = observed.get("manifest.json")
  const expectedManifest = parseSealedReleaseManifest(manifestAsset.bytes, { candidate })
  const material = materializePreparedReleaseAssets({
    observed,
    candidate,
    expectedManifest,
  })
  const bundles = attestationSet.subjects.map(({ bundleName }) => ({
    name: bundleName,
    bytes: Buffer.from(observed.get(bundleName).bytes),
  }))
  await verifyAttestationBundles({
    attestations,
    record: material.record,
    artifact: material.artifact,
    attestationSet,
    bundles,
    candidate,
    manifest: material.manifest,
  })
  const reconstructed = canonicalBaseAssetSet({
    record: material.record,
    artifact: material.artifact,
    attestationSet,
    bundles,
  })
  if (reconstructed.sha256 !== base.sha256) {
    throw new Error("Release escrow base asset-set digest is not reproducible")
  }
}

async function loadReleaseBaseAssets({
  reader,
  releaseId,
  marker,
  manifest,
  candidate,
  attestations,
}) {
  const expected = markerBaseAssets(marker)
  const preparedAssets = expected.filter((asset) => !asset.name.endsWith(".intoto.jsonl"))
  const bundleNames = marker.attestationSet.subjects.map(({ bundleName }) => bundleName)
  const observed = await loadAttachingAssets({
    reader,
    releaseId,
    preparedAssets,
    bundleNames,
  })
  const base = {
    sha256: marker.baseAssetSetSha256,
    assets: expected,
  }
  await verifyObservedBaseAssets({
    observed,
    base,
    candidate,
    attestations,
    attestationSet: marker.attestationSet,
  })
  const recoveredManifest = parseSealedReleaseManifest(observed.get("manifest.json").bytes, {
    candidate,
  })
  if (!canonicalManifestBytes(recoveredManifest).equals(canonicalManifestBytes(manifest))) {
    throw new Error("Release escrow manifest changed during recovery")
  }
  return observed
}

function snapshotGitHubBoundary(value) {
  if (!isPlainDataObject(value)) throw new TypeError("GitHub effect boundary is invalid")
  const readerDescriptor = Object.getOwnPropertyDescriptor(value, "reader")
  const writerDescriptor = Object.getOwnPropertyDescriptor(value, "writer")
  if (!isEnumerableData(readerDescriptor) || !isEnumerableData(writerDescriptor)) {
    throw new TypeError("GitHub effect boundary contains accessors")
  }
  const reader = bindMethods(
    readerDescriptor.value,
    [
      "getRef",
      "getGitTag",
      "listReleases",
      "getRelease",
      "listReleaseAssets",
      "downloadReleaseAsset",
      "listActionsRunArtifacts",
      "getActionsRunAttempt",
      "getActionsArtifact",
      "downloadActionsArtifact",
    ],
    "GitHub reader",
  )
  const writer = bindMethods(
    writerDescriptor.value,
    [
      "createDraftRelease",
      "updateDraftReleaseIfCurrent",
      "uploadAssetIfAbsentAndEqual",
      "publishReleaseIfCurrent",
    ],
    "GitHub writer",
  )
  return Object.freeze({ reader, writer })
}

function bindMethods(value, methods, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const result = Object.create(null)
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method)
    if (!isEnumerableData(descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError(`${label} method ${method} is invalid`)
    }
    result[method] = descriptor.value.bind(value)
  }
  return Object.freeze(result)
}

async function findManagedRelease(reader, tag) {
  const releases = await readGitHubValue(reader.listReleases({}), "releases")
  if (!Array.isArray(releases)) throw new Error("GitHub Release list is malformed")
  const matches = releases.filter((release) => isManagedReleaseForTag(release, tag))
  if (matches.length > 1) throw new Error("Duplicate managed Releases are ambiguous")
  if (matches.length === 0) return null
  return readManagedRelease(reader, positiveId(matches[0].id, "Release ID"))
}

async function verifyAnnotatedCandidateTag(reader, candidate) {
  const tag = `v${candidate.version}`
  const ref = await readGitHubValue(reader.getRef({ ref: `tags/${tag}` }), "ref")
  if (
    !isRecord(ref.object) ||
    ref.object.type !== "tag" ||
    typeof ref.object.sha !== "string" ||
    !SHA_PATTERN.test(ref.object.sha)
  ) {
    throw new Error("Candidate tag must remain one annotated Git tag object")
  }
  const annotated = await readGitHubValue(reader.getGitTag({ tagSha: ref.object.sha }), "git-tag")
  if (
    annotated.tag !== tag ||
    !isRecord(annotated.object) ||
    annotated.object.type !== "commit" ||
    annotated.object.sha !== candidate.commitSha
  ) {
    throw new Error("Annotated candidate tag no longer peels to the target commit")
  }
}

async function readManagedRelease(reader, releaseId) {
  const release = await readGitHubValue(reader.getRelease({ releaseId }), "release")
  if (!isRecord(release) || positiveId(release.id, "Release ID") !== releaseId) {
    throw new Error("Managed GitHub Release response is malformed")
  }
  return release
}

async function requireDraftRelease(reader, candidate) {
  const release = await findManagedRelease(reader, `v${candidate.version}`)
  if (release === null) throw new Error("Managed draft Release is missing")
  assertMutableCandidateRelease(release, `Dawn v${candidate.version}`)
  return release
}

async function readGitHubValue(promise, operation) {
  const envelope = await promise
  const snapshot = snapshotJson(envelope)
  if (
    !hasExactFields(snapshot, ["status", "operation", "httpStatus", "code", "value"]) ||
    snapshot.status !== "PRESENT" ||
    snapshot.operation !== operation ||
    !Number.isInteger(snapshot.httpStatus) ||
    snapshot.httpStatus < 200 ||
    snapshot.httpStatus >= 300 ||
    snapshot.code !== null
  ) {
    throw new Error(`GitHub ${operation} observation is not exact`)
  }
  return snapshot.value
}

async function observePublicationAssets(reader, releaseId, marker, auditBytes) {
  const listed = await readGitHubValue(reader.listReleaseAssets({ releaseId }), "release-assets")
  const descriptors = preflightPublicationAssetMetadata(listed, { marker })
  const assets = []
  const auditAssets = []
  const totals = { base: 0, prepared: 0, bundles: 0, smoke: 0, audit: 0 }
  for (const descriptor of descriptors) {
    const download = snapshotJson(
      await reader.downloadReleaseAsset({
        assetId: descriptor.id,
        maximumBytes: descriptor.size,
      }),
    )
    if (
      !hasExactFields(download, ["status", "operation", "httpStatus", "code", "contentBase64"]) ||
      download.status !== "PRESENT" ||
      download.operation !== "release-asset-download" ||
      download.httpStatus !== 200 ||
      download.code !== null ||
      typeof download.contentBase64 !== "string"
    ) {
      throw new Error("Published Release asset bytes are not exact")
    }
    const bytes = Buffer.from(download.contentBase64, "base64")
    if (bytes.toString("base64") !== download.contentBase64) {
      throw new Error("Published Release asset base64 is noncanonical")
    }
    accountPublicationDownload(descriptor, bytes, totals)
    const digest = sha256(bytes)
    if (descriptor.expectedSha256 !== null && digest !== descriptor.expectedSha256) {
      throw new Error("Published Release base asset digest conflicts with its marker")
    }
    assets.push({ name: descriptor.name, sha256: digest })
    if (descriptor.group === "audit") {
      auditAssets.push({ name: descriptor.name, bytes })
    }
  }
  validatePublicationAuditAssets(auditAssets, { marker })
  const attemptBytes = auditAssets.find(({ name }) => name === marker.audit.attemptAssetName)?.bytes
  const canonicalBytes = auditAssets.find(({ name }) => name === "audit-result.json")?.bytes
  if (
    attemptBytes === undefined ||
    canonicalBytes === undefined ||
    !attemptBytes.equals(auditBytes) ||
    !canonicalBytes.equals(auditBytes) ||
    sha256(attemptBytes) !== marker.audit.attemptSha256 ||
    sha256(canonicalBytes) !== marker.audit.canonicalSha256
  ) {
    throw new Error("Canonical audit asset is not byte-identical to its successful attempt")
  }
  return deepFreeze(assets.sort((left, right) => compareText(left.name, right.name)))
}

function accountPublicationDownload(descriptor, bytes, totals) {
  if (bytes.byteLength !== descriptor.size) {
    throw new Error("Published Release asset bytes conflict with their declared size")
  }
  assertPayloadByteLength(bytes.byteLength, descriptor.maximumBytes, `${descriptor.name} download`)
  if (descriptor.group === "audit") {
    totals.audit = addPublicationBytes(
      totals.audit,
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.auditEvidenceBytes,
      "Downloaded publication audit evidence",
    )
    return
  }
  if (descriptor.group === "smoke") {
    totals.smoke = addPublicationBytes(
      totals.smoke,
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.smokeReceiptsBytes,
      "Downloaded publication smoke receipts",
    )
    return
  }
  totals.base = addPublicationBytes(
    totals.base,
    bytes.byteLength,
    RELEASE_PAYLOAD_LIMITS.escrowBytes,
    "Downloaded publication base assets",
  )
  if (descriptor.group === "prepared") {
    totals.prepared = addPublicationBytes(
      totals.prepared,
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes,
      "Downloaded publication prepared assets",
    )
  } else if (descriptor.group === "bundles") {
    totals.bundles = addPublicationBytes(
      totals.bundles,
      bytes.byteLength,
      RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes,
      "Downloaded publication attestation bundles",
    )
  }
}

function markerBaseAssets(marker) {
  const assets = [
    { name: "release-record.json", sha256: marker.releaseRecordSha256 },
    { name: "manifest.json", sha256: marker.manifestSha256 },
    ...marker.attestationSet.subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...marker.attestationSet.subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  if (assets.length !== 45 || new Set(assets.map(({ name }) => name)).size !== 45) {
    throw new Error("Published Release base asset set is invalid")
  }
  const digest = sha256(
    Buffer.from(
      `${JSON.stringify(assets.map(({ name, sha256: assetSha256 }) => ({ name, sha256: assetSha256 })))}\n`,
      "utf8",
    ),
  )
  if (digest !== marker.baseAssetSetSha256) {
    throw new Error("Published Release base asset-set digest conflicts with its marker")
  }
  return assets
}

function publicationAssetLimits(name, isBaseAsset, isSmokeAsset) {
  if (isSmokeAsset) {
    return { group: "smoke", maximumBytes: RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes }
  }
  if (!isBaseAsset) {
    if (
      name === "audit-result.json" ||
      /^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(name)
    ) {
      return { group: "audit", maximumBytes: RELEASE_PAYLOAD_LIMITS.auditReceiptBytes }
    }
    throw new TypeError("Publication asset namespace contains an unexpected member")
  }
  if (name === "release-record.json") {
    return { group: "record", maximumBytes: RELEASE_PAYLOAD_LIMITS.releaseRecordBytes }
  }
  if (name === "manifest.json") {
    return { group: "prepared", maximumBytes: RELEASE_PAYLOAD_LIMITS.manifestBytes }
  }
  if (name.endsWith(".tgz")) {
    return { group: "prepared", maximumBytes: RELEASE_PAYLOAD_LIMITS.tarballBytes }
  }
  if (name === "manifest.json.intoto.jsonl" || name.endsWith(".tgz.intoto.jsonl")) {
    return { group: "bundles", maximumBytes: RELEASE_PAYLOAD_LIMITS.attestationBundleBytes }
  }
  throw new TypeError("Publication base asset namespace is invalid")
}

function addPublicationBytes(current, size, maximum, label) {
  const total = current + size
  assertPayloadByteLength(total, maximum, label)
  return total
}

function assertMutableCandidateRelease(release, title) {
  if (
    release.target_commitish !== "main" ||
    release.prerelease !== false ||
    release.name !== title ||
    typeof release.body !== "string" ||
    release.draft !== true ||
    release.immutable !== false
  ) {
    throw new Error("Managed Release is not the exact mutable candidate draft")
  }
}

function assertEscrowMarkerMatches(actual, expected, { candidate, manifest }) {
  if (
    !["ATTACHING", "ESCROWED"].includes(actual.phase) ||
    actual.version !== expected.version ||
    actual.commitSha !== expected.commitSha ||
    actual.tag !== expected.tag ||
    actual.manifestSha256 !== expected.manifestSha256 ||
    actual.releaseRecordSha256 !== expected.releaseRecordSha256 ||
    actual.npmEvidenceSha256 !== null ||
    actual.smoke !== null ||
    actual.audit !== null ||
    actual.abandonmentSha256 !== null
  ) {
    throw new Error("Existing Release escrow marker conflicts with the candidate")
  }
  if (actual.phase === "ATTACHING") {
    if (actual.baseAssetSetSha256 !== null || actual.attestationSet !== null) {
      throw new Error("Existing attaching marker contains a premature attestation anchor")
    }
    return
  }
  parseAttestationSet(actual.attestationSet, {
    candidate,
    manifest,
    repository: ATTESTATION_REPOSITORY,
  })
  markerBaseAssets(actual)
}

function assertRecordIdentity(record, candidate) {
  if (record.version !== candidate.version || record.commitSha !== candidate.commitSha) {
    throw new Error("Release record identity does not match the candidate")
  }
}

function assertMarkerArtifactIdentity(marker, candidate, record) {
  if (
    marker.version !== candidate.version ||
    marker.commitSha !== candidate.commitSha ||
    marker.tag !== `v${candidate.version}` ||
    marker.manifestSha256 !== record.manifestSha256 ||
    marker.releaseRecordSha256 !== releaseRecordSha256(record)
  ) {
    throw new Error("Managed Release marker artifact identity conflicts with the candidate")
  }
}

function normalizeNpmEvidence(value, candidate, record, manifest) {
  const context = { candidate, manifestSha256: record.manifestSha256, manifest }
  const evidence = parseNpmEvidence(value, context)
  return deepFreeze({
    evidence,
    sha256: sha256(canonicalNpmEvidenceBytes(evidence, context)),
  })
}

function transitionResult(release, marker, status) {
  return deepFreeze({
    releaseId: positiveId(release.id, "Release ID"),
    phase: marker.phase,
    status,
    bodySha256: releaseBodySha256(release.body),
  })
}

function positiveId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`)
  return value
}

function dataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!isEnumerableData(descriptor)) throw new TypeError("Input contains an accessor field")
  return descriptor.value
}

export function validateMarker(value) {
  const marker = snapshotJson(value)
  assertExactFields(marker, MARKER_FIELDS, "release marker")
  if (
    marker.schemaVersion !== 1 ||
    marker.epoch !== "fixed-group-v1" ||
    !isPositiveInteger(marker.revision) ||
    !PHASES.includes(marker.phase) ||
    !isReleaseVersion(marker.version) ||
    !SHA_PATTERN.test(marker.commitSha) ||
    marker.tag !== `v${marker.version}`
  ) {
    throw new TypeError("Release marker identity, revision, or phase is invalid")
  }
  const artifactFields = [
    marker.manifestSha256,
    marker.releaseRecordSha256,
    marker.baseAssetSetSha256,
    marker.attestationSet,
  ]
  if (marker.phase === "ATTACHING") {
    if (
      !SHA256_PATTERN.test(marker.manifestSha256) ||
      !SHA256_PATTERN.test(marker.releaseRecordSha256) ||
      marker.baseAssetSetSha256 !== null ||
      marker.attestationSet !== null
    ) {
      throw new TypeError("Attaching Release marker artifact fields are invalid")
    }
  } else if (marker.phase === "ABANDONED_PREPUBLICATION") {
    validateAbandonedArtifactShape(artifactFields)
  } else if (
    !SHA256_PATTERN.test(marker.manifestSha256) ||
    !SHA256_PATTERN.test(marker.releaseRecordSha256) ||
    !SHA256_PATTERN.test(marker.baseAssetSetSha256) ||
    !isRecord(marker.attestationSet)
  ) {
    throw new TypeError("Release marker artifact fields are invalid for its phase")
  }
  validateMarkerEvidence(marker)
  if (marker.attestationSet !== null) validateEmbeddedAttestation(marker.attestationSet, marker)
  return deepFreeze(marker)
}

function validateMarkerTransition(previous, next) {
  if (
    next.revision !== previous.revision + 1 ||
    !PHASE_TRANSITIONS[previous.phase].includes(next.phase)
  ) {
    throw new TypeError("Release marker revision or phase transition is invalid or backward")
  }
  const immutableFields = [
    "schemaVersion",
    "epoch",
    "version",
    "commitSha",
    "tag",
    "manifestSha256",
    "releaseRecordSha256",
  ]
  for (const field of immutableFields) {
    if (canonicalJsonText(previous[field]) !== canonicalJsonText(next[field])) {
      throw new TypeError("Release marker transition changed immutable candidate evidence")
    }
  }
  const anchorsMayBeEstablished = previous.phase === "ATTACHING" && next.phase === "ESCROWED"
  for (const field of ["baseAssetSetSha256", "attestationSet"]) {
    if (
      !anchorsMayBeEstablished &&
      canonicalJsonText(previous[field]) !== canonicalJsonText(next[field])
    ) {
      throw new TypeError("Release marker transition changed immutable candidate evidence")
    }
  }
  if (
    (previous.npmEvidenceSha256 !== null &&
      previous.npmEvidenceSha256 !== next.npmEvidenceSha256) ||
    (previous.smoke !== null && canonicalJsonText(previous.smoke) !== canonicalJsonText(next.smoke))
  ) {
    throw new TypeError("Release marker transition erased or replaced reconciled evidence")
  }
  if (
    previous.phase === "AUDIT_DISPATCHED" &&
    !sameAuditDispatchIdentity(previous.audit, next.audit)
  ) {
    throw new TypeError("Release marker audit result changed its dispatch identity")
  }
  if (
    previous.phase === "AUDIT_RETRYABLE" &&
    previous.audit.workflowRunId === next.audit.workflowRunId
  ) {
    throw new TypeError("Release marker audit retry requires a new dispatch identity")
  }
}

function sameAuditDispatchIdentity(previous, next) {
  return ["workflow", "workflowRunId", "runUrl", "htmlUrl"].every(
    (field) => previous[field] === next[field],
  )
}

function canonicalJsonText(value) {
  return JSON.stringify(canonicalize(value))
}

function validateMarkerEvidence(marker) {
  const npmRequired = [
    "NPM_COMPLETE",
    "SMOKES_COMPLETE",
    "AUDIT_DISPATCHED",
    "AUDIT_RETRYABLE",
    "AUDIT_VERIFIED",
  ].includes(marker.phase)
  const smokeRequired = [
    "SMOKES_COMPLETE",
    "AUDIT_DISPATCHED",
    "AUDIT_RETRYABLE",
    "AUDIT_VERIFIED",
  ].includes(marker.phase)
  const auditRequired = ["AUDIT_DISPATCHED", "AUDIT_RETRYABLE", "AUDIT_VERIFIED"].includes(
    marker.phase,
  )
  if (npmRequired ? !isSha256(marker.npmEvidenceSha256) : marker.npmEvidenceSha256 !== null) {
    throw new TypeError("Release marker npm evidence is invalid for its phase")
  }
  if (smokeRequired) {
    validateSmokeDescriptor(marker.smoke, marker)
  } else if (marker.smoke !== null) {
    throw new TypeError("Release marker smoke evidence is invalid for its phase")
  }
  if (auditRequired) validateAuditMarker(marker.audit, marker)
  else if (marker.audit !== null)
    throw new TypeError("Release marker audit is invalid for its phase")
  if (marker.phase === "ABANDONED_PREPUBLICATION") {
    if (!isSha256(marker.abandonmentSha256)) {
      throw new TypeError("Abandoned Release marker requires abandonment evidence")
    }
  } else if (marker.abandonmentSha256 !== null) {
    throw new TypeError("Only abandonment may contain abandonment evidence")
  }
}

function validateSmokeDescriptor(value, marker) {
  assertExactFields(value, SMOKE_FIELDS, "Release smoke descriptor")
  if (
    value.workflow !== SMOKE_WORKFLOW ||
    !isPositiveInteger(value.workflowRunId) ||
    !isPositiveInteger(value.runAttempt) ||
    !Array.isArray(value.requiredLanes) ||
    canonicalJsonText(value.requiredLanes) !== canonicalJsonText(REQUIRED_RELEASE_SMOKE_LANES) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== REQUIRED_RELEASE_SMOKE_LANES.length ||
    !Array.isArray(value.receiptAssets) ||
    value.receiptAssets.length < REQUIRED_RELEASE_SMOKE_LANES.length ||
    value.receiptAssets.length > MAX_SMOKE_ASSETS ||
    !isSha256(value.aggregateSha256)
  ) {
    throw new TypeError("Release smoke descriptor identity or bounded shape is invalid")
  }
  const receiptNames = new Set()
  const receiptIds = new Set()
  let previousReceipt = null
  const selectedReceipts = new Map()
  for (const [index, receipt] of value.receiptAssets.entries()) {
    assertExactFields(receipt, SMOKE_RECEIPT_ASSET_FIELDS, `Release smoke receipt asset ${index}`)
    const parsedName = parseSmokeReleaseAssetName(receipt.releaseAssetName)
    if (
      !REQUIRED_RELEASE_SMOKE_LANES.includes(receipt.lane) ||
      !isPositiveInteger(receipt.workflowRunId) ||
      !isPositiveInteger(receipt.runAttempt) ||
      !isPositiveInteger(receipt.releaseAssetId) ||
      parsedName === null ||
      parsedName.lane !== receipt.lane ||
      parsedName.workflowRunId !== receipt.workflowRunId ||
      parsedName.runAttempt !== receipt.runAttempt ||
      !isSha256(receipt.receiptSha256) ||
      receiptNames.has(receipt.releaseAssetName) ||
      receiptIds.has(receipt.releaseAssetId) ||
      (previousReceipt !== null && compareSmokeReceiptAssets(previousReceipt, receipt) >= 0)
    ) {
      throw new TypeError("Release smoke receipt asset identity or ordering is invalid")
    }
    receiptNames.add(receipt.releaseAssetName)
    receiptIds.add(receipt.releaseAssetId)
    previousReceipt = receipt
    if (receipt.workflowRunId === value.workflowRunId && receipt.runAttempt === value.runAttempt) {
      selectedReceipts.set(receipt.lane, receipt)
    }
  }
  if (selectedReceipts.size !== REQUIRED_RELEASE_SMOKE_LANES.length) {
    throw new TypeError("Release smoke selected receipt attempt is incomplete")
  }
  const actionIds = new Set()
  for (const [index, artifact] of value.artifacts.entries()) {
    assertExactFields(artifact, SMOKE_ARTIFACT_FIELDS, `Release smoke artifact ${index}`)
    const lane = REQUIRED_RELEASE_SMOKE_LANES[index]
    const selected = selectedReceipts.get(lane)
    const actionsName = smokeActionsArtifactName(lane, value.workflowRunId, value.runAttempt)
    if (
      artifact.lane !== lane ||
      typeof artifact.actionsArtifactId !== "string" ||
      !DECIMAL_ID_PATTERN.test(artifact.actionsArtifactId) ||
      !Number.isSafeInteger(Number(artifact.actionsArtifactId)) ||
      actionIds.has(artifact.actionsArtifactId) ||
      artifact.actionsArtifactName !== actionsName ||
      artifact.actionsArtifactUrl !==
        `https://github.com/${marker.attestationSet.repository}/actions/runs/${value.workflowRunId}/artifacts/${artifact.actionsArtifactId}` ||
      typeof artifact.actionsArtifactServiceDigest !== "string" ||
      !ACTIONS_DIGEST_PATTERN.test(artifact.actionsArtifactServiceDigest) ||
      artifact.releaseAssetId !== selected.releaseAssetId ||
      artifact.releaseAssetName !== selected.releaseAssetName ||
      artifact.receiptSha256 !== selected.receiptSha256
    ) {
      throw new TypeError("Release smoke artifact locator identity is invalid")
    }
    actionIds.add(artifact.actionsArtifactId)
  }
  return deepFreeze(value)
}

function validateAuditMarker(audit, marker) {
  assertExactFields(audit, AUDIT_FIELDS, "Release audit marker")
  const repository = marker.attestationSet?.repository
  const id = audit.workflowRunId
  if (
    audit.workflow !== AUDIT_WORKFLOW ||
    !isPositiveInteger(id) ||
    audit.runUrl !== `https://api.github.com/repos/${repository}/actions/runs/${id}` ||
    audit.htmlUrl !== `https://github.com/${repository}/actions/runs/${id}`
  ) {
    throw new TypeError("Release audit dispatch identity is invalid")
  }
  if (marker.phase === "AUDIT_DISPATCHED") {
    if (
      audit.runAttempt !== null ||
      audit.attemptAssetName !== null ||
      audit.attemptSha256 !== null ||
      audit.canonicalSha256 !== null ||
      audit.conclusion !== null
    ) {
      throw new TypeError("Dispatched audit marker contains result evidence")
    }
    return
  }
  if (
    !isPositiveInteger(audit.runAttempt) ||
    audit.attemptAssetName !== `audit-attempt-${id}-${audit.runAttempt}.json` ||
    !isSha256(audit.attemptSha256)
  ) {
    throw new TypeError("Release audit attempt identity is invalid")
  }
  if (marker.phase === "AUDIT_RETRYABLE") {
    if (audit.canonicalSha256 !== null || audit.conclusion !== "failure") {
      throw new TypeError("Retryable audit marker is invalid")
    }
  } else if (audit.canonicalSha256 !== audit.attemptSha256 || audit.conclusion !== "success") {
    throw new TypeError("Verified audit marker is invalid")
  }
}

function validateEmbeddedAttestation(attestation, marker) {
  assertExactFields(attestation, ATTESTATION_FIELDS, "attestation set")
  if (
    attestation.repository !== ATTESTATION_REPOSITORY ||
    attestation.workflow !== ".github/workflows/release.yml" ||
    attestation.sourceRef !== `refs/tags/${marker.tag}` ||
    attestation.commitSha !== marker.commitSha ||
    !isPositiveInteger(attestation.workflowRunId) ||
    !isPositiveInteger(attestation.runAttempt) ||
    !Array.isArray(attestation.subjects) ||
    attestation.subjects.length !== 22
  ) {
    throw new TypeError("Embedded attestation identity is invalid")
  }
  const names = new Set()
  let bundleSha256 = null
  for (const subject of attestation.subjects) {
    assertExactFields(subject, SUBJECT_FIELDS, "attestation subject")
    if (
      !ASSET_NAME_PATTERN.test(subject.subjectName) ||
      !isSha256(subject.subjectSha256) ||
      subject.bundleName !== `${subject.subjectName}.intoto.jsonl` ||
      !isSha256(subject.bundleSha256) ||
      (bundleSha256 !== null && subject.bundleSha256 !== bundleSha256) ||
      names.has(subject.subjectName)
    ) {
      throw new TypeError("Embedded attestation subject is invalid")
    }
    names.add(subject.subjectName)
    bundleSha256 = subject.bundleSha256
  }
}

function validateAbandonedArtifactShape([manifestDigest, recordDigest, baseDigest, attestation]) {
  const taggedOnly = [manifestDigest, recordDigest, baseDigest, attestation].every(
    (value) => value === null,
  )
  const prepared =
    isSha256(manifestDigest) &&
    isSha256(recordDigest) &&
    baseDigest === null &&
    attestation === null
  const attested =
    isSha256(manifestDigest) &&
    isSha256(recordDigest) &&
    isSha256(baseDigest) &&
    isRecord(attestation)
  if (!taggedOnly && !prepared && !attested) {
    throw new TypeError("Abandoned Release marker artifact context is invalid")
  }
}

export function validateAllAttemptJobs(jobs, currentAttempt) {
  const attempts = new Set()
  const identities = new Set()
  const publisherJobsByAttempt = new Map()
  let previousAttempt = 0
  let previousId = 0
  for (const [index, job] of jobs.entries()) {
    assertExactFields(job, JOB_FIELDS, `candidate job ${index}`)
    if (
      !isPositiveInteger(job.id) ||
      !isPositiveInteger(job.runAttempt) ||
      job.runAttempt > currentAttempt ||
      typeof job.name !== "string" ||
      job.name.length === 0 ||
      typeof job.status !== "string" ||
      job.status.length === 0 ||
      !(job.conclusion === null || typeof job.conclusion === "string") ||
      !isNullableTimestamp(job.startedAt) ||
      !isNullableTimestamp(job.completedAt)
    ) {
      throw new TypeError("Candidate job schema or attempt identity is invalid")
    }
    const terminal = job.status === "completed"
    if (
      terminal !== (job.conclusion !== null) ||
      terminal !== (job.completedAt !== null) ||
      (job.completedAt !== null && job.startedAt === null)
    ) {
      throw new TypeError("Candidate job terminal timestamps or conclusion are incoherent")
    }
    if (
      job.runAttempt < previousAttempt ||
      (job.runAttempt === previousAttempt && job.id <= previousId)
    ) {
      throw new TypeError("Candidate jobs must be stably ordered by attempt then ID")
    }
    const identity = `${job.runAttempt}:${job.id}`
    if (identities.has(identity)) throw new TypeError("Duplicate candidate attempt/job identity")
    if (job.name === "publish-npm") {
      const count = publisherJobsByAttempt.get(job.runAttempt) ?? 0
      publisherJobsByAttempt.set(job.runAttempt, count + 1)
      if (publisherJobExecuted(job)) {
        throw new Error("A publish-npm job already started before escrow")
      }
    }
    previousAttempt = job.runAttempt
    previousId = job.id
    identities.add(identity)
    attempts.add(job.runAttempt)
  }
  if (attempts.size !== currentAttempt)
    throw new TypeError("Candidate job attempt coverage is incomplete")
  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    if (publisherJobsByAttempt.get(attempt) !== 1) {
      throw new TypeError("Candidate attempt must contain exactly one publish-npm job")
    }
  }
}

function publisherJobExecuted(job) {
  if (job.status === "completed" && job.conclusion === "skipped") {
    if (job.startedAt === null || job.completedAt === null) {
      throw new TypeError("Skipped publish-npm job timestamps are incomplete")
    }
    return false
  }
  return job.startedAt !== null
}

function assertAttestationRunAuthorized(attestationSet, publicationState) {
  const matchingRuns = publicationState.candidateRuns.filter(
    (run) =>
      run.runId === attestationSet.workflowRunId && run.runAttempt === attestationSet.runAttempt,
  )
  if (matchingRuns.length !== 1) {
    throw new Error("Attestation workflow run is not an exact enumerated authorized release run")
  }
}

function snapshotArtifact(value) {
  if (!isPlainDataObject(value)) throw new TypeError("Release artifact must be a plain object")
  assertOwnDataFields(value, ["manifest", "files"], "release artifact")
  const manifestDescriptor = Object.getOwnPropertyDescriptor(value, "manifest")
  const filesDescriptor = Object.getOwnPropertyDescriptor(value, "files")
  return {
    manifest: snapshotJson(manifestDescriptor.value),
    files: snapshotFiles(filesDescriptor.value, "artifact file", {
      maximumItemBytes: RELEASE_PAYLOAD_LIMITS.tarballBytes,
      maximumTotalBytes: RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes,
    }),
  }
}

function snapshotFiles(value, label, { maximumItemBytes, maximumTotalBytes } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} collection is invalid`)
  }
  const expectedKeys = new Set(["length", ...value.map((_entry, index) => String(index))])
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    throw new TypeError(`${label} collection is sparse or contains unknown fields`)
  }
  let totalBytes = 0
  return value.map((_entry, index) => {
    const itemDescriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!isEnumerableData(itemDescriptor) || !isPlainDataObject(itemDescriptor.value)) {
      throw new TypeError(`${label} ${index} is invalid`)
    }
    const item = itemDescriptor.value
    assertOwnDataFields(item, ["name", "bytes"], `${label} ${index}`)
    const name = Object.getOwnPropertyDescriptor(item, "name").value
    const bytes = Object.getOwnPropertyDescriptor(item, "bytes").value
    if (typeof name !== "string" || !ASSET_NAME_PATTERN.test(name)) {
      throw new TypeError(`${label} ${index} name is invalid`)
    }
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} ${index} bytes are invalid`)
    if (maximumItemBytes !== undefined) {
      assertPayloadByteLength(bytes.byteLength, maximumItemBytes, `${label} ${index}`)
    }
    totalBytes += bytes.byteLength
    if (
      !Number.isSafeInteger(totalBytes) ||
      (maximumTotalBytes !== undefined && totalBytes > maximumTotalBytes)
    ) {
      throw new TypeError(`${label} collection exceeds its cumulative byte limit`)
    }
    return { name, bytes: Buffer.from(bytes) }
  })
}

function parseCanonicalAuditResultBytes(bytes) {
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError("Audit receipt JSON is malformed", { cause: error })
  }
  const result = parseAuditResult(value)
  if (!Buffer.from(bytes).equals(canonicalAuditResultBytes(result))) {
    throw new TypeError("Audit receipt bytes are not canonical")
  }
  return result
}

function assertExactNamedSet(files, expectedNames, label) {
  if (files.length !== expectedNames.length) throw new Error(`${label} set is incomplete`)
  const actualNames = files.map(({ name }) => name)
  if (
    new Set(actualNames).size !== actualNames.length ||
    [...actualNames].sort(compareText).join("\0") !==
      [...expectedNames].sort(compareText).join("\0")
  ) {
    throw new Error(`${label} set is incomplete, duplicate, or unexpected`)
  }
}

function fileBytes(files, name) {
  const file = files.find((entry) => entry.name === name)
  if (file === undefined) throw new Error(`Required file ${name} is missing`)
  return file.bytes
}

function inventoryPackageNames(inventory) {
  if (
    !isRecord(inventory) ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length !== 21
  ) {
    throw new TypeError("Publication inventory must contain exactly 21 packages")
  }
  const names = inventory.packages.map((pkg) => {
    if (!isRecord(pkg) || typeof pkg.name !== "string" || !PACKAGE_NAME_PATTERN.test(pkg.name)) {
      throw new TypeError("Publication inventory package name is invalid")
    }
    return pkg.name
  })
  if (new Set(names).size !== names.length) {
    throw new TypeError("Publication inventory contains duplicate packages")
  }
  return names
}

function validateCandidate(value, { policyFieldsOptional = false } = {}) {
  if (!isRecord(value)) throw new TypeError("Candidate identity is invalid")
  const expected = policyFieldsOptional ? ["version", "commitSha"] : CANDIDATE_FIELDS
  if (policyFieldsOptional) {
    const actual = Object.keys(value)
    if (
      !actual.every((key) => CANDIDATE_FIELDS.includes(key)) ||
      !expected.every((key) => actual.includes(key))
    ) {
      throw new TypeError("Candidate identity has invalid fields")
    }
  } else {
    assertExactFields(value, expected, "candidate identity")
  }
  if (!isReleaseVersion(value.version) || !SHA_PATTERN.test(value.commitSha)) {
    throw new TypeError("Candidate identity is invalid")
  }
  if (
    !policyFieldsOptional &&
    (value.ciWorkflow !== "CI" ||
      value.ciCheck !== "validate" ||
      value.publisherWorkflow !== ".github/workflows/release.yml")
  ) {
    throw new TypeError("Candidate policy identity is invalid")
  }
  return value
}

function assertExactFields(value, fields, label) {
  if (!isRecord(value) || !hasExactFields(value, fields)) {
    throw new TypeError(`${label} has an invalid exact-key schema`)
  }
}

function hasExactFields(value, fields, optional = []) {
  if (!isRecord(value)) return false
  const allowed = new Set([...fields, ...optional])
  const keys = Object.keys(value)
  return fields.every((field) => keys.includes(field)) && keys.every((field) => allowed.has(field))
}

function assertOwnDataFields(value, fields, label) {
  if (!isPlainDataObject(value)) throw new TypeError(`${label} is invalid`)
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw new TypeError(`${label} has an invalid exact-key schema`)
  }
  for (const field of fields) {
    if (!isEnumerableData(Object.getOwnPropertyDescriptor(value, field))) {
      throw new TypeError(`${label} contains an accessor or hidden field`)
    }
  }
}

function isEnumerableData(descriptor) {
  return (
    descriptor?.enumerable === true &&
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  )
}

function isPlainDataObject(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value)
}

function isTimestamp(value) {
  return (
    typeof value === "string" && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  )
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function allIndexes(value, pattern) {
  const indexes = []
  let offset = 0
  while (offset <= value.length) {
    const index = value.indexOf(pattern, offset)
    if (index === -1) break
    indexes.push(index)
    offset = index + pattern.length
  }
  return indexes
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
