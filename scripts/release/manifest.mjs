import { createHash } from "node:crypto"
import { posix, win32 } from "node:path"

import { isExactSemver } from "./semver.mjs"
import { orderReleasePackages } from "./topology.mjs"

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1

const ROOT_FIELDS = [
  "schemaVersion",
  "version",
  "commitSha",
  "ci",
  "artifact",
  "packageOrder",
  "packages",
]
const CI_FIELDS = ["workflow", "runId", "runAttempt"]
const ARTIFACT_FIELDS = ["name", "prepareRunId", "prepareRunAttempt"]
const PACKAGE_FIELDS = [
  "name",
  "version",
  "filename",
  "size",
  "sha256",
  "sha512",
  "npmIntegrity",
  "access",
]

export function parseReleaseManifest(raw, context) {
  let value
  try {
    if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
      throw new TypeError("expected UTF-8 JSON bytes")
    }
    value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw)
  } catch (error) {
    throw new TypeError(`Invalid release manifest JSON: ${formatCause(error)}`, { cause: error })
  }
  return validateReleaseManifest(value, context)
}

export function validateReleaseManifest(value, context) {
  assertObject(value, "release manifest")
  assertExactFields(value, ROOT_FIELDS, "release manifest")

  if (value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${RELEASE_MANIFEST_SCHEMA_VERSION}`)
  }
  if (!isExactSemver(value.version)) {
    throw new Error("version must be an exact SemVer")
  }
  if (typeof value.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(value.commitSha)) {
    throw new Error("commitSha must be a 40-character lowercase hexadecimal SHA")
  }

  validateCi(value.ci)
  validateArtifact(value.artifact)

  const contextPackages = context?.packages
  const gateOrder = context?.gateOrder
  const expectedOrder =
    gateOrder === undefined
      ? orderReleasePackages(contextPackages)
      : orderReleasePackages(contextPackages, { gateOrder })
  const inventoryNames = [...expectedOrder].sort(compareNames)

  validatePackageOrder(value.packageOrder, inventoryNames)
  validatePackages(value.packages, {
    inventoryNames,
    packageOrder: value.packageOrder,
    version: value.version,
  })

  if (!arraysEqual(value.packageOrder, expectedOrder)) {
    throw new Error("packageOrder must be the canonical dependency order")
  }

  return deepFreeze(structuredClone(value))
}

export function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(canonicalize(manifest), null, 2)}\n`, "utf8")
}

export function manifestSha256(manifest) {
  return createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex")
}

function validateCi(value) {
  assertObject(value, "ci")
  assertExactFields(value, CI_FIELDS, "ci")
  if (typeof value.workflow !== "string" || value.workflow.length === 0) {
    throw new Error("ci.workflow must be a non-empty string")
  }
  assertPositiveInteger(value.runId, "ci.runId")
  assertPositiveInteger(value.runAttempt, "ci.runAttempt")
}

function validateArtifact(value) {
  assertObject(value, "artifact")
  assertExactFields(value, ARTIFACT_FIELDS, "artifact")
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("artifact.name must be a non-empty string")
  }
  assertPositiveInteger(value.prepareRunId, "artifact.prepareRunId")
  assertPositiveInteger(value.prepareRunAttempt, "artifact.prepareRunAttempt")
}

function validatePackageOrder(packageOrder, inventoryNames) {
  if (!Array.isArray(packageOrder) || !packageOrder.every(isNonEmptyString)) {
    throw new Error("packageOrder must be an array of package names")
  }
  const duplicate = findDuplicate(packageOrder)
  if (duplicate !== undefined) {
    throw new Error(`packageOrder contains duplicate package ${duplicate}`)
  }
  if (!arraysEqual([...packageOrder].sort(compareNames), inventoryNames)) {
    throw new Error("packageOrder must exactly match the canonical release inventory")
  }
}

function validatePackages(packages, { inventoryNames, packageOrder, version }) {
  if (!Array.isArray(packages)) {
    throw new Error("packages must be an array")
  }
  const packageNames = []
  for (let index = 0; index < packages.length; index += 1) {
    const entry = packages[index]
    assertObject(entry, `packages[${index}]`)
    assertExactFields(entry, PACKAGE_FIELDS, `packages[${index}]`)
    if (!isNonEmptyString(entry.name)) {
      throw new Error(`packages[${index}].name must be a non-empty string`)
    }
    packageNames.push(entry.name)
  }

  const duplicate = findDuplicate(packageNames)
  if (duplicate !== undefined) {
    throw new Error(`packages contains duplicate package ${duplicate}`)
  }
  if (!arraysEqual([...packageNames].sort(compareNames), inventoryNames)) {
    throw new Error("packages must exactly match the canonical release inventory")
  }
  if (!arraysEqual(packageNames, packageOrder)) {
    throw new Error("packages must follow packageOrder")
  }

  for (const entry of packages) {
    validatePackage(entry, version)
  }
}

function validatePackage(entry, version) {
  if (entry.version !== version) {
    throw new Error(`${entry.name} version must match manifest version`)
  }
  if (typeof entry.filename !== "string" || !isBasename(entry.filename)) {
    throw new Error(`${entry.name} filename must be a basename`)
  }
  const expectedFilename = `${tarballName(entry.name)}-${version}.tgz`
  if (entry.filename !== expectedFilename) {
    throw new Error(`${entry.name} filename must be ${expectedFilename}`)
  }
  if (entry.access !== "public") {
    throw new Error(`${entry.name} access must be public`)
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw new Error(`${entry.name} size must be a positive integer`)
  }
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
    throw new Error(`${entry.name} sha256 must be a lowercase SHA-256 digest`)
  }
  if (typeof entry.sha512 !== "string" || !/^[0-9a-f]{128}$/u.test(entry.sha512)) {
    throw new Error(`${entry.name} sha512 must be a lowercase SHA-512 digest`)
  }
  const expectedIntegrity = `sha512-${Buffer.from(entry.sha512, "hex").toString("base64")}`
  if (entry.npmIntegrity !== expectedIntegrity) {
    throw new Error(`${entry.name} npmIntegrity must match sha512`)
  }
}

function tarballName(packageName) {
  return packageName.startsWith("@") ? packageName.slice(1).replaceAll("/", "-") : packageName
}

function isBasename(value) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    posix.basename(value) === value &&
    win32.basename(value) === value
  )
}

function assertObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, expectedFields, label) {
  for (const field of expectedFields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`${label} is missing field ${field}`)
    }
  }
  const unknownFields = Object.keys(value)
    .filter((field) => !expectedFields.includes(field))
    .sort(compareNames)
  if (unknownFields.length > 0) {
    throw new Error(`${label} contains unknown field ${unknownFields[0]}`)
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
}

function canonicalize(value, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value !== "object") {
    throw new TypeError("Manifest must contain only JSON values")
  }
  if (ancestors.has(value)) {
    throw new TypeError("Manifest must not contain cycles")
  }
  const nextAncestors = new Set(ancestors).add(value)
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, nextAncestors))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Manifest must contain only JSON objects")
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareNames)
      .map((key) => [key, canonicalize(value[key], nextAncestors)]),
  )
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function findDuplicate(values) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) {
      return value
    }
    seen.add(value)
  }
  return undefined
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function formatCause(error) {
  return error instanceof Error ? error.message : String(error)
}
