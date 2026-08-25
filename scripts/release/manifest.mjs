import { createHash } from "node:crypto"
import { posix, win32 } from "node:path"
import {
  assertPayloadByteLength,
  assertPreparedTarballPayload,
  RELEASE_PAYLOAD_LIMITS,
} from "./limits.mjs"
import { isExactSemver } from "./semver.mjs"
import { orderReleasePackages } from "./topology.mjs"

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1
export const CANONICAL_RELEASE_PACKAGE_ORDER = Object.freeze([
  "@dawn-ai/ag-ui",
  "@dawn-ai/config-biome",
  "@dawn-ai/config-typescript",
  "@dawn-ai/devkit",
  "@dawn-ai/sdk",
  "@dawn-ai/langgraph",
  "@dawn-ai/permissions",
  "@dawn-ai/postgres-storage",
  "@dawn-ai/sqlite-storage",
  "@dawn-ai/memory",
  "@dawn-ai/memory-pgvector",
  "@dawn-ai/workspace",
  "@dawn-ai/core",
  "@dawn-ai/inspector",
  "@dawn-ai/langchain",
  "@dawn-ai/cli",
  "@dawn-ai/sandbox",
  "@dawn-ai/testing",
  "@dawn-ai/evals",
  "@dawn-ai/vite-plugin",
  "create-dawn-ai-app",
])

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
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export function parseReleaseManifest(raw, context) {
  assertManifestInputSize(raw, "release manifest")
  let source
  if (typeof raw === "string") {
    source = raw
  } else if (raw instanceof Uint8Array) {
    try {
      source = UTF8_DECODER.decode(raw)
    } catch (error) {
      throw new TypeError("Invalid release manifest JSON: manifest bytes must be valid UTF-8", {
        cause: error,
      })
    }
  } else {
    throw new TypeError("Invalid release manifest JSON: expected UTF-8 JSON bytes")
  }

  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new TypeError(`Invalid release manifest JSON: ${formatCause(error)}`, { cause: error })
  }
  return validateReleaseManifest(value, context)
}

export function validateReleaseManifest(value, context) {
  const manifest = snapshotManifest(value)
  validateManifestShape(manifest)

  const contextPackages = context?.packages
  const gateOrder = context?.gateOrder
  const orderedPackages =
    gateOrder === undefined
      ? orderReleasePackages(contextPackages)
      : orderReleasePackages(contextPackages, { gateOrder })
  const expectedOrder = orderedPackages.map((packageJson) => packageJson.name)
  const inventoryNames = [...expectedOrder].sort(compareNames)

  validatePackageOrder(manifest.packageOrder, inventoryNames)
  validatePackages(manifest.packages, {
    inventoryNames,
    packageOrder: manifest.packageOrder,
    version: manifest.version,
  })

  if (!arraysEqual(manifest.packageOrder, expectedOrder)) {
    throw new Error("packageOrder must be the canonical dependency order")
  }

  return deepFreeze(manifest)
}

export function parseSealedReleaseManifest(raw, context) {
  assertManifestInputSize(raw, "sealed release manifest")
  let source
  if (typeof raw === "string") {
    source = raw
  } else if (raw instanceof Uint8Array) {
    try {
      source = UTF8_DECODER.decode(raw)
    } catch (error) {
      throw new TypeError("Invalid sealed release manifest JSON: bytes must be valid UTF-8", {
        cause: error,
      })
    }
  } else {
    throw new TypeError("Invalid sealed release manifest JSON: expected UTF-8 JSON bytes")
  }
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new TypeError(`Invalid sealed release manifest JSON: ${formatCause(error)}`, {
      cause: error,
    })
  }
  return validateSealedReleaseManifest(value, context)
}

export function validateSealedReleaseManifest(value, { candidate } = {}) {
  const manifest = snapshotManifest(value)
  validateManifestShape(manifest)
  if (
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate !== "object" ||
    manifest.version !== candidate.version ||
    manifest.commitSha !== candidate.commitSha
  ) {
    throw new Error("Sealed release manifest candidate identity does not match")
  }
  const inventoryNames = [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareNames)
  validatePackageOrder(manifest.packageOrder, inventoryNames)
  validatePackages(manifest.packages, {
    inventoryNames,
    packageOrder: manifest.packageOrder,
    version: manifest.version,
  })
  if (!arraysEqual(manifest.packageOrder, CANONICAL_RELEASE_PACKAGE_ORDER)) {
    throw new Error("packageOrder must match the sealed fixed-group-v1 dependency order")
  }
  return deepFreeze(manifest)
}

export function canonicalManifestBytes(manifest) {
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(manifest), null, 2)}\n`, "utf8")
  assertPayloadByteLength(bytes.length, RELEASE_PAYLOAD_LIMITS.manifestBytes, "Release manifest")
  return bytes
}

export function manifestSha256(manifest) {
  return createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex")
}

function snapshotManifest(value) {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError(`Release manifest snapshot failed: ${formatCause(error)}`, { cause: error })
  }
}

function validateManifestShape(manifest) {
  assertObject(manifest, "release manifest")
  assertExactFields(manifest, ROOT_FIELDS, "release manifest")
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${RELEASE_MANIFEST_SCHEMA_VERSION}`)
  }
  if (!isExactSemver(manifest.version)) {
    throw new Error("version must be an exact SemVer")
  }
  if (typeof manifest.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(manifest.commitSha)) {
    throw new Error("commitSha must be a 40-character lowercase hexadecimal SHA")
  }
  validateCi(manifest.ci)
  validateArtifact(manifest.artifact, {
    commitSha: manifest.commitSha,
    version: manifest.version,
  })
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

function validateArtifact(value, { commitSha, version }) {
  assertObject(value, "artifact")
  assertExactFields(value, ARTIFACT_FIELDS, "artifact")
  const expectedName = `release-v${version}-${commitSha.slice(0, 12)}`
  if (value.name !== expectedName) {
    throw new Error(`artifact.name must match candidate identity: ${expectedName}`)
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
  assertPreparedTarballPayload(packages)
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
    const entries = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("Manifest arrays must not be sparse")
      }
      entries.push(canonicalize(value[index], nextAncestors))
    }
    return entries
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

function assertManifestInputSize(raw, label) {
  if (typeof raw === "string") {
    assertPayloadByteLength(
      Buffer.byteLength(raw, "utf8"),
      RELEASE_PAYLOAD_LIMITS.manifestBytes,
      label,
    )
  } else if (raw instanceof Uint8Array) {
    assertPayloadByteLength(raw.byteLength, RELEASE_PAYLOAD_LIMITS.manifestBytes, label)
  }
}
