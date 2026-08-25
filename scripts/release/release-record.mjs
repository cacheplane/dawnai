import { createHash } from "node:crypto"

import { isExactSemver, parseSemver } from "./semver.mjs"

export const RELEASE_RECORD_SCHEMA_VERSION = 1

const ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "version",
  "commitSha",
  "tag",
  "manifestSha256",
  "actionsArtifact",
])
const ARTIFACT_FIELDS = Object.freeze([
  "id",
  "name",
  "serviceDigest",
  "prepareRunId",
  "prepareRunAttempt",
])
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const UPLOAD_FIELDS = Object.freeze(["id", "name", "serviceDigest"])
const RUN_FIELDS = Object.freeze(["id", "attempt"])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SERVICE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export function parseReleaseRecord(raw) {
  let value
  if (typeof raw === "string" || raw instanceof Uint8Array) {
    let source
    try {
      source = typeof raw === "string" ? raw : UTF8_DECODER.decode(raw)
      value = JSON.parse(source)
    } catch (error) {
      throw new TypeError(`Release record JSON is invalid: ${formatCause(error)}`, { cause: error })
    }
  } else {
    value = snapshotData(raw, "release record")
  }
  return validateReleaseRecord(value)
}

export function createReleaseRecord({ candidate, manifestSha256, artifactUpload, prepareRun }) {
  const identity = validateCandidate(candidate)
  if (artifactUpload === undefined) {
    throw new TypeError("Exact artifact upload receipt is required")
  }
  const upload = snapshotData(artifactUpload, "artifact upload receipt")
  assertObject(upload, "artifact upload receipt")
  assertExactFields(upload, UPLOAD_FIELDS, "artifact upload receipt")
  const run = snapshotData(prepareRun, "prepare run receipt")
  assertObject(run, "prepare run receipt")
  assertExactFields(run, RUN_FIELDS, "prepare run receipt")
  return validateReleaseRecord({
    schemaVersion: RELEASE_RECORD_SCHEMA_VERSION,
    version: identity.version,
    commitSha: identity.commitSha,
    tag: `v${identity.version}`,
    manifestSha256,
    actionsArtifact: {
      id: normalizeDecimalId(upload.id, "artifact ID"),
      name: upload.name,
      serviceDigest: normalizeServiceDigest(upload.serviceDigest, { normalize: true }),
      prepareRunId: normalizeDecimalId(run.id, "prepare run ID", { allowNumber: true }),
      prepareRunAttempt: run.attempt,
    },
  })
}

export function canonicalReleaseRecordBytes(record) {
  const parsed = parseReleaseRecord(record)
  return Buffer.from(`${JSON.stringify(canonicalize(parsed), null, 2)}\n`, "utf8")
}

export function releaseRecordSha256(record) {
  return createHash("sha256").update(canonicalReleaseRecordBytes(record)).digest("hex")
}

function validateReleaseRecord(value) {
  const record = snapshotData(value, "release record")
  assertObject(record, "release record")
  assertExactFields(record, ROOT_FIELDS, "release record")
  if (record.schemaVersion !== RELEASE_RECORD_SCHEMA_VERSION) {
    throw new Error(`Release record schemaVersion must be ${RELEASE_RECORD_SCHEMA_VERSION}`)
  }
  if (!isReleaseVersion(record.version)) throw new Error("Release record version is invalid")
  if (!SHA_PATTERN.test(record.commitSha)) throw new Error("Release record SHA is invalid")
  if (record.tag !== `v${record.version}`) throw new Error("Release record tag is invalid")
  if (!SHA256_PATTERN.test(record.manifestSha256)) {
    throw new Error("Release record manifest digest is invalid")
  }
  assertObject(record.actionsArtifact, "actionsArtifact")
  assertExactFields(record.actionsArtifact, ARTIFACT_FIELDS, "actionsArtifact")
  record.actionsArtifact.id = normalizeDecimalId(record.actionsArtifact.id, "artifact ID")
  const expectedName = `release-v${record.version}-${record.commitSha.slice(0, 12)}`
  if (record.actionsArtifact.name !== expectedName) {
    throw new Error(`Release record artifact name must be ${expectedName}`)
  }
  record.actionsArtifact.serviceDigest = normalizeServiceDigest(
    record.actionsArtifact.serviceDigest,
  )
  record.actionsArtifact.prepareRunId = normalizeDecimalId(
    record.actionsArtifact.prepareRunId,
    "prepare run ID",
  )
  if (
    !Number.isSafeInteger(record.actionsArtifact.prepareRunAttempt) ||
    record.actionsArtifact.prepareRunAttempt < 1
  ) {
    throw new Error("Release record prepare run attempt must be a positive integer")
  }
  return deepFreeze(record)
}

function validateCandidate(candidate) {
  const value = snapshotData(candidate, "candidate")
  assertObject(value, "candidate")
  assertExactFields(value, CANDIDATE_FIELDS, "candidate")
  if (!isReleaseVersion(value.version)) throw new TypeError("Candidate version is invalid")
  if (!SHA_PATTERN.test(value.commitSha)) throw new TypeError("Candidate SHA is invalid")
  if (
    value.ciWorkflow !== "CI" ||
    value.ciCheck !== "validate" ||
    value.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Candidate release policy is invalid")
  }
  return value
}

function normalizeDecimalId(value, label, { allowNumber = false } = {}) {
  const normalized =
    allowNumber && typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value
  if (typeof normalized !== "string" || !DECIMAL_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a positive decimal string`)
  }
  return normalized
}

function normalizeServiceDigest(value, { normalize = false } = {}) {
  if (typeof value !== "string") throw new TypeError("Artifact service digest is required")
  const lowered = normalize ? value.toLowerCase() : value
  const normalized = normalize && /^[0-9a-f]{64}$/u.test(lowered) ? `sha256:${lowered}` : lowered
  if (!SERVICE_DIGEST_PATTERN.test(normalized)) {
    throw new TypeError("Artifact service digest must be sha256:<64 lowercase hex>")
  }
  return normalized
}

function snapshotData(value, label, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value !== "object") throw new TypeError(`${label} snapshot contains non-JSON data`)
  if (ancestors.has(value)) throw new TypeError(`${label} snapshot contains a cycle`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError(`${label} snapshot contains a non-JSON object`)
  }
  const next = new Set(ancestors).add(value)
  if (Array.isArray(value)) {
    const expectedKeys = new Set(["length", ...value.map((_entry, index) => String(index))])
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
      throw new TypeError(`${label} snapshot contains an unknown or symbol array field`)
    }
    return value.map((_entry, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${label} snapshot contains an accessor or sparse array`)
      }
      return snapshotData(descriptor.value, label, next)
    })
  }
  const result = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} snapshot contains a symbol field`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} snapshot contains an accessor or non-enumerable field`)
    }
    Object.defineProperty(result, key, {
      value: snapshotData(descriptor.value, label, next),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return result
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareNames)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function assertObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new Error(`${label} is missing field ${field}`)
  }
  const unknown = Object.keys(value)
    .filter((field) => !fields.includes(field))
    .sort(compareNames)
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function formatCause(error) {
  return error instanceof Error ? error.message : String(error)
}
