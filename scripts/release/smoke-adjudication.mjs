// Operator adjudication of the release smoke gate for a single, exactly-pinned
// candidate.
//
// This exists for one failure mode: a candidate whose packages published
// correctly but whose own frozen smoke lanes cannot pass, because every release
// job outside the controller checks out the candidate commit. A defect in that
// commit's smoke scripts reproduces identically on every re-dispatch, and the
// published packages' npm provenance binds them to that commit, so the tag
// cannot be moved to pick up a fix. Without an adjudication the candidate can
// never reach a terminal state, and no later version can be released.
//
// The record NEVER claims the smokes passed. It records that an operator
// reviewed the lane outcomes and adjudicated the gate, and it is bound to one
// version, one commit and one manifest digest, so it cannot apply to any other
// candidate.

const SHA256 = /^[0-9a-f]{64}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

export const SMOKE_ADJUDICATION_RECORD_FIELDS = Object.freeze([
  "adjudicatedLanes",
  "authority",
  "commitSha",
  "kind",
  "manifestSha256",
  "reason",
  "remediation",
  "schemaVersion",
  "version",
])
const LANE_FIELDS = Object.freeze(["detail", "name", "outcome"])
const AUTHORITY_FIELDS = Object.freeze(["capturedAt", "mode", "operator", "reviewedCommit"])
const LANE_OUTCOMES = Object.freeze(["passed", "failed", "flaked"])
const REMEDIATION_FIELDS = Object.freeze(["fixCommitSha", "summary"])

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== "string")) return false
  return keys.length === fields.length && fields.every((field) => keys.includes(field))
}

function boundedText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

/**
 * Parse a smoke adjudication record. Throws on anything unexpected: an
 * adjudication that cannot be fully understood must never take effect.
 */
export function parseSmokeAdjudication(value) {
  if (!hasExactFields(value, SMOKE_ADJUDICATION_RECORD_FIELDS)) {
    throw new TypeError("Smoke adjudication record fields are invalid")
  }
  if (value.schemaVersion !== 1) {
    throw new TypeError("Smoke adjudication schema version is unsupported")
  }
  if (value.kind !== "smoke-gate-adjudicated") {
    throw new TypeError("Smoke adjudication kind is unsupported")
  }
  if (typeof value.version !== "string" || !EXACT_SEMVER.test(value.version)) {
    throw new TypeError("Smoke adjudication version must be exact SemVer")
  }
  if (typeof value.commitSha !== "string" || !SHA1.test(value.commitSha)) {
    throw new TypeError("Smoke adjudication commit is invalid")
  }
  if (typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)) {
    throw new TypeError("Smoke adjudication manifest digest is invalid")
  }
  if (!boundedText(value.reason, 2_048)) {
    throw new TypeError("Smoke adjudication reason is required")
  }
  if (!hasExactFields(value.authority, AUTHORITY_FIELDS)) {
    throw new TypeError("Smoke adjudication authority is invalid")
  }
  if (value.authority.mode !== "operator-adjudication") {
    throw new TypeError("Smoke adjudication authority mode is unsupported")
  }
  if (!boundedText(value.authority.operator, 256)) {
    throw new TypeError("Smoke adjudication operator is required")
  }
  if (
    typeof value.authority.reviewedCommit !== "string" ||
    !SHA1.test(value.authority.reviewedCommit)
  ) {
    throw new TypeError("Smoke adjudication reviewed commit is invalid")
  }
  if (
    typeof value.authority.capturedAt !== "string" ||
    Number.isNaN(Date.parse(value.authority.capturedAt))
  ) {
    throw new TypeError("Smoke adjudication capture time is invalid")
  }
  if (!hasExactFields(value.remediation, REMEDIATION_FIELDS)) {
    throw new TypeError("Smoke adjudication remediation is invalid")
  }
  if (
    typeof value.remediation.fixCommitSha !== "string" ||
    !SHA1.test(value.remediation.fixCommitSha)
  ) {
    throw new TypeError("Smoke adjudication remediation commit is invalid")
  }
  if (!boundedText(value.remediation.summary, 2_048)) {
    throw new TypeError("Smoke adjudication remediation summary is required")
  }
  if (!Array.isArray(value.adjudicatedLanes) || value.adjudicatedLanes.length === 0) {
    throw new TypeError("Smoke adjudication must record every lane outcome")
  }
  const names = new Set()
  for (const lane of value.adjudicatedLanes) {
    if (!hasExactFields(lane, LANE_FIELDS)) {
      throw new TypeError("Smoke adjudication lane fields are invalid")
    }
    if (!boundedText(lane.name, 128)) throw new TypeError("Smoke adjudication lane name is invalid")
    if (names.has(lane.name)) throw new TypeError("Smoke adjudication lane is duplicated")
    names.add(lane.name)
    if (!LANE_OUTCOMES.includes(lane.outcome)) {
      throw new TypeError("Smoke adjudication lane outcome is unsupported")
    }
    if (!boundedText(lane.detail, 2_048)) {
      throw new TypeError("Smoke adjudication lane detail is required")
    }
  }
  return Object.freeze({
    adjudicatedLanes: Object.freeze(
      value.adjudicatedLanes.map((lane) =>
        Object.freeze({ detail: lane.detail, name: lane.name, outcome: lane.outcome }),
      ),
    ),
    authority: Object.freeze({ ...value.authority }),
    commitSha: value.commitSha,
    kind: value.kind,
    manifestSha256: value.manifestSha256,
    reason: value.reason,
    remediation: Object.freeze({ ...value.remediation }),
    schemaVersion: value.schemaVersion,
    version: value.version,
  })
}

