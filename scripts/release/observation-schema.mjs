import { isExactSemver, parseSemver } from "./semver.mjs"

const PLANNER_FIELDS = Object.freeze(["candidate", "observation", "mode"])
const CANDIDATE_FIELDS = Object.freeze(["version", "commitSha", "publisherWorkflow"])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
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
      "integrity",
    ]) &&
    hasExactFields(observation.ci, ["status", "workflow", "commitSha"]) &&
    recordsHaveExactFields(observation.otherCandidates, ["version", "commitSha", "state"]) &&
    hasExactFields(observation.tag, ["status", "commitSha"]) &&
    hasExactFields(observation.artifacts, [
      "status",
      "manifestVersion",
      "manifestCommitSha",
      "manifestSha256",
      "files",
    ]) &&
    recordsHaveExactFields(observation.artifacts?.files, [
      "name",
      "status",
      "assetName",
      "sha256",
      "integrity",
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
  for (const pkg of observation.registry?.packages ?? []) {
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
  if (!isPositiveInteger(audit?.workflowRunId)) {
    conflicts.add("release-audit-workflow-run-id-invalid")
  }
  if (!isPositiveInteger(audit?.runAttempt)) {
    conflicts.add("release-audit-run-attempt-invalid")
  }
  return [...conflicts].sort()
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
