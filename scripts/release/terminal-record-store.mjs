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
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const MIN_NPM_OBSERVATION_GAP_MS = 60_000
const MAX_REASON_BYTES = 4_096
const PACKAGE_NAMES = Object.freeze([...CANONICAL_RELEASE_PACKAGE_ORDER].sort())

export function terminalRecordPath(version) {
  if (!isReleaseVersion(version)) throw new TypeError("Terminal record version is invalid")
  return `${TERMINAL_RECORD_DIRECTORY}/v${version}.json`
}

export function canonicalTerminalRecordBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(snapshotJson(value)))}\n`, "utf8")
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
  if (
    typeof record.reason !== "string" ||
    record.reason.length === 0 ||
    Buffer.byteLength(record.reason, "utf8") > MAX_REASON_BYTES
  ) {
    throw new TypeError("Terminal record reason is invalid")
  }
  validatePredecessor(record.predecessor, record)
  validateEvidence(record.evidence, record)
  validateAuthority(record.authority)
  return deepFreeze({ ...record, sha256: sha256(bytes) })
}

/** Read and parse the record for `version` at `ref`, or null when absent. */
export async function readTerminalRecord({ git, ref, version }) {
  if (typeof git?.listTree !== "function" || typeof git?.showFile !== "function") {
    throw new TypeError("Terminal record git reader is invalid")
  }
  if (typeof ref !== "string" || ref.length === 0)
    throw new TypeError("Terminal record ref is invalid")
  const path = terminalRecordPath(version)
  const tree = await git.listTree({ ref })
  if (!Array.isArray(tree)) throw new TypeError("Terminal record tree listing is invalid")
  if (!tree.includes(path)) return null
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
}

function validateEvidence(value, record) {
  assertExactFields(value, EVIDENCE_FIELDS, "terminal record evidence")
  if (!Array.isArray(value.escrowAssets) || value.escrowAssets.length !== 45) {
    throw new TypeError("Terminal record escrow assets must be the 45 base assets")
  }
  const names = new Set()
  for (const asset of value.escrowAssets) {
    assertExactFields(asset, ASSET_FIELDS, "terminal record escrow asset")
    if (
      !isPositiveInteger(asset.id) ||
      typeof asset.name !== "string" ||
      names.has(asset.name) ||
      !SHA256_PATTERN.test(asset.sha256)
    ) {
      throw new TypeError("Terminal record escrow asset is invalid")
    }
    names.add(asset.name)
  }
  assertExactFields(value.npm, ["observations"], "terminal record npm evidence")
  if (!Array.isArray(value.npm.observations) || value.npm.observations.length !== 2) {
    throw new TypeError("Terminal record npm evidence needs exactly two observations")
  }
  for (const observation of value.npm.observations) {
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
  const [first, second] = value.npm.observations
  if (Date.parse(second.observedAt) - Date.parse(first.observedAt) < MIN_NPM_OBSERVATION_GAP_MS) {
    throw new TypeError("Terminal record npm observations must be sixty seconds apart")
  }
  if (!Array.isArray(value.releaseRuns) || value.releaseRuns.length === 0) {
    throw new TypeError("Terminal record release runs are invalid")
  }
  for (const run of value.releaseRuns) {
    assertExactFields(run, RELEASE_RUN_FIELDS, "terminal record release run")
    if (
      !isPositiveInteger(run.workflowRunId) ||
      !isPositiveInteger(run.runAttempt) ||
      run.status !== "completed" ||
      run.publishJobStarted !== false
    ) {
      throw new TypeError("Terminal record release run is invalid")
    }
  }
  assertExactFields(
    value.duplicateRecovery,
    DUPLICATE_RECOVERY_FIELDS,
    "terminal record duplicate recovery",
  )
  if (
    !Array.isArray(value.duplicateRecovery.duplicates) ||
    value.duplicateRecovery.duplicates.length !== 2
  ) {
    throw new TypeError("Terminal record duplicate recovery is invalid")
  }
  for (const duplicate of value.duplicateRecovery.duplicates) {
    assertExactFields(duplicate, DUPLICATE_FIELDS, "terminal record duplicate")
    if (
      !isPositiveInteger(duplicate.releaseId) ||
      !isPositiveInteger(duplicate.receiptAssetId) ||
      !SHA256_PATTERN.test(duplicate.receiptSha256)
    ) {
      throw new TypeError("Terminal record duplicate is invalid")
    }
  }
  if (!SHA256_PATTERN.test(value.duplicateRecovery.finalAuthorizationReceiptSha256)) {
    throw new TypeError("Terminal record final authorization digest is invalid")
  }
}

function validateAuthority(value) {
  assertExactFields(value, AUTHORITY_FIELDS, "terminal record authority")
  if (value.mode !== OPERATOR_RECOVERY_MODE) {
    throw new TypeError("Terminal record authority mode is invalid")
  }
  if (!LOGIN_PATTERN.test(value.operator))
    throw new TypeError("Terminal record operator is invalid")
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
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  )
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}
