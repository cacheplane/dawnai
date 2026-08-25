import { snapshotJson } from "./adapter-normalize.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

const AUDIT_RESULT_FIELDS = Object.freeze([
  "checks",
  "commitSha",
  "conclusion",
  "finishedAt",
  "manifestSha256",
  "runAttempt",
  "schemaVersion",
  "startedAt",
  "version",
  "workflowRunId",
])
const CHECK_FIELDS = Object.freeze(["conclusion", "detail", "name"])
const ABANDONMENT_FIELDS = Object.freeze([
  "actionsHistory",
  "actor",
  "actorId",
  "approval",
  "commitSha",
  "observations",
  "predecessor",
  "reason",
  "recordedAt",
  "schemaVersion",
  "tag",
  "version",
])
const PREDECESSOR_FIELDS = Object.freeze([
  "artifact",
  "bodySha256",
  "marker",
  "releaseId",
  "releaseStatus",
  "state",
])
const PREDECESSOR_ARTIFACT_FIELDS = Object.freeze([
  "attestationSet",
  "baseAssetSetSha256",
  "manifestSha256",
  "releaseRecordSha256",
])
const APPROVAL_FIELDS = Object.freeze([
  "environment",
  "environmentId",
  "reviewerId",
  "reviewer",
  "state",
  "observedAt",
  "workflowRunId",
  "runAttempt",
])
const ACTIONS_HISTORY_FIELDS = Object.freeze([
  "observedAt",
  "publishJobStarted",
  "registryMutationStarted",
  "runAttempt",
  "workflowRunId",
])
const OBSERVATION_FIELDS = Object.freeze(["observedAt", "packages", "runAttempt", "workflowRunId"])
const PACKAGE_FIELDS = Object.freeze(["code", "httpStatus", "name", "status", "version"])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const MAX_CHECKS = 256
const MAX_NAME_BYTES = 256
const MAX_DETAIL_BYTES = 8_192
const MIN_REGISTRY_OBSERVATION_GAP_MS = 60_000
const MAX_SECOND_OBSERVATION_TO_RECORD_MS = 2 * 60_000
const MAX_AUTHORIZATION_EVIDENCE_SPAN_MS = 10 * 60_000

export function parseAuditResult(value) {
  const record = snapshotRecord(value, "audit result")
  if (!hasExactFields(record, AUDIT_RESULT_FIELDS) || record.schemaVersion !== 1) {
    throw new TypeError("Invalid audit result schema")
  }
  if (
    !isReleaseVersion(record.version) ||
    !SHA_PATTERN.test(record.commitSha) ||
    !SHA256_PATTERN.test(record.manifestSha256) ||
    !isPositiveInteger(record.workflowRunId) ||
    !isPositiveInteger(record.runAttempt) ||
    !isTimestamp(record.startedAt) ||
    !isTimestamp(record.finishedAt) ||
    Date.parse(record.finishedAt) < Date.parse(record.startedAt) ||
    !Array.isArray(record.checks) ||
    record.checks.length === 0 ||
    record.checks.length > MAX_CHECKS ||
    !["success", "failure"].includes(record.conclusion)
  ) {
    throw new TypeError("Invalid audit result")
  }

  const names = new Set()
  for (const check of record.checks) {
    if (
      !hasExactFields(check, CHECK_FIELDS) ||
      !isBoundedText(check.name, MAX_NAME_BYTES) ||
      !isBoundedText(check.detail, MAX_DETAIL_BYTES) ||
      !["success", "failure"].includes(check.conclusion) ||
      names.has(check.name)
    ) {
      throw new TypeError("Invalid audit result check")
    }
    names.add(check.name)
  }
  const aggregate = record.checks.every((check) => check.conclusion === "success")
    ? "success"
    : "failure"
  if (record.conclusion !== aggregate) {
    throw new TypeError("Audit result conclusion conflicts with its checks")
  }
  return deepFreeze(record)
}

