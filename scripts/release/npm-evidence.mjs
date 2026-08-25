import { snapshotJson } from "./adapter-normalize.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  manifestSha256 as releaseManifestSha256,
  validateSealedReleaseManifest,
} from "./manifest.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

const ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "version",
  "commitSha",
  "manifestSha256",
  "complete",
  "status",
  "packages",
])
const PACKAGE_FIELDS = Object.freeze([
  "name",
  "version",
  "status",
  "size",
  "tarballSha256",
  "tarballSha512",
  "integrity",
  "latest",
  "signature",
  "provenance",
])
const LATEST_FIELDS = Object.freeze(["status", "version"])
const SIGNATURE_FIELDS = Object.freeze(["status", "verifier"])
const PROVENANCE_FIELDS = Object.freeze([
  "predicateType",
  "workflow",
  "commitSha",
  "repository",
  "ref",
])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SHA512_PATTERN = /^[0-9a-f]{128}$/u
const EXPECTED_REPOSITORY = "https://github.com/cacheplane/dawnai"
const EXPECTED_PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export const NPM_EVIDENCE_MAX_BYTES = 1024 * 1024

export function parseNpmEvidence(raw, context) {
  const value = parseEvidenceInput(raw)
  const candidate = snapshotJson(context?.candidate)
  const expectedManifestSha256 = context?.manifestSha256
  if (
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate !== "object" ||
    !isReleaseVersion(candidate.version) ||
    !SHA_PATTERN.test(candidate.commitSha) ||
    typeof candidate.publisherWorkflow !== "string" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml" ||
    !SHA256_PATTERN.test(expectedManifestSha256)
  ) {
    throw new TypeError("npm evidence validation context is invalid")
  }

  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
  if (bytes < 1 || bytes > NPM_EVIDENCE_MAX_BYTES) {
    throw new TypeError("npm evidence exceeds its byte limit")
  }
  assertExactFields(value, ROOT_FIELDS, "npm evidence")
  if (
    value.schemaVersion !== 1 ||
    value.version !== candidate.version ||
    value.commitSha !== candidate.commitSha ||
    value.manifestSha256 !== expectedManifestSha256 ||
    value.complete !== true ||
    value.status !== "NPM_COMPLETE" ||
    !Array.isArray(value.packages) ||
    value.packages.length !== CANONICAL_RELEASE_PACKAGE_ORDER.length
  ) {
    throw new TypeError("npm evidence is not an exact complete candidate receipt")
  }

  let manifest = null
  if (context.manifest !== undefined) {
    manifest = validateSealedReleaseManifest(context.manifest, { candidate })
    if (releaseManifestSha256(manifest) !== expectedManifestSha256) {
      throw new TypeError("npm evidence manifest digest does not match its validation context")
    }
  }

  for (let index = 0; index < CANONICAL_RELEASE_PACKAGE_ORDER.length; index += 1) {
    const evidence = value.packages[index]
    const expectedName = CANONICAL_RELEASE_PACKAGE_ORDER[index]
    validatePackageEvidence(evidence, {
      candidate,
      expectedName,
      manifestEntry: manifest?.packages[index],
    })
  }
  return deepFreeze(value)
}

export function canonicalNpmEvidenceBytes(value, context) {
  const evidence = parseNpmEvidence(value, context)
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(evidence), null, 2)}\n`, "utf8")
  if (bytes.length > NPM_EVIDENCE_MAX_BYTES) {
    throw new TypeError("Canonical npm evidence exceeds its byte limit")
  }
  return bytes
}

function parseEvidenceInput(raw) {
  if (raw instanceof Uint8Array || typeof raw === "string") {
    const inputBytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw)
    if (inputBytes.length < 1 || inputBytes.length > NPM_EVIDENCE_MAX_BYTES) {
      throw new TypeError("npm evidence exceeds its byte limit")
    }
    let source
    try {
      source = UTF8_DECODER.decode(inputBytes)
    } catch (error) {
      throw new TypeError("npm evidence bytes are not valid UTF-8", { cause: error })
    }
    try {
      return snapshotJson(JSON.parse(source))
    } catch (error) {
      throw new TypeError("npm evidence JSON is invalid", { cause: error })
    }
  }
  try {
    return snapshotJson(raw)
  } catch (error) {
    throw new TypeError("npm evidence contains an invalid JSON field", { cause: error })
  }
}

function validatePackageEvidence(evidence, { candidate, expectedName, manifestEntry }) {
  assertExactFields(evidence, PACKAGE_FIELDS, `npm evidence package ${expectedName}`)
  if (
    evidence.name !== expectedName ||
    evidence.version !== candidate.version ||
    evidence.status !== "present" ||
    !Number.isSafeInteger(evidence.size) ||
    evidence.size < 1 ||
    evidence.size > RELEASE_PAYLOAD_LIMITS.tarballBytes ||
    !SHA256_PATTERN.test(evidence.tarballSha256) ||
    !SHA512_PATTERN.test(evidence.tarballSha512) ||
    evidence.integrity !== sha512Integrity(evidence.tarballSha512)
  ) {
    throw new TypeError(`npm evidence package ${expectedName} identity is invalid`)
  }
  assertExactFields(evidence.latest, LATEST_FIELDS, `npm evidence latest ${expectedName}`)
  if (evidence.latest.status !== "present" || evidence.latest.version !== candidate.version) {
    throw new TypeError(`npm evidence latest ${expectedName} is invalid`)
  }
  assertExactFields(evidence.signature, SIGNATURE_FIELDS, `npm evidence signature ${expectedName}`)
  if (
    evidence.signature.status !== "valid" ||
    evidence.signature.verifier !== "npm-audit-signatures@11"
  ) {
    throw new TypeError(`npm evidence signature ${expectedName} is invalid`)
  }
  assertExactFields(
    evidence.provenance,
    PROVENANCE_FIELDS,
    `npm evidence provenance ${expectedName}`,
  )
  if (
    evidence.provenance.predicateType !== EXPECTED_PREDICATE_TYPE ||
    evidence.provenance.workflow !== candidate.publisherWorkflow ||
    evidence.provenance.commitSha !== candidate.commitSha ||
    evidence.provenance.repository !== EXPECTED_REPOSITORY ||
    evidence.provenance.ref !== `refs/tags/v${candidate.version}`
  ) {
    throw new TypeError(`npm evidence provenance ${expectedName} is invalid`)
  }
  if (
    manifestEntry !== undefined &&
    (manifestEntry.name !== evidence.name ||
      manifestEntry.version !== evidence.version ||
      manifestEntry.size !== evidence.size ||
      manifestEntry.sha256 !== evidence.tarballSha256 ||
      manifestEntry.sha512 !== evidence.tarballSha512 ||
      manifestEntry.npmIntegrity !== evidence.integrity)
  ) {
    throw new TypeError(`npm evidence package ${expectedName} conflicts with the manifest`)
  }
}

function assertExactFields(value, fields, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an exact object`)
  }
  const keys = Object.keys(value)
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError(`${label} contains missing or unknown fields`)
  }
}

function sha512Integrity(sha512) {
  return `sha512-${Buffer.from(sha512, "hex").toString("base64")}`
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
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
