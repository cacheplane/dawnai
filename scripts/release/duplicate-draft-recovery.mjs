import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u
const ASSET_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/u
const MARKER_DELIMITER = "DAWN_RELEASE_CONTROLLER_MARKER"
const MAX_NOTICE_BYTES = 16 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024

export const DUPLICATE_DRAFT_RECOVERY_POLICY = deepFreeze({
  repository: "cacheplane/dawnai",
  version: "0.8.22",
  candidateSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
  canonicalReleaseId: 379991871,
  duplicates: [
    { releaseId: 379982100, tagName: "untagged-a13939767dd2419ade01" },
    { releaseId: 379986168, tagName: "untagged-20706099efa3c38335a8" },
  ],
})

export function classifyDuplicateDraft(value, expected) {
  const snapshot = exactObject(
    value,
    ["releaseId", "tagName", "body", "marker", "assets", "evidenceAssets"],
    "duplicate Release snapshot",
  )
  const requirements = exactObject(
    expected,
    [
      "releaseId",
      "tagName",
      "canonicalBody",
      "canonicalMarker",
      "originalBodySha256",
      "originalAssets",
      "recoveryReceipt",
      "recoveryNotice",
    ],
    "duplicate Release expectations",
  )

  assertDuplicateIdentity(snapshot.releaseId, snapshot.tagName, requirements)
  assertBodyDigest(requirements.canonicalBody, requirements.originalBodySha256)
  if (!Array.isArray(requirements.originalAssets) || requirements.originalAssets.length !== 45) {
    throw new TypeError("Duplicate Release expectations require exactly 45 original assets")
  }
  const originalAssets = normalizeAssets(
    requirements.originalAssets,
    "original Release assets",
    false,
  )
  const assets = normalizeAssets(snapshot.assets, "duplicate Release assets", true)
  const evidenceKinds = normalizeEvidenceKinds(snapshot.evidenceAssets)
  const bodyAssetName = originalBodyAssetName(
    requirements.releaseId,
    requirements.originalBodySha256,
  )
  const receiptAssetName = recoveryReceiptAssetName(requirements.releaseId)
  const recoveryReceiptBytes = canonicalRecoveryReceipt(requirements.recoveryReceipt)
  const recoveryReceiptSha256 = sha256Bytes(recoveryReceiptBytes)
  const expectedAssetNames = new Set(originalAssets.map((asset) => asset.name))
  for (const asset of assets) {
    if (
      !expectedAssetNames.has(asset.name) &&
      asset.name !== bodyAssetName &&
      asset.name !== receiptAssetName
    ) {
      throw new Error("Duplicate Release has an unexpected asset")
    }
  }
  if (assets.length !== originalAssets.length + evidenceKinds.length) {
    throw new Error("Duplicate Release asset namespace is not exact")
  }
  const originalActual = assets.slice(0, originalAssets.length)
  if (!sameJson(originalActual, originalAssets)) {
    throw new Error("Duplicate Release original asset namespace changed")
  }
  const evidence = assets.slice(originalAssets.length)
  const notice =
    evidenceKinds.length === 2 && snapshot.marker === null
      ? parseCanonicalNotice(snapshot.body, requirements.releaseId)
      : null
  for (const [index, asset] of evidence.entries()) {
    const kind = evidenceKinds[index]
    if (kind === "body") {
      if (asset.name !== bodyAssetName || asset.sha256 !== requirements.originalBodySha256) {
        throw new Error("Duplicate Release original-body archive is not exact")
      }
    } else if (
      asset.name !== receiptAssetName ||
      asset.sha256 !== recoveryReceiptSha256 ||
      typeof asset.bytes !== "string" ||
      asset.bytes !== recoveryReceiptBytes.toString("utf8") ||
      (notice !== null && asset.sha256 !== notice.receiptSha256)
    ) {
      throw new Error("Duplicate Release recovery receipt asset is not exact")
    }
  }

  const canonicalMarker = requirements.canonicalMarker
  if (!isRecord(canonicalMarker) || !sameJson(snapshot.marker, canonicalMarker)) {
    if (evidenceKinds.length === 2 && snapshot.marker === null) {
      // The quarantine state intentionally has no live Dawn marker.
    } else {
      throw new Error("Duplicate Release marker is not canonical")
    }
  }
  if (evidenceKinds.length === 2 && snapshot.marker === null) {
    if (snapshot.body !== requirements.recoveryNotice || !isCanonicalNotice(snapshot.body)) {
      throw new Error("Duplicate Release recovery notice is malformed")
    }
    return "quarantined"
  }
  if (snapshot.body !== requirements.canonicalBody) {
    throw new Error("Duplicate Release original body changed")
  }
  if (evidenceKinds.length === 0) return "untouched"
  if (evidenceKinds.length === 1 && evidenceKinds[0] === "body") return "body-archived"
  if (evidenceKinds.length === 2 && evidenceKinds[0] === "body" && evidenceKinds[1] === "receipt") {
    return "receipt-archived"
  }
  throw new Error("Duplicate Release state is unknown")
}

