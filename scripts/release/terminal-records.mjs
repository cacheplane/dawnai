import { snapshotJson } from "./adapter-normalize.mjs"
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
  "approval",
  "commitSha",
  "observations",
  "reason",
  "recordedAt",
  "schemaVersion",
  "tag",
  "version",
])
const APPROVAL_FIELDS = Object.freeze(["approvedAt", "deploymentId", "environment", "reviewer"])
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
    !isTimestamp(record.recordedAt)
  ) {
    throw new TypeError("Invalid abandonment record")
  }

  const approval = record.approval
  if (
    !hasExactFields(approval, APPROVAL_FIELDS) ||
    approval.environment !== expected.environment ||
    !isPositiveInteger(approval.deploymentId) ||
    !isBoundedText(approval.reviewer, MAX_NAME_BYTES) ||
    !isTimestamp(approval.approvedAt)
  ) {
    throw new TypeError("Invalid abandonment approval evidence")
  }
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
  if (
    first.workflowRunId === second.workflowRunId ||
    Date.parse(first.observedAt) >= Date.parse(second.observedAt) ||
    Date.parse(approval.approvedAt) > Date.parse(history.observedAt) ||
    Date.parse(history.observedAt) > Date.parse(first.observedAt) ||
    Date.parse(second.observedAt) > Date.parse(record.recordedAt)
  ) {
    throw new TypeError("Invalid abandonment evidence ordering")
  }
  return deepFreeze(record)
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

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
