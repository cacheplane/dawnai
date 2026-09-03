import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import { validateMarker } from "./metadata.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

export const TERMINAL_RECORD_DIRECTORY = "scripts/release/terminal-records"
export const MAX_TERMINAL_RECORD_BYTES = 512 * 1024
export const OPERATOR_RECOVERY_MODE = "operator-recovery"

const RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  "version",
  "commitSha",
  "tag",
  "reason",
  "predecessor",
  "evidence",
  "authority",
])
const TAG_FIELDS = Object.freeze(["name", "objectSha", "commitSha"])
const PREDECESSOR_FIELDS = Object.freeze([
  "state",
  "releaseId",
  "releaseStatus",
  "bodySha256",
  "marker",
  "artifact",
])
const ARTIFACT_FIELDS = Object.freeze([
  "manifestSha256",
  "releaseRecordSha256",
  "baseAssetSetSha256",
  "attestationSet",
])
const EVIDENCE_FIELDS = Object.freeze(["escrowAssets", "npm", "releaseRuns", "duplicateRecovery"])
const ASSET_FIELDS = Object.freeze(["id", "name", "sha256"])
const NPM_EVIDENCE_FIELDS = Object.freeze(["observations"])
const NPM_OBSERVATION_FIELDS = Object.freeze(["observedAt", "packages"])
const NPM_PACKAGE_FIELDS = Object.freeze(["name", "version", "status", "httpStatus", "code"])
const RELEASE_RUN_FIELDS = Object.freeze([
  "workflowRunId",
  "runAttempt",
  "status",
  "publishJobStarted",
])
const DUPLICATE_RECOVERY_FIELDS = Object.freeze(["duplicates", "finalAuthorizationReceiptSha256"])
const DUPLICATE_FIELDS = Object.freeze(["releaseId", "receiptAssetId", "receiptSha256"])
const AUTHORITY_FIELDS = Object.freeze(["mode", "operator", "capturedAt", "reviewedCommit"])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const MIN_NPM_OBSERVATION_GAP_MS = 60_000
const MAX_EVIDENCE_SPAN_MS = 15 * 60_000
const MAX_REASON_BYTES = 4_096
const MAX_ESCROW_ASSET_NAME_BYTES = 512
const MAX_RELEASE_RUNS = 128
const RELEASE_RECORD_ASSET_NAME = "release-record.json"
const PACKAGE_NAMES = Object.freeze([...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
const EXPECTED_ESCROW_ASSET_COUNT = PACKAGE_NAMES.length * 2 + 3

export function terminalRecordPath(version) {
  if (!isReleaseVersion(version)) throw new TypeError("Terminal record version is invalid")
  return `${TERMINAL_RECORD_DIRECTORY}/v${version}.json`
}

export function canonicalTerminalRecordBytes(value) {
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(snapshotJson(value)))}\n`, "utf8")
  if (bytes.byteLength > MAX_TERMINAL_RECORD_BYTES) {
    throw new TypeError("Canonical terminal record exceeds its byte cap")
  }
  return bytes
}

/**
 * Parse exact canonical bytes of an operator-recovery terminal record. Every
 * level has an exact field set; digests, SHAs, timestamps, and ordering are
 * validated; the result is deep-frozen and carries its own `sha256`.
 */
export function parseOperatorRecoveryRecord(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Terminal record bytes are invalid")
  if (bytes.byteLength > MAX_TERMINAL_RECORD_BYTES) {
    throw new TypeError("Terminal record exceeds its byte cap")
  }
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError("Terminal record is not UTF-8 JSON", { cause: error })
  }
  if (!canonicalTerminalRecordBytes(value).equals(bytes)) {
    throw new TypeError("Terminal record bytes are not canonical")
  }
  const record = snapshotJson(value)
  assertExactFields(record, RECORD_FIELDS, "terminal record")
  if (record.schemaVersion !== 1) throw new TypeError("Terminal record schemaVersion is invalid")
  if (record.kind !== "abandoned-prepublication") {
    throw new TypeError("Terminal record kind is invalid")
  }
  if (!isReleaseVersion(record.version)) throw new TypeError("Terminal record version is invalid")
  if (!SHA_PATTERN.test(record.commitSha)) throw new TypeError("Terminal record commit is invalid")
  assertExactFields(record.tag, TAG_FIELDS, "terminal record tag")
  if (
    record.tag.name !== `v${record.version}` ||
    !SHA_PATTERN.test(record.tag.objectSha) ||
    record.tag.commitSha !== record.commitSha
  ) {
    throw new TypeError("Terminal record tag is invalid")
  }
  if (!isBoundedText(record.reason, MAX_REASON_BYTES)) {
    throw new TypeError("Terminal record reason is invalid")
  }
  const marker = validatePredecessor(record.predecessor, record)
  validateEvidence(record.evidence, record, marker)
  validateAuthority(record.authority)
  const [first, second] = record.evidence.npm.observations
  if (Date.parse(record.authority.capturedAt) < Date.parse(second.observedAt)) {
    throw new TypeError("Terminal record capture precedes its evidence")
  }
  if (
    Date.parse(record.authority.capturedAt) - Date.parse(first.observedAt) >
    MAX_EVIDENCE_SPAN_MS
  ) {
    throw new TypeError("Terminal record evidence span exceeds fifteen minutes")
  }
  return deepFreeze({ ...record, sha256: sha256(bytes) })
}

/** Read and parse the record for `version` at `ref`, or null when absent. */
export async function readTerminalRecord({ git, ref, version }) {
  if (typeof git?.listTree !== "function" || typeof git?.showFile !== "function") {
    throw new TypeError("Terminal record git reader is invalid")
  }
  if (typeof ref !== "string" || ref.length === 0) {
    throw new TypeError("Terminal record ref is invalid")
  }
  const path = terminalRecordPath(version)
  const tree = await git.listTree({ ref })
  if (typeof tree !== "string") throw new TypeError("Terminal record tree listing is invalid")
  const paths = new Set(tree.split("\n").filter((line) => line.length > 0))
  if (!paths.has(path)) return null
  const text = await git.showFile({ ref, path })
  if (typeof text !== "string") throw new TypeError("Terminal record contents are invalid")
  try {
    return parseOperatorRecoveryRecord(Buffer.from(text, "utf8"))
  } catch (error) {
    throw new TypeError(`Terminal record ${path} is invalid: ${error.message}`, { cause: error })
  }
}

function validatePredecessor(value, record) {
  assertExactFields(value, PREDECESSOR_FIELDS, "terminal record predecessor")
  if (
    value.state !== "CANDIDATE_ESCROWED" ||
    value.releaseStatus !== "draft" ||
    !isPositiveInteger(value.releaseId) ||
    !SHA256_PATTERN.test(value.bodySha256)
  ) {
    throw new TypeError("Terminal record predecessor is not an escrowed draft")
  }
  const marker = validateMarker(value.marker)
  if (
    marker.phase !== "ESCROWED" ||
    marker.version !== record.version ||
    marker.commitSha !== record.commitSha ||
    marker.tag !== `v${record.version}` ||
    marker.attestationSet === null
  ) {
    throw new TypeError("Terminal record predecessor marker is invalid")
  }
  assertExactFields(value.artifact, ARTIFACT_FIELDS, "terminal record predecessor artifact")
  if (
    value.artifact.manifestSha256 !== marker.manifestSha256 ||
    value.artifact.releaseRecordSha256 !== marker.releaseRecordSha256 ||
    value.artifact.baseAssetSetSha256 !== marker.baseAssetSetSha256 ||
    JSON.stringify(canonicalize(value.artifact.attestationSet)) !==
      JSON.stringify(canonicalize(marker.attestationSet))
  ) {
    throw new TypeError("Terminal record predecessor artifact does not match its marker")
  }
  return marker
}

function validateEvidence(value, record, marker) {
  assertExactFields(value, EVIDENCE_FIELDS, "terminal record evidence")
  validateEscrowAssets(value.escrowAssets, marker)
  validateNpmEvidence(value.npm, record)
  validateReleaseRuns(value.releaseRuns)
  validateDuplicateRecovery(value.duplicateRecovery)
}

function validateEscrowAssets(escrowAssets, marker) {
  if (!Array.isArray(escrowAssets) || escrowAssets.length !== EXPECTED_ESCROW_ASSET_COUNT) {
    throw new TypeError("Terminal record escrow assets must be the base asset set")
  }
  const names = new Set()
  for (const asset of escrowAssets) {
    assertExactFields(asset, ASSET_FIELDS, "terminal record escrow asset")
    if (
      !isPositiveInteger(asset.id) ||
      !isBoundedText(asset.name, MAX_ESCROW_ASSET_NAME_BYTES) ||
      names.has(asset.name) ||
      !SHA256_PATTERN.test(asset.sha256)
    ) {
      throw new TypeError("Terminal record escrow asset is invalid")
    }
    names.add(asset.name)
  }
  const expectedNames = new Set([RELEASE_RECORD_ASSET_NAME])
  for (const subject of marker.attestationSet.subjects) {
    expectedNames.add(subject.subjectName)
    expectedNames.add(subject.bundleName)
  }
  if (names.size !== expectedNames.size || [...names].some((name) => !expectedNames.has(name))) {
    throw new TypeError(
      "Terminal record escrow asset names do not match the marker's attestation subjects",
    )
  }
}

function validateNpmEvidence(value, record) {
  assertExactFields(value, NPM_EVIDENCE_FIELDS, "terminal record npm evidence")
  if (!Array.isArray(value.observations) || value.observations.length !== 2) {
    throw new TypeError("Terminal record npm evidence needs exactly two observations")
  }
  for (const observation of value.observations) {
    assertExactFields(observation, NPM_OBSERVATION_FIELDS, "terminal record npm observation")
    if (!isTimestamp(observation.observedAt)) {
      throw new TypeError("Terminal record npm observation time is invalid")
    }
    if (
      !Array.isArray(observation.packages) ||
      observation.packages.length !== PACKAGE_NAMES.length
    ) {
      throw new TypeError("Terminal record npm observation package set is invalid")
    }
    const seen = []
    for (const pkg of observation.packages) {
      assertExactFields(pkg, NPM_PACKAGE_FIELDS, "terminal record npm package")
      if (
        pkg.version !== record.version ||
        pkg.status !== "ABSENT" ||
        pkg.httpStatus !== 404 ||
        pkg.code !== "E404"
      ) {
        throw new TypeError("Terminal record npm package is not absent")
      }
      seen.push(pkg.name)
    }
    if (JSON.stringify(seen) !== JSON.stringify(PACKAGE_NAMES)) {
      throw new TypeError("Terminal record npm package inventory is not canonical")
    }
  }
  const [first, second] = value.observations
  if (Date.parse(first.observedAt) >= Date.parse(second.observedAt)) {
    throw new TypeError("Terminal record npm observations are out of order")
  }
  if (Date.parse(second.observedAt) - Date.parse(first.observedAt) < MIN_NPM_OBSERVATION_GAP_MS) {
    throw new TypeError("Terminal record npm observations must be sixty seconds apart")
  }
}

function validateReleaseRuns(releaseRuns) {
  if (
    !Array.isArray(releaseRuns) ||
    releaseRuns.length === 0 ||
    releaseRuns.length > MAX_RELEASE_RUNS
  ) {
    throw new TypeError("Terminal record release runs are invalid")
  }
  const runKeys = new Set()
  for (const run of releaseRuns) {
    assertExactFields(run, RELEASE_RUN_FIELDS, "terminal record release run")
    const key = `${run.workflowRunId}:${run.runAttempt}`
    if (
      !isPositiveInteger(run.workflowRunId) ||
      !isPositiveInteger(run.runAttempt) ||
      run.status !== "completed" ||
      run.publishJobStarted !== false ||
      runKeys.has(key)
    ) {
      throw new TypeError("Terminal record release run is invalid")
    }
    runKeys.add(key)
  }
}

function validateDuplicateRecovery(duplicateRecovery) {
  assertExactFields(
    duplicateRecovery,
    DUPLICATE_RECOVERY_FIELDS,
    "terminal record duplicate recovery",
  )
  if (!Array.isArray(duplicateRecovery.duplicates) || duplicateRecovery.duplicates.length !== 2) {
    throw new TypeError("Terminal record duplicate recovery is invalid")
  }
  const releaseIds = new Set()
  const receiptAssetIds = new Set()
  for (const duplicate of duplicateRecovery.duplicates) {
    assertExactFields(duplicate, DUPLICATE_FIELDS, "terminal record duplicate")
    if (
      !isPositiveInteger(duplicate.releaseId) ||
      !isPositiveInteger(duplicate.receiptAssetId) ||
      !SHA256_PATTERN.test(duplicate.receiptSha256) ||
      releaseIds.has(duplicate.releaseId) ||
      receiptAssetIds.has(duplicate.receiptAssetId)
    ) {
      throw new TypeError("Terminal record duplicate is invalid")
    }
    releaseIds.add(duplicate.releaseId)
    receiptAssetIds.add(duplicate.receiptAssetId)
  }
  if (!SHA256_PATTERN.test(duplicateRecovery.finalAuthorizationReceiptSha256)) {
    throw new TypeError("Terminal record final authorization digest is invalid")
  }
}

function validateAuthority(value) {
  assertExactFields(value, AUTHORITY_FIELDS, "terminal record authority")
  if (value.mode !== OPERATOR_RECOVERY_MODE) {
    throw new TypeError("Terminal record authority mode is invalid")
  }
  if (!LOGIN_PATTERN.test(value.operator)) {
    throw new TypeError("Terminal record operator is invalid")
  }
  if (!isTimestamp(value.capturedAt)) throw new TypeError("Terminal record capture time is invalid")
  if (!SHA_PATTERN.test(value.reviewedCommit)) {
    throw new TypeError("Terminal record reviewed commit is invalid")
  }
}

function assertExactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const keys = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are not exact`)
  }
}

function isReleaseVersion(value) {
  return typeof value === "string" && isExactSemver(value) && parseSemver(value).build.length === 0
}
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}
function isTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  const canonical = new Date(milliseconds).toISOString()
  return canonical === value || canonical.replace(".000Z", "Z") === value
}
function isBoundedText(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasControlCharacters(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  )
}
function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}