export function originalBodyAssetName(releaseId, bodySha256) {
  assertDuplicateReleaseId(releaseId)
  assertSha256(bodySha256, "Original body SHA-256")
  return `dawn-v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}-duplicate-${releaseId}-original-body-${bodySha256}.txt`
}

export function recoveryReceiptAssetName(releaseId) {
  assertDuplicateReleaseId(releaseId)
  return `dawn-v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}-duplicate-${releaseId}-recovery-receipt.json`
}

export function canonicalRecoveryReceipt(input) {
  const source = exactObject(
    input,
    [
      "repository",
      "version",
      "candidateSha",
      "recoveryCommit",
      "canonicalReleaseId",
      "duplicateReleaseId",
      "originalBodySha256",
      "baseAssetSetSha256",
      "archiveAsset",
    ],
    "recovery receipt",
  )
  assertPolicyIdentity(source)
  assertGitSha(source.recoveryCommit, "Recovery commit")
  assertReleaseId(source.canonicalReleaseId, "Canonical Release ID")
  if (source.canonicalReleaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId) {
    throw new Error("Recovery receipt canonical Release ID is not approved")
  }
  assertDuplicateReleaseId(source.duplicateReleaseId)
  assertSha256(source.originalBodySha256, "Original body SHA-256")
  assertSha256(source.baseAssetSetSha256, "Base asset set SHA-256")
  const archiveAsset = exactObject(source.archiveAsset, ["name", "sha256"], "archive asset")
  if (
    archiveAsset.name !==
      originalBodyAssetName(source.duplicateReleaseId, source.originalBodySha256) ||
    archiveAsset.sha256 !== source.originalBodySha256
  ) {
    throw new Error("Recovery receipt archive asset is not derived from the candidate")
  }
  const record = {
    schemaVersion: 1,
    repository: source.repository,
    version: source.version,
    candidateSha: source.candidateSha,
    recoveryCommit: source.recoveryCommit,
    canonicalReleaseId: source.canonicalReleaseId,
    duplicateReleaseId: source.duplicateReleaseId,
    originalBodySha256: source.originalBodySha256,
    baseAssetSetSha256: source.baseAssetSetSha256,
    archiveAsset,
  }
  const bytes = Buffer.from(`${JSON.stringify(canonicalize(record))}\n`, "utf8")
  if (bytes.byteLength > MAX_RECEIPT_BYTES)
    throw new Error("Recovery receipt exceeds its byte limit")
  return bytes
}

export function canonicalRecoveryNotice(input) {
  const source = exactObject(
    input,
    [
      "repository",
      "version",
      "canonicalReleaseId",
      "duplicateReleaseId",
      "originalBodySha256",
      "archiveAssetName",
      "receiptAssetName",
      "receiptSha256",
    ],
    "recovery notice",
  )
  if (source.repository !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository) {
    throw new Error("Recovery notice repository is not approved")
  }
  if (source.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version) {
    throw new Error("Recovery notice version is not approved")
  }
  assertReleaseId(source.canonicalReleaseId, "Canonical Release ID")
  if (source.canonicalReleaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId) {
    throw new Error("Recovery notice canonical Release ID is not approved")
  }
  assertDuplicateReleaseId(source.duplicateReleaseId)
  assertSha256(source.originalBodySha256, "Original body SHA-256")
  if (
    source.archiveAssetName !==
    originalBodyAssetName(source.duplicateReleaseId, source.originalBodySha256)
  ) {
    throw new Error("Recovery notice archive asset is not derived from the candidate")
  }
  if (source.receiptAssetName !== recoveryReceiptAssetName(source.duplicateReleaseId)) {
    throw new Error("Recovery notice receipt asset is not derived from the candidate")
  }
  assertSha256(source.receiptSha256, "Recovery receipt SHA-256")
  const notice = {
    schemaVersion: 1,
    type: "DAWN_DUPLICATE_DRAFT_RECOVERY",
    repository: source.repository,
    version: source.version,
    candidateSha: DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha,
    canonicalReleaseId: source.canonicalReleaseId,
    duplicateReleaseId: source.duplicateReleaseId,
    originalBodySha256: source.originalBodySha256,
    archiveAssetName: source.archiveAssetName,
    receiptAssetName: source.receiptAssetName,
    receiptSha256: source.receiptSha256,
  }
  const text = `${JSON.stringify(canonicalize(notice))}\n`
  if (text.includes(MARKER_DELIMITER)) throw new Error("Recovery notice contains a Dawn marker")
  if (Buffer.byteLength(text, "utf8") > MAX_NOTICE_BYTES) {
    throw new Error("Recovery notice exceeds its byte limit")
  }
  return text
}

function assertPolicyIdentity(source) {
  if (
    source.repository !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    source.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    source.candidateSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha
  ) {
    throw new Error("Recovery receipt candidate identity is not approved")
  }
}