export function canonicalAuditResultBytes(value) {
  const result = parseAuditResult(value)
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(result), null, 2)}\n`, "utf8")
  assertPayloadByteLength(
    bytes.byteLength,
    RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
    "Canonical audit result",
  )
  return bytes
}

export function parseAbandonmentRecord(value, options) {
  const record = snapshotRecord(value, "abandonment record")
  const expected = snapshotRecord(options, "abandonment expectations")
  const candidate = expected.candidate
  if (
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate !== "object" ||
    !isReleaseVersion(candidate.version) ||
    !SHA_PATTERN.test(candidate.commitSha) ||
    !isBoundedText(expected.environment, MAX_NAME_BYTES) ||
    !Array.isArray(expected.packageNames) ||
    expected.packageNames.length !== 21 ||
    !expected.packageNames.every((name) => PACKAGE_NAME_PATTERN.test(name)) ||
    new Set(expected.packageNames).size !== expected.packageNames.length ||
    !arraysEqual(expected.packageNames, [...expected.packageNames].sort(compareText))
  ) {
    throw new TypeError("Invalid abandonment expectations")
  }
  if (
    !hasExactFields(record, ABANDONMENT_FIELDS) ||
    record.schemaVersion !== 1 ||
    record.version !== candidate.version ||
    record.commitSha !== candidate.commitSha ||
    record.tag !== `v${candidate.version}` ||
    !isBoundedText(record.reason, MAX_DETAIL_BYTES) ||
    !isBoundedText(record.actor, MAX_NAME_BYTES) ||
    !isPositiveInteger(record.actorId) ||
    !isTimestamp(record.recordedAt)
  ) {
    throw new TypeError("Invalid abandonment record")
  }

  const approval = record.approval
  if (
    !hasExactFields(approval, APPROVAL_FIELDS) ||
    approval.environment !== expected.environment ||
    !isPositiveInteger(approval.environmentId) ||
    !isPositiveInteger(approval.reviewerId) ||
    !isBoundedText(approval.reviewer, MAX_NAME_BYTES) ||
    approval.reviewerId === record.actorId ||
    approval.reviewer.toLowerCase() === record.actor.toLowerCase() ||
    approval.state !== "approved" ||
    !isTimestamp(approval.observedAt) ||
    !isPositiveInteger(approval.workflowRunId) ||
    !isPositiveInteger(approval.runAttempt)
  ) {
    throw new TypeError("Invalid abandonment approval evidence")
  }
  validateAbandonmentPredecessor(record.predecessor)
  const history = record.actionsHistory
  if (
    !hasExactFields(history, ACTIONS_HISTORY_FIELDS) ||
    !isPositiveInteger(history.workflowRunId) ||
    !isPositiveInteger(history.runAttempt) ||
    !isTimestamp(history.observedAt) ||
    history.publishJobStarted !== false ||
    history.registryMutationStarted !== false
  ) {
    throw new TypeError("Invalid abandonment Actions history")
  }
  if (!Array.isArray(record.observations) || record.observations.length !== 2) {
    throw new TypeError("Invalid abandonment registry observations")
  }

  for (const observation of record.observations) {
    if (
      !hasExactFields(observation, OBSERVATION_FIELDS) ||
      !isPositiveInteger(observation.workflowRunId) ||
      !isPositiveInteger(observation.runAttempt) ||
      !isTimestamp(observation.observedAt) ||
      !Array.isArray(observation.packages) ||
      observation.packages.length !== expected.packageNames.length
    ) {
      throw new TypeError("Invalid abandonment registry observation")
    }
    const names = []
    for (const pkg of observation.packages) {
      if (
        !hasExactFields(pkg, PACKAGE_FIELDS) ||
        !PACKAGE_NAME_PATTERN.test(pkg.name) ||
        pkg.version !== candidate.version ||
        pkg.status !== "ABSENT" ||
        pkg.httpStatus !== 404 ||
        pkg.code !== "E404"
      ) {
        throw new TypeError("Invalid abandonment package observation")
      }
      names.push(pkg.name)
    }
    if (new Set(names).size !== names.length || !arraysEqual(names, expected.packageNames)) {
      throw new TypeError("Invalid abandonment package inventory")
    }
  }

  const [first, second] = record.observations
  const approvalTime = Date.parse(approval.observedAt)
  const historyTime = Date.parse(history.observedAt)
  const firstTime = Date.parse(first.observedAt)
  const secondTime = Date.parse(second.observedAt)
  const recordedTime = Date.parse(record.recordedAt)
  if (
    [history, first, second].some(
      (evidence) =>
        evidence.workflowRunId !== approval.workflowRunId ||
        evidence.runAttempt !== approval.runAttempt,
    ) ||
    firstTime >= secondTime ||
    approvalTime > firstTime ||
    secondTime > historyTime ||
    historyTime > recordedTime ||
    secondTime - firstTime < MIN_REGISTRY_OBSERVATION_GAP_MS ||
    recordedTime - secondTime > MAX_SECOND_OBSERVATION_TO_RECORD_MS ||
    recordedTime - approvalTime > MAX_AUTHORIZATION_EVIDENCE_SPAN_MS
  ) {
    throw new TypeError("Invalid abandonment evidence ordering")
  }
  return deepFreeze(record)
}

function validateAbandonmentPredecessor(value) {
  if (
    !hasExactFields(value, PREDECESSOR_FIELDS) ||
    !["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED", "CANDIDATE_ESCROWED"].includes(value.state) ||
    !["absent", "draft"].includes(value.releaseStatus) ||
    !hasExactFields(value.artifact, PREDECESSOR_ARTIFACT_FIELDS)
  ) {
    throw new TypeError("Invalid abandonment predecessor evidence")
  }
  const artifact = value.artifact
  const tagged = [
    artifact.manifestSha256,
    artifact.releaseRecordSha256,
    artifact.baseAssetSetSha256,
    artifact.attestationSet,
  ].every((item) => item === null)
  const prepared =
    SHA256_PATTERN.test(artifact.manifestSha256) &&
    SHA256_PATTERN.test(artifact.releaseRecordSha256) &&
    artifact.baseAssetSetSha256 === null &&
    artifact.attestationSet === null
  const escrowed =
    SHA256_PATTERN.test(artifact.manifestSha256) &&
    SHA256_PATTERN.test(artifact.releaseRecordSha256) &&
    SHA256_PATTERN.test(artifact.baseAssetSetSha256) &&
    artifact.attestationSet !== null &&
    !Array.isArray(artifact.attestationSet) &&
    typeof artifact.attestationSet === "object"
  if (
    (value.state === "CANDIDATE_TAGGED" && !tagged) ||
    (value.state === "ARTIFACTS_PREPARED" && !prepared) ||
    (value.state === "CANDIDATE_ESCROWED" && !escrowed)
  ) {
    throw new TypeError("Invalid abandonment predecessor artifact evidence")
  }
  if (
    (value.releaseStatus === "absent" &&
      (value.releaseId !== null ||
        value.bodySha256 !== null ||
        value.marker !== null ||
        value.state === "CANDIDATE_ESCROWED")) ||
    (value.releaseStatus === "draft" &&
      (!isPositiveInteger(value.releaseId) ||
        !SHA256_PATTERN.test(value.bodySha256) ||
        value.marker === null ||
        Array.isArray(value.marker) ||
        typeof value.marker !== "object" ||
        value.state !== "CANDIDATE_ESCROWED"))
  ) {
    throw new TypeError("Invalid abandonment predecessor Release evidence")
  }
}

function snapshotRecord(value, label) {
  let snapshot
  try {
    snapshot = snapshotJson(value)
  } catch (error) {
    throw new TypeError(`Invalid ${label}`, { cause: error })
  }
  if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new TypeError(`Invalid ${label}`)
  }
  return snapshot
}

function hasExactFields(value, fields) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
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

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