/**
 * An adjudication applies only to the exact candidate it names. Every identity
 * field must match, and the required lanes must be covered exactly, so a record
 * can never be inherited by a later candidate or widened after review.
 */
export function smokeAdjudicationApplies(record, candidate) {
  if (record === null || record === undefined) return false
  if (!isPlainObject(candidate)) return false
  const { commitSha, manifestSha256, requiredLanes, version } = candidate
  if (record.version !== version) return false
  if (record.commitSha !== commitSha) return false
  if (record.manifestSha256 !== manifestSha256) return false
  if (!Array.isArray(requiredLanes) || requiredLanes.length === 0) return false
  const adjudicated = new Set(record.adjudicatedLanes.map((lane) => lane.name))
  if (adjudicated.size !== requiredLanes.length) return false
  return requiredLanes.every((lane) => adjudicated.has(lane))
}

export function smokeAdjudicationPath(version) {
  if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
    throw new TypeError("Smoke adjudication version must be exact SemVer")
  }
  return `scripts/release/smoke-adjudications/v${version}.json`
}

/**
 * Read the adjudication for one version from git at an explicit ref, mirroring
 * how terminal records are read. Absence is normal and yields null; a record
 * that exists but cannot be validated throws, so a damaged or tampered
 * adjudication fails closed instead of silently waiving the gate.
 */
export async function readSmokeAdjudication({ git, ref, version }) {
  if (typeof git?.listTree !== "function" || typeof git?.showFile !== "function") {
    throw new TypeError("Smoke adjudication git reader is invalid")
  }
  if (typeof ref !== "string" || ref.length === 0) {
    throw new TypeError("Smoke adjudication ref is invalid")
  }
  const path = smokeAdjudicationPath(version)
  const tree = await git.listTree({ ref })
  if (typeof tree !== "string") throw new TypeError("Smoke adjudication tree listing is invalid")
  const paths = new Set(tree.split("\n").filter((line) => line.length > 0))
  if (!paths.has(path)) return null
  const text = await git.showFile({ ref, path })
  if (typeof text !== "string") throw new TypeError("Smoke adjudication contents are invalid")
  let parsed
  try {
    parsed = parseSmokeAdjudication(JSON.parse(text))
  } catch (error) {
    throw new TypeError(`Smoke adjudication ${path} is invalid: ${error.message}`, { cause: error })
  }
  // The path names the version, so a record whose own identity disagrees with it is filed under a
  // version it does not describe; binding them here keeps callers from trusting the path alone.
  if (parsed.version !== version) {
    throw new TypeError(`Smoke adjudication ${path} names another version`)
  }
  return parsed
}