function assertDuplicateIdentity(releaseId, tagName, expected) {
  assertDuplicateReleaseId(releaseId)
  const configured = DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.find(
    (duplicate) => duplicate.releaseId === releaseId,
  )
  if (
    configured === undefined ||
    releaseId !== expected.releaseId ||
    tagName !== expected.tagName ||
    tagName !== configured.tagName
  ) {
    throw new Error("Duplicate Release identity is not exact")
  }
  if (tagName === `v${DUPLICATE_DRAFT_RECOVERY_POLICY.version}`) {
    throw new Error("Duplicate Release must retain its opaque temporary tag")
  }
}

function assertDuplicateReleaseId(value) {
  assertReleaseId(value, "Duplicate Release ID")
  if (!DUPLICATE_DRAFT_RECOVERY_POLICY.duplicates.some((item) => item.releaseId === value)) {
    throw new Error("Release ID is not an approved duplicate")
  }
}

function assertReleaseId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`)
}

function assertGitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase Git SHA-1`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertBodyDigest(body, expectedDigest) {
  if (typeof body !== "string") throw new TypeError("Canonical duplicate body is invalid")
  assertSha256(expectedDigest, "Original body SHA-256")
  if (sha256(body) !== expectedDigest)
    throw new Error("Canonical duplicate body digest is not exact")
}

function normalizeEvidenceKinds(value) {
  if (!Array.isArray(value) || value.length > 2)
    throw new TypeError("Duplicate evidence asset list is invalid")
  const result = value.map((kind) => {
    if (kind !== "body" && kind !== "receipt") throw new Error("Unknown duplicate evidence asset")
    return kind
  })
  if (new Set(result).size !== result.length)
    throw new Error("Duplicate evidence asset list contains duplicates")
  if (result.includes("receipt") && !result.includes("body")) {
    throw new Error("Recovery receipt cannot exist without the original-body archive")
  }
  return result
}

function normalizeAssets(value, label, allowBytes) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value.map((asset, index) => {
    const source = snapshotJson(asset)
    const normalized = exactObject(
      source,
      allowBytes && Object.hasOwn(source, "bytes")
        ? ["id", "name", "sha256", "bytes"]
        : ["id", "name", "sha256"],
      `${label}[${index}]`,
    )
    assertReleaseId(normalized.id, `${label}[${index}] id`)
    if (typeof normalized.name !== "string" || !ASSET_NAME_PATTERN.test(normalized.name)) {
      throw new TypeError(`${label}[${index}] name is invalid`)
    }
    assertSha256(normalized.sha256, `${label}[${index}] SHA-256`)
    if (Object.hasOwn(normalized, "bytes") && typeof normalized.bytes !== "string") {
      throw new TypeError(`${label}[${index}] bytes are invalid`)
    }
    return normalized
  })
}

function exactObject(value, fields, label) {
  const source = snapshotJson(value)
  if (!isRecord(source)) throw new TypeError(`${label} must be an object`)
  const actual = Object.keys(source).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains unexpected or missing fields`)
  }
  return source
}

function isCanonicalNotice(value) {
  if (typeof value !== "string" || !value.endsWith("\n") || value.includes(MARKER_DELIMITER))
    return false
  try {
    const parsed = JSON.parse(value)
    return `${JSON.stringify(canonicalize(parsed))}\n` === value
  } catch {
    return false
  }
}

function parseCanonicalNotice(value, expectedDuplicateReleaseId) {
  if (!isCanonicalNotice(value)) throw new Error("Duplicate Release recovery notice is malformed")
  const notice = snapshotJson(JSON.parse(value))
  if (
    !isRecord(notice) ||
    Object.keys(notice).sort().join(",") !==
      [
        "archiveAssetName",
        "candidateSha",
        "canonicalReleaseId",
        "duplicateReleaseId",
        "originalBodySha256",
        "receiptAssetName",
        "receiptSha256",
        "repository",
        "schemaVersion",
        "type",
        "version",
      ]
        .sort()
        .join(",") ||
    notice.repository !== DUPLICATE_DRAFT_RECOVERY_POLICY.repository ||
    notice.version !== DUPLICATE_DRAFT_RECOVERY_POLICY.version ||
    notice.candidateSha !== DUPLICATE_DRAFT_RECOVERY_POLICY.candidateSha ||
    notice.canonicalReleaseId !== DUPLICATE_DRAFT_RECOVERY_POLICY.canonicalReleaseId ||
    notice.duplicateReleaseId !== expectedDuplicateReleaseId ||
    notice.archiveAssetName !==
      originalBodyAssetName(notice.duplicateReleaseId, notice.originalBodySha256) ||
    notice.receiptAssetName !== recoveryReceiptAssetName(notice.duplicateReleaseId) ||
    notice.schemaVersion !== 1 ||
    notice.type !== "DAWN_DUPLICATE_DRAFT_RECOVERY"
  ) {
    throw new Error("Duplicate Release recovery notice identity is not exact")
  }
  assertSha256(notice.originalBodySha256, "Recovery notice original body SHA-256")
  assertSha256(notice.receiptSha256, "Recovery notice receipt SHA-256")
  return notice
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex")
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
