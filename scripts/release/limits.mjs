const MEBIBYTE = 1024 * 1024

const manifestBytes = 256 * 1024
const actionsExpandedBytes = 32 * MEBIBYTE

export const RELEASE_PAYLOAD_LIMITS = Object.freeze({
  actionsArchiveBytes: 40 * MEBIBYTE,
  actionsExpandedBytes,
  archiveFilenameBytes: 512,
  auditEvidenceBytes: 16 * MEBIBYTE,
  auditReceiptBytes: MEBIBYTE,
  attestationBundleBytes: 2 * MEBIBYTE,
  attestationBundlesBytes: 31 * MEBIBYTE,
  escrowBytes: 64 * MEBIBYTE,
  manifestBytes,
  packedManifestBytes: 1024 * 1024,
  preparedTarballsBytes: actionsExpandedBytes - manifestBytes,
  releaseRecordBytes: 16 * 1024,
  tarballBytes: 32 * MEBIBYTE,
  tarEntries: 16_384,
  tarExpandedBytes: 256 * MEBIBYTE,
  tarPathBytes: 4 * 1024,
  tarPaxHeaderBytes: 64 * 1024,
  zipEntries: 22,
  zipOverheadReserveBytes: 8 * MEBIBYTE,
})

if (
  RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes + RELEASE_PAYLOAD_LIMITS.zipOverheadReserveBytes !==
    RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes ||
  RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes + RELEASE_PAYLOAD_LIMITS.manifestBytes !==
    RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes ||
  RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes +
    RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes +
    RELEASE_PAYLOAD_LIMITS.releaseRecordBytes >=
    RELEASE_PAYLOAD_LIMITS.escrowBytes
) {
  throw new Error("Release payload limits do not preserve deterministic archive headroom")
}

export function assertPayloadByteLength(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} exceeds its ${maximum}-byte limit`)
  }
  return value
}

export function assertPreparedTarballPayload(entries) {
  let total = 0
  for (const entry of entries) {
    assertPayloadByteLength(
      entry.size,
      RELEASE_PAYLOAD_LIMITS.tarballBytes,
      `${entry.name} tarball`,
    )
    total += entry.size
    if (!Number.isSafeInteger(total) || total > RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes) {
      throw new Error("Cumulative prepared tarball payload exceeds its shared byte limit")
    }
  }
  return total
}
